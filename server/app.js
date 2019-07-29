/**
 * IMPORTANT: This is a file created by the now-paywall builder.
 * The builder will make this file as the entrypoint and import the
 * user defined one as the `protectedRoute`
 */

const express = require('express')
const cors = require('cors')
var bodyParser = require('body-parser')
const {
  MacaroonsBuilder,
  MacaroonsVerifier,
  verifier,
} = require('macaroons.js')
const lnService = require('ln-service')
const cookieSession = require('cookie-session')

let protectedRoute = require('./_entrypoint')

const router = express.Router()

const app = express()

// middleware
app.use(cors())
// parse application/x-www-form-urlencoded
app.use(bodyParser.urlencoded({ extended: false }))
// parse application/json
app.use(bodyParser.json())

// a session cookie to store request macaroons in
app.use(
  cookieSession({
    name: 'macaroon',
    maxAge: 86400000,
    secret: process.env.SESSION_SECRET || 'i_am_satoshi_08',
    overwrite: false,
    signed: true,
  })
)

// separate cookie for the discharge macaroon
app.use(
  cookieSession({
    name: 'dischargeMacaroon',
    maxAge: 86400000,
    secret: process.env.SESSION_SECRET || 'i_am_satoshi_08',
    overwrite: false,
    signed: true,
  })
)

