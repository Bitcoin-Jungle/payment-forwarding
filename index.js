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
const btcPayServerDbLocation = process.env.btcPayServerDbLocation
const btcpayBaseUri = process.env.btcpayBaseUri
const lnUrlBaseUri = process.env.lnUrlBaseUri
const btcpayApiKey = process.env.btcpayApiKey
const lndTlsCert = process.env.lndTlsCert
const lndMacaroon = process.env.lndMacaroon
const lndIpAndPort = process.env.lndIpAndPort
const onChainZpub = process.env.onChainZpub
const exchangeRateApiKey = process.env.exchangeRateApiKey
const btcPayServerTemplateAppId = process.env.btcPayServerTemplateAppId
const basePath = process.env.basePath
const defaultLogoUri = process.env.defaultLogoUri
const internalKey = process.env.internalKey

// these paths don't need to do hmac-sha256 verififaction
const noAuthPaths = [
  '/addStore',
]

// connect to the db
const db = await open({
  filename: dbLocation,
  driver: sqlite3.Database
})

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
  if(noAuthPaths.indexOf(req.url.split("?")[0]) !== -1) {
    next()
    return
  }

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

  // check to see if this invoice already exists in the db
  const invoiceExists = await getInvoice(db, req.body.storeId, req.body.invoiceId)

  // if the invoice does exist in the db, we need to do some additional checks
  if(invoiceExists) {

    // if the invoice is currently processing, we don't want a race condition
    if(invoiceExists.isProcessing) {
      console.log('invoice is currently processing')
      res.sendStatus(404)
      return
    }

    // if the invoice has already been processed, we don't have anything else to do
    if(invoiceExists.isProcessed) {
      console.log('invoice is already processed')
      res.sendStatus(200)
      return
    }
  }

  // save the exeuction to the db
  const saveInvoice = await addInvoice(db, req.body.storeId, req.body.invoiceId, true, false)

  if(!saveInvoice) {
    console.log('unexpected error saving invoice to db')
    res.sendStatus(404)
    return
  }

  // if the invoice was manually marked, don't send money, bc we didn't really get any money
  if(req.body.manuallyMarked) {

    // mark the invoice as processed so we don't try it again
    await setInvoiceProcessed(db, req.body.storeId, req.body.invoiceId)
    
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
      el.payments.forEach(el2 => {
        btcTotal += parseFloat(el2.value)
      })
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

  console.log('milliSatAmount to pay out', milliSatAmount)

  const feeRetainedMilliSatoshis = Math.round((btcTotal * 100000000 * 1000) - milliSatAmount)

  console.log('fee we retain', feeRetainedMilliSatoshis)

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

  if(lnInvoice && lnInvoice.is_confirmed) {
    // we've now forwarded the payment, mark it as such in the db
    await setInvoiceProcessed(db, req.body.storeId, req.body.invoiceId)

    // store a record of the payment in the db
    await addPayment(db, lnInvoice.id, req.body.storeId, req.body.invoiceId, req.body.timestamp, feeRetainedMilliSatoshis)

    console.log('payment succeded, marked as processed, all done')

    // we're done!
    res.sendStatus(200)
    return
  }

  // the invoice didn't process fully :(
  console.log('error occurred with lnInvoice')
  res.sendStatus(404)
  return
})

