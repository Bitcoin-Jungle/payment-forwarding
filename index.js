import express from 'express'
import bodyParser from 'body-parser'
import crypto from 'crypto'
import sqlite3 from 'sqlite3'
import { open } from 'sqlite'
import fetch from 'node-fetch'
import { pay } from 'ln-service'
import { authenticatedLndGrpc } from 'lightning'

// set all the env vars
const port = process.env.port
const webhookSecret = process.env.webhookSecret
const dbLocation = process.env.dbLocation
const btcpayBaseUri = process.env.btcpayBaseUri
const lnUrlBaseUri = process.env.lnUrlBaseUri
const btcpayApiKey = process.env.btcpayApiKey
const lndTlsCert = process.env.lndTlsCert
const lndMacaroon = process.env.lndMacaroon
const lndIpAndPort = process.env.lndIpAndPort

const app = express()

const {lnd} = authenticatedLndGrpc({
  cert: lndTlsCert,
  macaroon: lndMacaroon,
  socket: lndIpAndPort,
})

// parse as JSON, but also keep the rawBody for HMAC verification
app.use(bodyParser.json({
  verify: (req, res, buf) => {
    req.rawBody = buf
  }
}))

// HMAC verification middleware
app.use((req, res, next) => {
  const test = crypto.createHmac('sha256', webhookSecret).update(req.rawBody).digest("hex")
  const sig  = req.headers['btcpay-sig'].replace('sha256=', '')

  if(test !== sig) {
    console.log('signature failed')
    res.sendStatus(401)
  } else {
    next()
  }
})

// process the webhook from BTCPay Server
app.post('/forward', async (req, res) => {
  console.log(req.body)  

  // we only care about settled invoices
  if(req.body.type !== "InvoiceSettled") {
    console.log('not invoice settled type')
    res.sendStatus(200)
    return
  }

  // connect to the db
  const db = await open({
    filename: dbLocation,
    driver: sqlite3.Database
  })

  // save the exeuction to the db
  const execution = await addExecution(db, req.body)

  // if this is a webhook redelivery, we want to see if the original exeuction was successfully processed or not
  if(req.body.isRedelivery) {
    const originalExecution = await getExecution(db, req.body.originalDeliveryId)

    // if the original execution was indeed processed, we should exit now and not double send money
    if(originalExecution && originalExecution.isProcessed) {
      console.log('original execution already processed')
      res.sendStatus(200)
      return
    }
  }

  // if manually marked, don't send money, bc we didn't really get any money
  if(req.body.manuallyMarked) {
    // mark the execution as processed so we don't try it again
    await setExecutionProcessed(db, req.body.deliveryId)
    
    console.log('is manually marked')
    res.sendStatus(200)
    return
  }

  // fetch store details from the db
  const store = await getStore(db, req.body.storeId)

  if(!store) {
    console.log('no store')
    res.sendStatus(404)
    return
  }

  // fetch invoice details from btcpayserver
  const invoice = await fetchInvoice(req.body.storeId, req.body.invoiceId)

  if(!invoice) {
    console.log('no invoice')
    res.sendStatus(404)
    return
  }

  // we only care about settled invoices
  if(invoice.status !== "Settled") {
    console.log('invoice not settled')
    res.sendStatus(200)
    return
  }

  // fetch invoice payments from btcpayserver
  const payments = await fetchInvoicePayments(req.body.storeId, req.body.invoiceId)

  // calculate the total BTC paid on the invoice
  let btcTotal = 0

  payments.forEach(el => {
    // we only deal with BTC in this script
    if(el.cryptoCode == "BTC") {
      btcTotal += parseFloat(el.totalPaid)
    }
  })

  // calculate the btc total in milli-satoshis
  let milliSatAmount = btcTotal * 100000000 * 1000

  // deduct the store's fee from the total we will pay out
  milliSatAmount = Math.round(milliSatAmount * store.rate)

  // round to the nearest full mill-satoshi
  milliSatAmount = Math.round(milliSatAmount / 1000) * 1000

  // the minimum is 1 satoshi, if less than that, round up to 1
  if(milliSatAmount < 1000) {
    milliSatAmount = 1000
  }

  console.log('milliSatAmount', milliSatAmount)

  // hit the LNURL endpoint for Bitcoin Jungle
  const lnUrl = await fetchLnUrl(store.bitcoinJungleUsername)

  if(!lnUrl) {
    console.log('no lnurl')
    res.sendStatus(404)
    return
  }

  if(!lnUrl.callback) {
    console.log('no lnurl callback')
    res.sendStatus(404)
    return
  }

  // use the Bitcoin Jungle LNURL endpoint to generate a bolt11 invoice for the milli-satoshi amount calculated
  const lnUrlWithAmount = await fetchLnUrl(store.bitcoinJungleUsername, milliSatAmount)

  if(!lnUrlWithAmount) {
    console.log('no lnUrlWithAmount')
    res.sendStatus(404)
    return
  }

  if(lnUrlWithAmount.status == "ERROR") {
    console.log('lnUrlWithAmount error', lnUrlWithAmount.reason)
    res.sendStatus(404)
    return
  }

  if(!lnUrlWithAmount.pr) {
    console.log('no lnUrlWithAmount invoice')
    res.sendStatus(404)
    return
  }
  
  const lnInvoice = await payLnInvoice(lnd, lnUrlWithAmount.pr)

  if(lnInvoice) {
    // we've now forwarded the payment, mark it as such in the db
    await setExecutionProcessed(db, req.body.deliveryId)

    // if this is a redelivery, we also want to mark the original delivery as processed
    if(req.body.isRedelivery) {
      await setExecutionProcessed(db, req.body.originalDeliveryId)
    }

    console.log('payment succeded, marked as processed, all done')
    // we're done!
    res.sendStatus(200)
    return
  }

  // the execution didn't process fully :(
  console.log('error occurred with lnInvoice')
  res.sendStatus(404)
  return
})