app.use('*', async (req, res, next) => {
  console.log('req.session.macaroon:', req.session.macaroon)
  console.log('req.session.dischargeMacaroon:', req.session.dischargeMacaroon)
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

app.post('*/invoice', async (req, res) => {
  try {
    const invoice = await createInvoice(req)
    res.status(200).json(invoice)
  } catch (error) {
    console.error('error getting invoice:', error)
    res.status(400).json({ message: error.message })
  }
})

app.get('*/invoice', async (req, res) => {
  const { id: invoiceId } = req.query

  if (!invoiceId)
    return res.status(400).json({ message: 'Missing invoiceId in request' })

  try {
    console.log('checking for invoiceId:', invoiceId)
    const { status, amount, payreq } = await checkInvoiceStatus(req)

    if (status === 'paid') {
      // amount is in satoshis which is equal to the amount of seconds paid for
      const milli = amount * 1000
      // add 200 milliseconds of "free time" as a buffer
      const time = new Date(Date.now() + milli + 200)
      const caveat = `time < ${time}`

      const macaroon = getDischargeMacaroon(req, caveat)

      // save discharge macaroon in a cookie. Request should have two macaroons now
      req.session.dischargeMacaroon = macaroon // eslint-disable-line

      console.log(
        `Invoice ${invoiceId} has been paid and is valid until ${time}`
      )

      return res.status(200).json({ status, discharge: macaroon.serialize() })
    } else if (status === 'processing' || status === 'unpaid') {
      console.log('still processing invoice %s...', invoiceId)
      return res.status(202).json({ status, payreq })
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

app.use('*/protected', async (req, res, next) => {
  console.log(
    'Checking if the request has been authorized or still requires payment...'
  )
  const rootMacaroon = req.session.macaroon
  console.log('Do we have a rootMacaroon?', rootMacaroon)
  // if there is no macaroon at all
  if (!rootMacaroon) {
    try {
      // then we need to request a new invoice
      const invoice = await createInvoice(req)
      // create a root macaroon with the associated id
      const macaroon = await createMacaroon(invoice, req)
      // and send back macaroon and invoice info back in response
      req.session.macaroon = macaroon // eslint-disable-line
      return res
        .status(402)
        .json({ invoice, message: 'Payment required to access content.' })
      // TODO: Do we want to separate the 402 response step from the invoice post step?
      // i.e. should we just return a 402 and make it the responsibility of the client
      // to do the POST /invoice to get a new payment request?
    } catch (e) {
      const status = e.status || 400
      return res.status(status).json({ message: e.message })
    }
  }

  // if there is a root macaroon
  // check that we also have the discharge macaroon passed either in request query or a session cookie
  let dischargeMacaroon =
    req.query.dischargeMacaroon || req.session.dischargeMacaroon

  // if no discharge macaroon then we need to check on the status of the invoice
  // this can also be done in a separate request to GET /invoice
  if (!dischargeMacaroon) {
    if (!req.query.id)
      return next(
        'Require an invoice id in the request in order to generate discharge macaroon'
      )

    // then check status of invoice (Note: Anyone can pay this! It's not tied to the request or origin.
    // Once paid, the requests are authorized and can get the macaroon)
    const { status, amount, payreq } = await checkInvoiceStatus(req)

    if (status === 'paid') {
      // amount is in satoshis which is equal to the amount of seconds paid for
      const milli = amount * 1000
      // add 200 milliseconds of "free time" as a buffer
      const time = new Date(Date.now() + milli + 200)
      const caveat = `time < ${time}`

      dischargeMacaroon = getDischargeMacaroon(req, caveat)

      console.log(`Invoice has been paid and is valid until ${time}`)

      // if invoice has been paid
      // then create a discharge macaroon and attach it to a session cookie
      req.session.dischargeMacaroon = dischargeMacaroon // eslint-disable-line
    } else if (status === 'processing' || status === 'unpaid') {
      console.log('still processing invoice %s...', req.query.id)
      return res.status(202).json({ status, payreq })
    } else {
      return res
        .status(400)
        .json({ message: `unknown invoice status ${status}` })
    }
  }

  // otherwise if there is a discharge macaroon, then we want to verify the whole macaroon
  try {
    // make sure request is authenticated by validating the macaroons
    const exactCaveat = getFirstPartyCaveat(req)
    validateMacaroons(rootMacaroon, dischargeMacaroon, exactCaveat)
    // if everything validates then simply run `next()`
    console.log(
      'Request from ${req.hostname} authenticated with payment. Sending through paywall'
    )
    next()
  } catch (e) {
    // if throws with an error message that includes text "expired"
    // then payment is required again
    if (e.message.toLowerCase().includes('expired'))
      return res.status(402).json({ message: e.message })
    return res.status(400).json({ message: e.message })
  }
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

/*
 * Utility to create an invoice based on either an authenticated lnd grpc instance
 * or an opennode connection
 * @params {Object} req - express request object that either contains an lnd or opennode object
 * @returns {Object} invoice - returns an invoice with a payreq, id, description, createdAt, and
 */
async function createInvoice({ lnd, opennode, body, ip }) {
  let { time, title, expiresAt, appName } = body // time in seconds

  if (!appName) appName = `[unknown application @ ${ip}]`

  if (!title) title = '[unknown data]'

  let invoice = {}
  console.log('creating invoice')
  const description = `Access for ${time} seconds in ${appName} for requested data: ${title}`
  const amount = time
  if (lnd) {
    const _invoice = await lnService.createInvoice({
      lnd: lnd,
      description,
      expires_at: expiresAt,
      tokens: amount,
    })

    invoice.payreq = _invoice.request
    invoice.id = _invoice.id
    invoice.description = _invoice.description
    invoice.createdAt = _invoice.created_at
    invoice.amount = _invoice.tokens
  } else if (opennode) {
    const _invoice = await opennode.createCharge({
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
    throw new Error(
      'No lightning node information configured on request object'
    )
  }

  return invoice
}

/*
 * Given an invoice object and a request
 * we want to create a root macaroon with a third party caveat, which both need to be
 * satisfied in order to authenticate the macaroon
 * @params {invoice.id} - invoice must at least have an id for creating the 3rd party caveat
 * @params {Object} req - request object is needed for identification of the macaroon, in particular
 * the headers and the originating ip
 * @returns {Macaroon} - serialized macaroon object
 */

async function createMacaroon(invoice, req) {
  if (!invoice || !invoice.id)
    throw new Error('Missing an invoice object. Cannot create macaroon')
  if (!req) throw new Error('Missing req object. Cannot create macaroon')

  const location = getLocation(req)
  const secret = process.env.SESSION_SECRET || 'i_am_satoshi_08'
  const publicIdentifier = 'session secret'
  const builder = new MacaroonsBuilder(
    location,
    secret,
    publicIdentifier
  ).add_first_party_caveat(`origin = ${req.ip}`) // origin ip must match this value. Preventative measure against sybil/DoS attacks

  const caveatKey = process.env.CAVEAT_KEY

  // when protecting "local" content, i.e. this is being used as a paywall to protect
  // content in the same location as the middleware is implemented, then the third party
  // caveat is discharged by the current host as well, so location is the same for both.
  // In alternative scenarios, where now-paywall is being used to authenticate access at another source
  // then this will be different. e.g. see Prism Reader as an example
  const macaroon = builder
    .add_third_party_caveat(location, caveatKey, invoice.id)
    .getMacaroon()

  return macaroon.serialize()
}

/*
 * Checkst the status of an invoice given an id
 * @params {express.request} - request object from expressjs
 * @params {req.query.id} invoiceId - id of invoice to check status of
 * @params {req.lnd} [lnd] - ln-service authenticated grpc object
 * @params {req.opennode} [opennode] - authenticated opennode object for communicating with OpenNode API
 * @returns {Object} - status - Object with status, amount, and payment request
 */

async function checkInvoiceStatus({ lnd, opennode, query: { id: invoiceId } }) {
  if (!invoiceId) throw new Error('Missing invoice id.')

  let status, amount, payreq
  if (lnd) {
    const invoiceDetails = await lnService.getInvoice({
      id: invoiceId,
      lnd: lnd,
    })
    status = invoiceDetails['is_confirmed'] ? 'paid' : 'unpaid'
    amount = invoiceDetails.tokens
    payreq = invoiceDetails.request
  } else if (opennode) {
    const data = await opennode.chargeInfo(invoiceId)
    amount = data.amount
    status = data.status
    payreq = data['lightning_invoice'].payreq
  } else {
    throw new Error(
      'No lightning node information configured on request object'
    )
  }

  return { status, amount, payreq }
}

/*
 * Validates a macaroon and should indicate reason for failure
 * if possible
 * @params {Macaroon} root - root macaroon
 * @params {Macaroon} discharge - discharge macaroon from 3rd party validation
 * @params {String} exactCaveat - a first party, exact caveat to test on root macaroon
 * @returns {Boolean|Exception} will return true if passed or throw with failure
 */
function validateMacaroons(root, discharge, exactCaveat) {
  const TimestampCaveatVerifier = verifier.TimestampCaveatVerifier
  root = MacaroonsBuilder.deserialize(root)
  discharge = MacaroonsBuilder.deserialize(discharge)

  const boundMacaroon = MacaroonsBuilder.modify(root)
    .prepare_for_request(discharge)
    .getMacaroon()

  // lets verify the macaroon caveats
  const valid = new MacaroonsVerifier(root)
    // root macaroon should have a caveat to match the docId
    .satisfyExact(exactCaveat.caveat)
    // discharge macaroon is expected to have the time caveat
    .satisfyGeneral(TimestampCaveatVerifier)
    // confirm that the payment node has discharged appropriately
    .satisfy3rdParty(boundMacaroon)
    // confirm that this macaroon is valid
    .isValid(process.env.SESSION_SECRET)

  // if it's valid then we're good to go
  if (valid) return true

  // if not valid, let's check if it's because of time or because of docId mismatch
  const TIME_CAVEAT_PREFIX = /time < .*/

  // find time caveat in third party macaroon and check if time has expired
  for (let caveat of boundMacaroon.caveatPackets) {
    caveat = caveat.getValueAsText()
    if (TIME_CAVEAT_PREFIX.test(caveat) && !TimestampCaveatVerifier(caveat))
      throw new Error(`Time has expired for accessing content`)
  }

  for (let caveat of root.caveatPackets) {
    caveat = caveat.getValueAsText()
    // TODO: should probably generalize the exact caveat check or export as constant.
    // This would fail even if there is a space missing in the caveat creation
    if (exactCaveat.prefixMatch(caveat) && caveat !== exactCaveat.caveat)
      throw new Error('Document id did not match macaroon')
  }
}

/*
 * Returns serealized discharge macaroon, signed with the server's caveat key
 * and with an attached caveat (if passed)
 * @params {Express.request} - req object
 * @params {String} caveat - first party caveat such as `time < ${now + 1000 seconds}`
 * @returns {Macaroon} discharge macaroon
 */
function getDischargeMacaroon(req, caveat) {
  const { id: invoiceId } = req.query

  if (!invoiceId) throw new Error('Missing invoiceId in request')

  // check if there is a caveat key before proceeding
  if (!process.env.CAVEAT_KEY)
    throw new Error(
      'Service is missing caveat key for signing discharge macaroon. Contact node admin.'
    )

  // create discharge macaroon
  const location = getLocation(req)

  // Now that we've confirmed invoice is paid, create the discharge macaroon
  let macaroon = new MacaroonsBuilder(
    location,
    process.env.CAVEAT_KEY, // this should be randomly generated, w/ enough entropy and of length > 32 bytes
    invoiceId
  )
  // .add_first_party_caveat(`time < ${time}`)
  // .getMacaroon()

  if (caveat) macaroon.add_first_party_caveat(caveat)

  macaroon = macaroon.getMacaroon()

  return macaroon.serialize()
}

/*
 * Utility function for get a location string to describe _where_ are
 * useful for setting identifiers in macaroons
 * @params {Express.request} req - expressjs request object
 * @params {Express.request.headers} [headers] - optional headers property added by zeit's now
 * @params {Express.request.hostname} - fallback if not in a now lambda
 * @returns {String} - location string
 */
function getLocation({ headers, hostname }) {
  return headers
    ? headers['x-forwarded-proto'] + '://' + headers['x-now-deployment-url']
    : hostname || 'self'
}

function getFirstPartyCaveat(req) {
  return {
    prefix: 'origin',
    value: req.ip,
    caveat: `origin = ${req.ip}`,
    prefixMatch: value => /origin = .*/.test(value),
  }
}
module.exports = app