app.post('/beds24', async (req, res) => {
  console.log(req.body)  

  // we only care about settled invoices
  if(req.body.type !== "InvoiceSettled") {
    console.log('not invoice settled type')
    res.sendStatus(200)
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

  if(!invoice.metadata || !invoice.metadata.orderId) {
    console.log('no orderId')
    res.sendStatus(200)
    return
  }

  console.log('invoice', invoice)

  const params = new URLSearchParams();
  params.append('key', webhookSecret);
  params.append('bookid', invoice.metadata.orderId)
  params.append('amount', invoice.amount)
  params.append('description', 'BTCPayServer Payment Invoice ID' + invoice.id)
  params.append('payment_status', 'Received')
  params.append('txnid', invoice.id)

  const response = await fetch('https://api.beds24.com/custompaymentgateway/notify.php', {method: 'POST', body: params});

  console.log(response);

  // we're done!
  res.sendStatus(200)
  return
})

app.post('/addStore', async (req, res) => {
  // input vars
  const apiKey  = req.body.apiKey
  const storeName = req.body.storeName
  const storeOwnerEmail = req.body.storeOwnerEmail
  const defaultCurrency = req.body.defaultCurrency
  const defaultLanguage = req.body.defaultLanguage
  const rate    = req.body.rate
  const bitcoinJungleUsername = req.body.bitcoinJungleUsername

  // these are needed but not user editable inputs
  const paymentTolerance = 1
  const defaultPaymentMethod = "BTC_LightningNetwork"
  const customLogo = defaultLogoUri
  const webhookUrl = btcpayBaseUri + "forward"

  // do the validation
  if(!apiKey) {
    res.status(400).send({success: false, error: true, message: "apiKey is required"})
    return
  }

  if(apiKey !== internalKey) {
    res.status(400).send({success: false, error: true, message: "apiKey is incorrect"})
    return
  }

  if(!storeName) {
    res.status(400).send({success: false, error: true, message: "storeName is required"})
    return
  }

  if(!storeOwnerEmail) {
    res.status(400).send({success: false, error: true, message: "storeOwnerEmail is required"})
    return
  }

  if(!defaultCurrency) {
    res.status(400).send({success: false, error: true, message: "defaultCurrency is required"})
    return
  }

  if(!defaultLanguage) {
    res.status(400).send({success: false, error: true, message: "defaultLanguage is required"})
    return
  }

  if(!rate) {
    res.status(400).send({success: false, error: true, message: "rate is required"})
    return
  }

  if(!bitcoinJungleUsername) {
    res.status(400).send({success: false, error: true, message: "bitcoinJungleUsername is required"})
    return
  }

  // connect to the btcpayserver db
  const btcPayServerDb = await open({
    filename: btcPayServerDbLocation,
    driver: sqlite3.Database
  })

  // create store via api
  const store = await fetchCreateStore({
    storeName,
    storeOwnerEmail,
    defaultCurrency,
    defaultLanguage,
    paymentTolerance,
    defaultPaymentMethod,
    customLogo,
  })

  if(!store.id) {
    res.status(400).send({success: false, error: true, message: "error happened creating store in API"})
    return
  }

  // create user via api
  let user = await fetchCreateUser({
    storeOwnerEmail,
  })

  if(!user.id) {
    user = await fetchGetUser(storeOwnerEmail)

    if(!user.id) {
      res.status(400).send({success: false, error: true, message: "error happened creating user in API"})
      return
    }
  }

  // attach user to store via api
  const userStore = await fetchCreateUserStore({
    storeId: store.id,
    userId: user.id,
  })

  // attach webhook to store via api
  const webhook = await fetchCreateWebhook({
    storeId: store.id,
    url: webhookUrl,
    secret: webhookSecret,
    authorizedEvents: {
      everything: false,
      specificEvents: [
        "InvoiceSettled",
      ],
    },
  })

  if(!webhook.id) {
    res.status(400).send({success: false, error: true, message: "error happened creating webhook in API"})
    return
  }

  // create LN payment method via API
  const lnPaymentMethod = await fetchCreateLnPaymentMethod({
    storeId: store.id,
    cryptoCode: "BTC",
    connectionString: "Internal Node",
    enabled: true,
  })

  // create on-chain payment method via API
  const onChainPaymentMethod = await fetchCreateOnChainPaymentMethod({
    storeId: store.id,
    cryptoCode: "BTC",
    enabled: true,
    derivationScheme: onChainZpub,
  })

  // add store to our internal db
  const newStore = await addStore(db, store.id, rate, bitcoinJungleUsername)

  if(!newStore) {
    console.log('db error', newStore)
    res.status(500).send({success: false, error: true, message: "error writing to db"})
    return
  }

  // fetch current exchange rate for store's currency
  const currentExchangeRate = await fetchExchangeRate(defaultCurrency)

  // get btcpayserver Store record from db
  const btcPayServerStore = await getBtcPayServerStore(btcPayServerDb, store.id)

  // the blob stores the custom rate rules
  let storeBlob = JSON.parse(btcPayServerStore.StoreBlob)

  if(storeBlob) {
    // turn on rate scripting
    storeBlob.rateScripting = true

    // set a rate script to convert BTC to store's currency via USD
    storeBlob.rateScript = `BTC_${defaultCurrency.toUpperCase()} = coingecko(BTC_USD) * ${currentExchangeRate};`;

    storeBlob = JSON.stringify(storeBlob)

    // update the blob in the btcpayserver db
    const update = await updateBtcPayServerStoreBlob(btcPayServerDb, store.id, storeBlob)
  }

  // fetch the template App we want to copy
  const btcPayServerTemplateApp = await getBtcPayServerTemplateApp(btcPayServerDb)

  // customize the Data we need for the App
  let btcPayServerAppData = {
    Id: generateRandomString(28),
    AppType: "PointOfSale",
    Created: "1306446895470200832",
    Name: storeName,
    StoreDataId: store.id,
    Settings: JSON.stringify({
      "Title": storeName,
      "Currency": defaultCurrency.toUpperCase(),
      "Template": "{}\n",
      "EnableShoppingCart": false,
      "DefaultView": 2,
      "ShowCustomAmount": true,
      "ShowDiscount": false,
      "EnableTips": false,
      "RequiresRefundEmail": 0,
      "ButtonText": "Buy for {0}",
      "CustomButtonText": "Pay",
      "CustomTipText": "Do you want to leave a tip?",
      "CustomTipPercentages": [15, 18, 20],
      "CustomCSSLink": null,
      "EmbeddedCSS": "* {\r\n  touch-action: manipulation;\r\n}",
      "Description": null,
      "NotificationUrl": null,
      "RedirectUrl": null,
      "RedirectAutomatically": null
    })
  }

  // create the App record in the btcpayserver db
  const btcPayServerApp = await createBtcPayServerApp(btcPayServerDb, btcPayServerAppData)

  // we're done!
  res.status(200).send({success: true, error: false, btcPayServerAppId: btcPayServerAppData.Id})
  return
})

app.get('/addStore', (req, res) => {
  res.sendFile('newStore/index.html', {root: basePath})
})

app.listen(port, () => {
  console.log(`Example app listening at http://localhost:${port}`)
})

const fetchExchangeRate = async (currency) => {
  try {
    const response = await fetch(
      `https://api.exchangeratesapi.io/v1/latest?access_key=${exchangeRateApiKey}&base=USD&symbols=${currency.toUpperCase()}`,
      {
        method: "get",
      }
    )

    if (!response.ok) {
      console.log(response.status, response.statusText)
      return false
    }

    const data = await response.json()

    if(!data.success) {
      console.log(data)
      return false
    }

    return Math.round(data.rates[currency.toUpperCase()])

  } catch (err) {
    console.log('fetchExchangeRate fail', err)
    return false
  }
}

const generateRandomString = (length) => {
    var result           = '';
    var characters       = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    var charactersLength = characters.length;
    for ( var i = 0; i < length; i++ ) {
      result += characters.charAt(Math.floor(Math.random() * charactersLength));
   }
   return result;
}

const payLnInvoice = async (lnd, invoice) => {
  try {
    // pay the bolt11 invoice in the Bitcoin Jungle wallet
    const lnUrlPayment = await pay({
      lnd, 
      request: invoice,
    })

    console.log('lnUrlPayment', lnUrlPayment)

    return lnUrlPayment
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

const fetchCreateStore = async (data) => {
  try {
    const response = await fetch(
      btcpayBaseUri + "api/v1/stores",
      {
        method: "post",
        body: JSON.stringify({
          name: data.storeName,
          defaultCurrency: data.defaultCurrency,
          defaultLanguage: data.defaultLanguage,
          paymentTolerance: data.paymentTolerance,
          defaultPaymentMethod: data.defaultPaymentMethod,
          customLogo: data.customLogo,
        }),
        headers: {
          "Authorization": "token " + btcpayApiKey,
          "Content-Type": "application/json",
        }
      }
    )

    if (!response.ok) {
      console.log(response.status, response.statusText)
      return false
    }
    return await response.json()
  } catch (err) {
    console.log('fetchCreateStore fail', err)
    return false
  }
}

const fetchCreateUser = async (data) => {
  try {
    const response = await fetch(
      btcpayBaseUri + "api/v1/users",
      {
        method: "post",
        body: JSON.stringify({
          email: data.storeOwnerEmail,
          password: generateRandomString(16),
        }),
        headers: {
          "Authorization": "token " + btcpayApiKey,
          "Content-Type": "application/json",
        }
      }
    )

    if (!response.ok) {
      console.log(response.status, response.statusText)
      return false
    }
    return await response.json()
  } catch (err) {
    console.log('fetchCreateUser fail', err)
    return false
  }
}

const fetchGetUser = async (email) => {
  try {
    const response = await fetch(
      btcpayBaseUri + "api/v1/users/" + email,
      {
        method: "get",
        headers: {
          "Authorization": "token " + btcpayApiKey,
        }
      }
    )

    if (!response.ok) {
      console.log(response.status, response.statusText)
      return false
    }
    return await response.json()
  } catch (err) {
    console.log('fetchGetUser fail', err)
    return false
  }
}



const fetchCreateUserStore = async (data) => {
  try {
    const response = await fetch(
      btcpayBaseUri + "api/v1/stores/" + data.storeId + "/users",
      {
        method: "post",
        body: JSON.stringify({
          userId: data.userId,
          role: "Guest",
        }),
        headers: {
          "Authorization": "token " + btcpayApiKey,
          "Content-Type": "application/json",
        }
      }
    )

    if (!response.ok) {
      console.log(response.status, response.statusText)
      return false
    }
    return await response.json()
  } catch (err) {
    console.log('fetchCreateUserStore fail', err)
    return false
  }
}

const fetchCreateWebhook = async (data) => {
  try {
    const response = await fetch(
      btcpayBaseUri + "api/v1/stores/" + data.storeId + "/webhooks",
      {
        method: "post",
        body: JSON.stringify({
          url: data.url,
          secret: data.secret,
          authorizedEvents: data.authorizedEvents,
        }),
        headers: {
          "Authorization": "token " + btcpayApiKey,
          "Content-Type": "application/json",
        }
      }
    )

    if (!response.ok) {
      console.log(response.status, response.statusText)
      return false
    }
    return await response.json()
  } catch (err) {
    console.log('fetchCreateWebhook fail', err)
    return false
  }
}

const fetchCreateLnPaymentMethod = async (data) => {
  try {
    const response = await fetch(
      btcpayBaseUri + "api/v1/stores/" + data.storeId + "/payment-methods/LightningNetwork/" + data.cryptoCode,
      {
        method: "put",
        body: JSON.stringify({
          connectionString: data.connectionString,
          enabled: data.enabled,
        }),
        headers: {
          "Authorization": "token " + btcpayApiKey,
          "Content-Type": "application/json",
        }
      }
    )

    if (!response.ok) {
      console.log(response.status, response.statusText)
      return false
    }
    return await response.json()
  } catch (err) {
    console.log('fetchCreateLnPaymentMethod fail', err)
    return false
  }
}

const fetchCreateOnChainPaymentMethod = async (data) => {
  try {
    const response = await fetch(
      btcpayBaseUri + "api/v1/stores/" + data.storeId + "/payment-methods/onchain/" + data.cryptoCode,
      {
        method: "put",
        body: JSON.stringify({
          enabled: data.enabled,
          derivationScheme: data.derivationScheme,
          label: "BJ Electrum",
        }),
        headers: {
          "Authorization": "token " + btcpayApiKey,
          "Content-Type": "application/json",
        }
      }
    )

    if (!response.ok) {
      console.log(response.status, response.statusText)
      return false
    }
    return await response.json()
  } catch (err) {
    console.log('fetchCreateOnChainPaymentMethod fail', err)
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

const getBtcPayServerTemplateApp = async (db) => {
  try {
    return await db.get(
      "SELECT * FROM Apps WHERE Id = ?", 
      [btcPayServerTemplateAppId]
    )
  } catch {
    return false
  }
}

const createBtcPayServerApp = async (db, data) => {
  try {
    return await db.run(
      "INSERT INTO Apps (Id, AppType, Created, Name, StoreDataId, Settings) VALUES (?, ?, ?, ?, ?, ?)", 
      [
        data.Id,
        data.AppType,
        data.Created,
        data.Name,
        data.StoreDataId,
        data.Settings
      ]
    )
  } catch {
    return false
  }
}

const updateBtcPayServerStoreBlob = async (db, storeId, storeBlob) => {
  try {
    return await db.get(
      "UPDATE Stores SET StoreBlob = ? WHERE id = ?", 
      [
        storeBlob,
        storeId,
      ]
    )
  } catch {
    return false
  }
}

const getBtcPayServerStore = async (db, storeId) => {
  try {
    return await db.get(
      "SELECT * FROM Stores WHERE Id = ?", 
      [storeId]
    )
  } catch {
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

const getInvoice = async (db, storeId, invoiceId) => {
  try {
    return await db.get(
      "SELECT * FROM invoices WHERE storeId = ? AND invoiceId = ?",
      [storeId, invoiceId]
    )
  } catch {
    return false
  }
}

const addInvoice = async (db, storeId, invoiceId, isProcessing, isProcessed) => {
  try {
    return await db.run(
      "INSERT INTO invoices (storeId, invoiceId, isProcessing, isProcessed) VALUES (?, ?, ?, ?)", 
      [
        storeId,
        invoiceId,
        isProcessing,
        isProcessed,
      ]
    )
  } catch {
    return false
  }
}

const setInvoiceProcessed = async (db, storeId, invoiceId) => {
  try {
    return await db.run(
      "UPDATE invoices SET isProcessing = false, isProcessed = true WHERE storeId = ? AND invoiceId = ?",
      [
        storeId,
        invoiceId,
      ]
    )
  } catch {
    return false
  }
}

const addPayment = async(db, paymentId, storeId, invoiceId, timestamp, feeRetainedMilliSatoshis) => {
  try {
    return await db.run(
      "INSERT INTO payments (paymentId, storeId, invoiceId, timestamp, feeRetained) VALUES (?, ?, ?, ?, ?)", 
      [
        paymentId,
        storeId,
        invoiceId,
        timestamp,
        feeRetainedMilliSatoshis,
      ]
    )
  } catch {
    return false
  }
}

const addStore = async(db, storeId, rate, bitcoinJungleUsername) => {
  try {
    return await db.run(
      "INSERT INTO stores (storeId, rate, bitcoinJungleUsername) VALUES (?, ?, ?)", 
      [
        storeId,
        rate,
        bitcoinJungleUsername
      ]
    )
  } catch(err) {
    console.log(err)
    return false
  }
}