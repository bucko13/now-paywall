/**
 * IMPORTANT: This is a file created by the now-paywall builder.
 * The builder will make this file as the entrypoint and import the
 * user defined one as the `protectedRoute`
 */

const express = require('express')
const cors = require('cors')
var bodyParser = require('body-parser')
const MacaroonsBuilder = require('macaroons.js').MacaroonsBuilder
const lnService = require('ln-service')

let protectedRoute = require('./_entrypoint')

const router = express.Router()

const app = express()

// middleware
app.use(cors())
// parse application/x-www-form-urlencoded
app.use(bodyParser.urlencoded({ extended: false }))
// parse application/json
app.use(bodyParser.json())

app.use('*', async (req, res, next) => {
  try {
    testEnvVars()
    const { OPEN_NODE_KEY, LN_CERT, LN_MACAROON, LN_SOCKET } = process.env
    // if the tests pass above and we don't have a
    // OPEN_NODE_KEY then we need to setup the lnd service
    if (!OPEN_NODE_KEY) {
      const { lnd } = lnService.authenticatedLndGrpc({
        cert: LN_CERT,
        macaroon: LN_MACAROON,
        socket: LN_SOCKET,
      })
      req.lnd = lnd
    } else {
      const env = process.env.ENVIRONMENT || 'dev'
      const opennode = require('opennode')
      opennode.setCredentials(OPEN_NODE_KEY, env)
      req.opennode = opennode
      console.log('req.opennode:', req.opennode)
    }
    next()
  } catch (e) {
    console.error(
      'Problem with configs for connecting to lightning node:',
      e.message
    )
    next("Could not connect to the paywall's lightning node.")
  }
})

app.post('*/invoice', async (req, res, next) => {
  console.log('req.body:', req.body)
  let { time, title, expiresAt, appName } = req.body // time in seconds

  if (!appName) appName = `[unknown application @ ${req.ip}]`

  if (!title) title = '[unknown data]'

  try {
    console.log('creating invoice')
    const description = `Access for ${time} seconds in ${appName} for requested data: ${title}`
    const amount = time
    let invoice
    if (req.lnd) {
      const _invoice = await lnService.createInvoice({
        lnd: req.lnd,
        description,
        expires_at: expiresAt,
        tokens: amount,
      })
      invoice.payreq = _invoice.request
      invoice.id = _invoice.id
      invoice.description = _invoice.description
      invoice.createdAt = _invoice.created_at
      invoice.amount = _invoice.tokens
    } else if (req.opennode) {
      const _invoice = await req.opennode.createCharge({
        description,
        amount,
        auto_settle: false,
      })
      invoice.payreq = _invoice.lightning_invoice.payreq
      invoice.id = _invoice.id
      invoice.description = _invoice.description
      invoice.createdAt = _invoice.created_at
      invoice.amount = _invoice.amount
    } else {
      return next('No lightning node information configured on request object')
    }

    res.status(200).json(invoice)
  } catch (error) {
    console.error('error getting invoice:', error)
    res.status(400).json({ message: error.message })
  }
})