app.listen(port, () => {
  console.log(`Example app listening at http://localhost:${port}`)
})

const payLnInvoice = async (lnd, invoice) => {
  try {
    // pay the bolt11 invoice in the Bitcoin Jungle wallet
    const lnUrlPayment = await pay({
      lnd, 
      request: invoice,
    })

    console.log('lnUrlPayment', lnUrlPayment)

    return true
  } catch (err) {
    console.log('lnd payment error', err)

    return false
  }
}

const fetchLnUrl = async (bitcoinJungleUsername, milliSatAmount) => {
  try {
    const response = await fetch(
      lnUrlBaseUri + ".well-known/lnurlp/" + bitcoinJungleUsername + (milliSatAmount ? "?amount=" + milliSatAmount : "")
    )

    if (!response.ok) {
      return false
    }
    return await response.json()
  } catch (err) {
    console.log('fetchLnUrl fail', err)
    return false
  }
}

const fetchInvoice = async (storeId, invoiceId) => {
  try {
    const response = await fetch(
      btcpayBaseUri + "api/v1/stores/" + storeId + "/invoices/" + invoiceId,
      {
        headers: {
          "Authorization": "token " + btcpayApiKey
        }
      }
    )

    if (!response.ok) {
      return false
    }
    return await response.json()
  } catch (err) {
    console.log('fetchInvoice fail', err)
    return false
  }
}

const fetchInvoicePayments = async (storeId, invoiceId) => {
  try {
    const response = await fetch(
      btcpayBaseUri + "api/v1/stores/" + storeId + "/invoices/" + invoiceId + "/payment-methods",
      {
        headers: {
          "Authorization": "token " + btcpayApiKey
        }
      }
    )

    if (!response.ok) {
      return false
    }
    return await response.json()
  } catch (err) {
    console.log('fetchInvoicePayments fail', err)
    return false
  }
}

const getStore = async (db, storeId) => {
  try {
    return await db.get(
      "SELECT * FROM stores WHERE storeId = ?", 
      [storeId]
    )
  } catch {
    return false
  }
}

const getExecution = async (db, deliveryId) => {
  try {
    return await db.get(
      "SELECT * FROM executions WHERE deliveryId = ? OR originalDeliveryId = ?",
      [deliveryId, deliveryId]
    )
  } catch {
    return false
  }
}

const addExecution = async (db, obj) => {
  try {
    return await db.run(
      "INSERT INTO executions (deliveryId, webhookId, originalDeliveryId, isRedelivery, type, timestamp, manuallyMarked, storeId, invoiceId) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", 
      Object.values(obj)
    )
  } catch {
    return false
  }
}

const setExecutionProcessed = async (db, deliveryId) => {
  try {
    return await db.run(
      "UPDATE executions SET isProcessed = true WHERE deliveryId = ?",
      [deliveryId]
    )
  } catch {
    return false
  }
}