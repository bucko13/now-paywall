/* eslint-disable no-console */
const express = require('express')
const app = express()
const cors = require('cors')
const MacaroonsBuilder = require('macaroons.js').MacaroonsBuilder

app.use(cors())

app.post('/api/invoice', async (req, res) => {

  const { time, title, docId } = req.body // time in seconds
  const opennode = require('opennode')
  const env = process.env.ENVIRONMENT || 'dev'

  opennode.setCredentials(process.env.OPEN_NODE_KEY, 'dev')

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
    res.status(400).json({ message: error.message})
  }
})

app.get('/api/invoice', async (req, res) => {
  const { id: invoiceId } = req.query

  if (!invoiceId)
    return res.status(400).json({ message: 'Missing invoiceId in request' })

  const opennode = require('opennode')

  opennode.setCredentials(process.env.OPEN_NODE_KEY, 'dev')

  try {
    console.log('checking for invoiceId:', invoiceId)
    const data = await opennode.chargeInfo(invoiceId)

    // amount is in satoshis which is equal to the amount of seconds paid for
    const {status, amount} = data
    const milli = amount * 1000
    if (status === 'paid') {
      // create discharge macaroon
      const location = req.headers['x-forwarded-proto'] + '://' + req.headers['x-now-deployment-url']

      // add 200 milliseconds of "free time" as a buffer
      const time = new Date(Date.now() + milli + 200)
      const macaroon = new MacaroonsBuilder(location, process.env.CAVEAT_KEY, invoiceId)
          .add_first_party_caveat(`time < ${time}`)
          .getMacaroon();

      console.log(`Invoice ${invoiceId} has been paid and is valid until ${time}`)
      return res
        .status(200)
        .json({ status, discharge: macaroon.serialize() })
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

app.get('/api/node/exchange', async (req, res) => {
  const opennode = require('opennode')
  opennode.setCredentials(process.env.OPEN_NODE_KEY, 'dev')
  const {
    BTCUSD: { USD },
  } = await opennode.listRates()
  res.status(200).json({ BTCUSD: USD })
})

app.get('/api/node', async (req, res) => {
  res.status(200).json({
    identityPubkey:
      '02eadbd9e7557375161df8b646776a547c5cbc2e95b3071ec81553f8ec2cea3b8c@18.191.253.246:9735',
  })
})

module.exports = app