app.get('*/invoice', async (req, res, next) => {
  const { id: invoiceId } = req.query

  if (!invoiceId)
    return res.status(400).json({ message: 'Missing invoiceId in request' })

  try {
    console.log('checking for invoiceId:', invoiceId)
    let status, amount, invoice
    if (req.lnd) {
      const invoiceDetails = await lnService.getInvoice({
        id: invoiceId,
        lnd: req.lnd,
      })
      status = invoiceDetails['is_confirmed'] ? 'paid' : 'unpaid'
      amount = invoiceDetails.tokens
      invoice = invoiceDetails.request
    } else if (req.opennode) {
      const data = await req.opennode.chargeInfo(invoiceId)
      amount = data.amount
      status = data.status
      invoice = data['lightning_invoice'].payreq
    } else {
      return next('No lightning node information configured on request object')
    }

    // amount is in satoshis which is equal to the amount of seconds paid for
    const milli = amount * 1000
    if (status === 'paid') {
      // check if there is a caveat key before proceeding
      if (!process.env.CAVEAT_KEY)
        throw new Error(
          'Service is missing caveat key for signing discharge macaroon. Contact node admin.'
        )

      // create discharge macaroon
      const location =
        req.headers['x-forwarded-proto'] +
        '://' +
        req.headers['x-now-deployment-url']

      // add 200 milliseconds of "free time" as a buffer
      const time = new Date(Date.now() + milli + 200)

      // Now that we've confirmed invoice is paid, create the discharge macaroon
      const macaroon = new MacaroonsBuilder(
        location,
        process.env.CAVEAT_KEY, // this should be randomly generated, w/ enough entropy and of length > 32 bytes
        invoiceId
      )
        .add_first_party_caveat(`time < ${time}`)
        .getMacaroon()

      console.log(
        `Invoice ${invoiceId} has been paid and is valid until ${time}`
      )

      return res.status(200).json({ status, discharge: macaroon.serialize() })
    } else if (status === 'processing' || status === 'unpaid') {
      console.log('still processing invoice %s...', invoiceId)
      return res.status(202).json({ status, invoice })
    } else {
      return res
        .status(400)
        .json({ message: `unknown invoice status ${status}` })
    }
  } catch (error) {
    console.error('error getting invoice:', error)
    res.status(400).json({ message: error.message })
  }
})

app.get('*/node', async (req, res) => {
  if (req.lnd) {
    const { public_key, alias } = await lnService.getWalletInfo({
      lnd: req.lnd,
    })
    return res.status(200).json({
      pubKey: public_key,
      alias,
    })
  } else if (req.opennode)
    // this is a kind of stand-in, a best guess at what the pubkey for the opennode
    // node is. Probably need to change this or find another way to get better
    // connected with the paywall's node. Also need to differentiate between main and testnet
    return res.status(200).json({
      identityPubkey:
        '02eadbd9e7557375161df8b646776a547c5cbc2e95b3071ec81553f8ec2cea3b8c@18.191.253.246:9735',
    })
  else
    return res
      .status(404)
      .json({ message: 'No public key information found for node' })
})

router.use(protectedRoute)

app.use('*/protected', (req, res, next) => {
  console.log('Checking if the request requires payment...')
  // if there is no macaroon at all
  // then we need to request a new invoice
  // create a root macaroon with the associated id
  // and send back macaroon and invoice info back in response
  // TODO: Do we want to separate the 402 response step from the invoice post step?

  // if there is a macaroon but has not been fully validated
  // (i.e. the invoice isn't paid and/or 3rd party caveat hasn't been discharged)
  // run the check from `GET /invoice`
  // if invoice is paid, add the discharge macaroon to the request/cookie
  // and pass on to `next()`

  // TODO: Remove the below once authentication steps are added
  if (req.query.paid) next()
  else return res.status(402).json({ message: 'Payment required!' })
})

app.use('*/protected', router)

/****
 **** Helper functions
 **** builder only supports single import atm
 **** so these all needs to be co-located in the entrypoint
 ****/

/*
 * A utility function for testing our environment variables
 * to see if we can either create a connection with a self-hosted node
 * or use an OpenNode key. This will prioritize node configs over OpenNode
 */
function testEnvVars() {
  const { OPEN_NODE_KEY, LN_CERT, LN_MACAROON, LN_SOCKET } = process.env

  const lndConfigs = [LN_CERT, LN_MACAROON, LN_SOCKET]

  // if we have all lndConfigs then return true

  if (lndConfigs.every(config => config !== undefined)) return true

  // if we have no lnd configs but an OPEN_NODE_KEY then return true
  if (lndConfigs.every(config => config === undefined) && OPEN_NODE_KEY)
    return true

  // if we have some lnd configs but not all, throw that we're missing some
  if (lndConfigs.some(config => config === undefined))
    throw new Error(
      'Missing configs to connect to LND node. Need macaroon, socket, and tls cert.'
    )

  // otherwise we have no lnd configs and no OPEN_NODE_KEY
  // throw that there are no ln configs
  throw new Error(
    'No configs set in environment to connect to a lightning node. \
See README for instructions: https://github.com/bucko13/now-paywall'
  )
}
module.exports = app
