/**
 * IMPORTANT: This is a file created by the now-paywall builder.
 * The builder will make this file as the entrypoint and import the
 * user defined one as the `protectedRoute`
 */

const express = require('express')
const cors = require('cors')
const MacaroonsBuilder = require('macaroons.js').MacaroonsBuilder

let protectedRoute = require('./_entrypoint')

const router = express.Router()

const app = express()

app.use(cors())

// TODO: Add support for OpenNode OR self-hosted ln node
// this middleware should then check which one is enabled and verify
// that it is configured correctly
app.use('*/invoice', (req, res, next) => {
  if (!process.env.OPEN_NODE_KEY)
    next(
      new Error(
        'No OpenNode API Key. Paywall operator must set key as environment variable when deploying.'
      )
    )
  else next()
})

app.post('*/invoice', async (req, res) => {
  const { time, title } = req.body // time in seconds
  const opennode = require('opennode')
  const env = process.env.ENVIRONMENT || 'dev'

  opennode.setCredentials(process.env.OPEN_NODE_KEY, env)

  try {
    console.log('creating invoice')
    const invoice = await opennode.createCharge({
      description: `${time} seconds in the lightning reader for ${title}`,
      amount: time,
      auto_settle: false,
    })

    res.status(200).json(invoice)
  } catch (error) {
    console.error(`${error.status} | ${error.message}`)
    res.status(400).json({ message: error.message })
  }
})

app.get('*/invoice', async (req, res) => {
  const { id: invoiceId } = req.query

  if (!invoiceId)
    return res.status(400).json({ message: 'Missing invoiceId in request' })

  const opennode = require('opennode')

  opennode.setCredentials(process.env.OPEN_NODE_KEY, 'dev')

  try {
    console.log('checking for invoiceId:', invoiceId)
    const data = await opennode.chargeInfo(invoiceId)

    // amount is in satoshis which is equal to the amount of seconds paid for
    const { status, amount } = data
    const milli = amount * 1000
    if (status === 'paid') {
      // create discharge macaroon
      const location =
        req.headers['x-forwarded-proto'] +
        '://' +
        req.headers['x-now-deployment-url']

      // add 200 milliseconds of "free time" as a buffer
      const time = new Date(Date.now() + milli + 200)
      const macaroon = new MacaroonsBuilder(
        location,
        process.env.CAVEAT_KEY,
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
      return res.status(202).json({ status })
    } else {
      return res
        .status(400)
        .json({ message: `unknown invoice status ${status}` })
    }
  } catch (error) {
    console.error(`${error.status} | ${error.message}`)
    res.status(400).json({ message: error.message })
  }
})

// TODO: replace with an actual pubkey retrieval call if using a self-hosted node
app.get('*/node', async (req, res) => {
  res.status(200).json({
    identityPubkey:
      '02eadbd9e7557375161df8b646776a547c5cbc2e95b3071ec81553f8ec2cea3b8c@18.191.253.246:9735',
  })
})

router.use(protectedRoute)

// Placeholder for middleware to check for payment
// TODO: replace with an actual function for verifying macaroons
app.use('*/protected', (req, res, next) => {
  console.log('Checking if the request requires payment...')
  /* 1. Check the macaroon
   * 2. If checks path and the request is authenticated
   *    then return next()
   * 3. Else if the checks do not pass
   *    then return a 402 error requiring payment
   */

  // this should be updated with the above steps
  if (req.query.paid) next()
  else return res.status(402).json({ message: 'Payment required!' })
})

app.use('*/protected', router)

module.exports = app
