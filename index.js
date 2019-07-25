const fs = require('fs-extra')
const path = require('path')
const replaceStream = require('replacestream')

const {
  FileBlob,
  FileFsRef,
  getWriteableDirectory,
} = require('@now/build-utils')
const { build, prepareCache, config, shouldServe } = require('@now/node')

module.exports = {
  build: async ({ files, entrypoint, workPath, ...rest }) => {
    // const updatedFiles = { ...files }
    // console.log(`adding paywall dependencies to package.json...`)
    // let pkg = { dependencies: {} }
    // if (files['package.json']) {
    //   const stream = files['package.json'].toStream()
    //   const { data } = await FileBlob.fromStream({ stream })
    //   pkg = JSON.parse(data.toString())
    // }

    // const json = JSON.parse(
    //   await fs.readFile(path.join(__dirname, 'server/package.json'), 'utf8')
    // )
    // Object.keys(json.dependencies).forEach(dep => {
    //   pkg.dependencies[dep] = json.dependencies[dep]
    // })
    // // updatedFiles['package.json'] = new FileBlob({ data: JSON.stringify(pkg) })
    // fs.writeFileSync(
    //   path.join(workPath, 'package.json'),
    //   JSON.stringify(pkg, null, 2)
    // )
    // console.log(`setting paywall entrypoint...`)
    // updatedFiles['_entrypoint.js'] = files[entrypoint]

    // // get data from our server entrypoint at server/app.js by getting a read stream
    // // pipe the stream to a function that will replace the any imports of _entrypoint to
    // // the absolute path to the user defined entrypoint
    // const stream = fs
    //   .createReadStream(path.join(__dirname, 'server/app.js'))
    //   .pipe(replaceStream('_entrypoint', entrypoint))

    // // create a fileFsRef from the stream, w/ fsPath in the lambda's workPath
    // // this in effect puts our custom entry point in the directory of the user created entry
    // // which allows the builder's entrypoint to import the user's entrypoint
    // const updatedEntrypoint = await FileFsRef.fromStream({
    //   stream,
    //   fsPath: path.join(workPath, 'app.js'),
    // })

    // // set entrypoint to new file ref
    // // Must be after user's entrypoint has been moved to _entrypoint reference
    // updatedFiles[entrypoint] = updatedEntrypoint

    // console.log('and now back to your regularly scheduled @now/node builder')
    // return build({ entrypoint, files: updatedFiles, workPath, ...rest })

    // v2
    // get a writeable directory, a tmp directory for storing our filesystem in
    const tmpDir = await getWriteableDirectory()
    // create a new map for files that will point to files in the tmp directory
    const tmpFiles = { ...files }
    const entryDir = path.join(tmpDir, 'entry')
    // symlink the workPath directory (i.e. where the entrypoint is) to the tmp dir
    fs.symlinkSync(workPath, entryDir)

    // merge the package.jsons and add to the tmp directory
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

    fs.writeFileSync(
      path.join(tmpDir, 'package.json'),
      JSON.stringify(pkg, null, 2)
    )

    // save reference to new package.json in the tmpFiles map that will be passed to build
    tmpFiles['package.json'] = new FileFsRef({
      fsPath: path.join(tmpDir, 'package.json'),
    })

    // update `fsPath`s in new files object to point to symlinked files in tmpdir
    for (let file in tmpFiles) {
      tmpFiles[file].fsPath = path.join(tmpDir, file)
    }

    // move app.js into tmp dir and update import to point to user's entrypoint

    // get data from our server entrypoint at server/app.js by getting a read stream
    // pipe the stream to a function that will replace the any imports of _entrypoint to
    // the absolute path to the user defined entrypoint
    const stream = fs
      .createReadStream(path.join(__dirname, 'server/app.js'))
      // make an explicit reference to user's entrypoint
      .pipe(replaceStream('./_entrypoint', path.join(entryDir, entrypoint)))

    // create a fileFsRef from the stream, w/ fsPath in the lambda's workPath
    // this in effect puts our custom entry point in the directory of the user created entry
    // which allows the builder's entrypoint to import the user's entrypoint
    const updatedEntrypoint = await FileFsRef.fromStream({
      stream,
      fsPath: path.join(tmpDir, 'app.js'),
    })

    // add reference for the previous entrypoint
    tmpFiles['_entrypoint.js'] = files[entrypoint]

    // set entrypoint to new file ref
    // Must be after user's entrypoint has been moved to _entrypoint reference
    tmpFiles[entrypoint] = updatedEntrypoint

    // return a build using the tmp directory, tmp files, and workPath set to tmpDir
    return build({ entrypoint, files: tmpFiles, workPath: tmpDir, ...rest })
  },
  prepareCache,
  config,
  version: 2,
  shouldServe,
}
