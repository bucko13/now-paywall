const fs = require('fs-extra')
const path = require('path')
const replaceStream = require('replacestream')

const { FileBlob, FileFsRef } = require('@now/build-utils')
const { build, prepareCache, config, shouldServe } = require('@now/node')

module.exports = {
  build: async ({ files, entrypoint, workPath, ...rest }) => {
    const updatedFiles = { ...files }
    console.log(`adding paywall dependencies to package.json...`)
    let pkg = { dependencies: {} }
    if (files['package.json']) {
      const stream = files['package.json'].toStream()
      const { data } = await FileBlob.fromStream({ stream })
      pkg = JSON.parse(data.toString())
    }

    const json = JSON.parse(
      await fs.readFile(path.join(__dirname, 'server/package.json'), 'utf8')
    )
    Object.keys(json.dependencies).forEach(dep => {
      pkg.dependencies[dep] = json.dependencies[dep]
    })
    updatedFiles['package.json'] = new FileBlob({ data: JSON.stringify(pkg) })

    console.log(`setting paywall entrypoint...`)
    updatedFiles['_entrypoint.js'] = files[entrypoint]

    // get data from our server entrypoint at server/app.js by getting a read stream
    // pipe the stream to a function that will replace the any imports of _entrypoint to
    // the absolute path to the user defined entrypoint
    const stream = fs
      .createReadStream(path.join(__dirname, 'server/app.js'))
      .pipe(replaceStream('_entrypoint', entrypoint))

    // create a fileFsRef from the stream, w/ fsPath in the lambda's workPath
    // this in effect puts our custom entry point in the directory of the user created entry
    // which allows the builder's entrypoint to import the user's entrypoint
    const updatedEntrypoint = await FileFsRef.fromStream({
      stream,
      fsPath: path.join(workPath, 'app.js'),
    })

    // set entrypoint to new file ref
    // Must be after user's entrypoint has been moved to _entrypoint reference
    updatedFiles[entrypoint] = updatedEntrypoint

    console.log('and now back to your regularly scheduled @now/node builder')
    return build({ entrypoint, files: updatedFiles, workPath, ...rest })
  },
  prepareCache,
  config,
  version: 2,
  shouldServe,
}
