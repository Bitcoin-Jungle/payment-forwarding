import express from 'express'
import bodyParser from 'body-parser'
import crypto from 'crypto'
import sqlite3 from 'sqlite3'
import { open } from 'sqlite'
import fetch from 'node-fetch'
import { pay } from 'ln-service'
import { authenticatedLndGrpc } from 'lightning'
import sgMail from '@sendgrid/mail'

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
const onChainZpub = process.env.onChainZpub
const basePath = process.env.basePath
const defaultLogoUri = process.env.defaultLogoUri
const defaultCssUri = process.env.defaultCssUri
const internalKey = process.env.internalKey
const sendgridApiKey = process.env.sendgridApiKey
const bullBitcoinBaseUrl = "https://api.bullbitcoin.com"

sgMail.setApiKey(sendgridApiKey)

// these paths don't need to do hmac-sha256 verififaction
const noAuthPaths = [
  '/addStore',
  '/tipSplit',
  '/tipLnurl',
  '/getTipConfiguration',
  '/updateStoreAppIds',
  '/enableLnurl',
  '/setTipSplit',
  '/findStores',
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


app.use('/tipSplit', express.static(`${basePath}/tip-split/build`));

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

  if(noAuthPaths.indexOf(req.url.split("?")[0].replace(/\/$/, "")) !== -1) {
    next()
    return
  }

  if(noAuthPaths.indexOf('/' + req.url.split("/")[1].replace(/\/$/, "")) !== -1) {
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
  console.log('webook post data', req.body)  

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
  // if(req.body.manuallyMarked) {

  //   // mark the invoice as processed so we don't try it again
  //   await setInvoiceProcessed(db, req.body.storeId, req.body.invoiceId)
    
  //   console.log('is manually marked')
  //   res.sendStatus(200)
  //   return
  // }

  // fetch store details from the db
  const store = await getStore(db, req.body.storeId)
  const bullBitcoin = store.bullBitcoin ? JSON.parse(store.bullBitcoin) : null

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

  let tipMilliSatAmount = 0
  const tipUsernames = await getTips(db, store.id)
  if(invoice.metadata && invoice.metadata.posData && invoice.metadata.posData.tip && tipUsernames && tipUsernames.length) {
    const tipAmount = parseFloat((typeof invoice.metadata.posData.tip === 'string' ? invoice.metadata.posData.tip.replaceAll(',', '') : invoice.metadata.posData.tip))
    const subtotal = parseFloat((typeof invoice.metadata.posData.subTotal === 'string' ? invoice.metadata.posData.subTotal.replaceAll(',', '') : invoice.metadata.posData.subTotal))
    const fullTotal = parseFloat((typeof invoice.metadata.posData.total === 'string' ? invoice.metadata.posData.total.replaceAll(',', '') : invoice.metadata.posData.total))
    let tipPercent = 0

    if(tipAmount > subtotal) {
      tipPercent = tipAmount / fullTotal
    } else {
      tipPercent = tipAmount / subtotal
    }

    tipMilliSatAmount = Math.round((milliSatAmount * tipPercent) / 1000) * 1000

    console.log('there was a tip!', tipMilliSatAmount)

    milliSatAmount -= tipMilliSatAmount

    console.log('new payout amount to business owner', milliSatAmount)
  }

  if(bullBitcoin && bullBitcoin.percent && bullBitcoin.recipientId && bullBitcoin.token) {
    console.log('we have a bullbitcoin account!')
    const milliSatsToConvertToFiat = Math.round((milliSatAmount * (bullBitcoin.percent / 100)) / 1000) * 1000
    console.log('milliSatsToConvertToFiat', milliSatsToConvertToFiat)
    try {
      const bullBitcoinInvoiceToPay = await fetchBullBitcoinOrder(bullBitcoin.token, bullBitcoin.recipientId, milliSatsToConvertToFiat, req.body.invoiceId)
      
      if(bullBitcoinInvoiceToPay) {
        console.log('bullBitcoinInvoiceToPay', bullBitcoinInvoiceToPay)
        const bbLnInvoice = await payLnInvoice(lnd, bullBitcoinInvoiceToPay)

        if(bbLnInvoice && bbLnInvoice.is_confirmed) {
          milliSatAmount -= milliSatsToConvertToFiat
          console.log('bullBitcoin invoice paid', milliSatsToConvertToFiat, bullBitcoinInvoiceToPay)
        }
      } 
    } catch(e) {
      console.log('error creating bullbitcoin order', e)
    }
  }
    
  console.log('paying business owner', store.bitcoinJungleUsername, milliSatAmount)
  const ownerLnInvoice = await payLnurl(store.bitcoinJungleUsername, milliSatAmount)

  if(ownerLnInvoice) {
    // we've now forwarded the payment, mark it as such in the db
    await setInvoiceProcessed(db, req.body.storeId, req.body.invoiceId)

    if(ownerLnInvoice.id) {
      // store a record of the payment in the db
      await addPayment(db, ownerLnInvoice.id, req.body.storeId, req.body.invoiceId, req.body.timestamp, feeRetainedMilliSatoshis)
    }
    
    if(tipMilliSatAmount > 0) {
      const perUserTipMilliSatAmount = Math.floor( (tipMilliSatAmount / tipUsernames.length) / 1000 ) * 1000

      let tipLnInvoice, tipUsername
      for (var i = tipUsernames.length - 1; i >= 0; i--) {
        tipUsername = tipUsernames[i].bitcoinJungleUsername
        console.log('paying out tip to ', tipUsername, perUserTipMilliSatAmount)
        tipLnInvoice = await payLnurl(tipUsername, perUserTipMilliSatAmount)

        if(tipLnInvoice) {
          // store a record of the payment in the db
          await addTipPayment(db, tipLnInvoice.id, req.body.storeId, req.body.invoiceId, req.body.timestamp, tipUsername, perUserTipMilliSatAmount)
        }
      }
    }

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

const fetchBullBitcoinOrder = async (token, recipientId, milliSatAmount, invoiceId) => {
  const amountSats = Math.round(parseInt(milliSatAmount, 10) / 1000)
  let outPaymentProcessor = null

  const headers = {
    'content-type': 'application/json; charset=utf-8',
    'Authorization': 'Bearer ' + token,
  };

  const recipientBody = JSON.stringify({
    jsonrpc: "2.0",
    id: "654",
    method: "listMyRecipients",
    params: {
      paginator: {
        pageSize: 100,
      },
    }
  })

  try {
    const response = await fetch(`${bullBitcoinBaseUrl}/api-recipients`, {
      method: 'POST',
      headers: headers,
      body: recipientBody,
    });

    const data = await response.json();
    const recipients = data.result.elements
    const myRecipient = recipients.find(el => el.recipientId === recipientId)

    if(myRecipient) {
      outPaymentProcessor = myRecipient.paymentProcessors[0]
    } else {
      console.log('error locating bullbitcoin recipient', error)
      return null
    }
  } catch (error) {
    console.log('error locating bullbitcoin recipient', error)
    return null
  }

  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: "654",
    method: "createMyOrder",
    params: {
      amount: amountSats / 100_000_000,
      isInAmountFixed: true,
      inPaymentProcessor: "IN_LN",
      outPaymentProcessor: outPaymentProcessor,
      outRecipientId: recipientId,
      outTransactionData: { text: invoiceId.substr(0, 14) }
    }
  });
  
  console.log('create order body', body)

  try {
    const response = await fetch(`${bullBitcoinBaseUrl}/api-orders`, {
      method: 'POST',
      headers: headers,
      body: body,
    });

    const data = await response.json();
    console.log('create order res', data)
    if (data.result && data.result.element && data.result.element.inTransaction) {
      const invoiceData = data.result.element.inTransaction.transactionPaymentProcessorData;
      const bolt11Invoice = invoiceData.find(item => item.paymentProcessorData.paymentProcessorDataCode === 'bolt11');
      return bolt11Invoice ? bolt11Invoice.value : null;
    }

    throw new Error('Invoice not found in response');
  } catch (error) {
    console.error('Error creating BullBitcoin order:', error);
    return null;
  }
}

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
  const storeOwnerEmail = (req.body.storeOwnerEmail ? req.body.storeOwnerEmail.trim() : null)
  const defaultCurrency = req.body.defaultCurrency
  const defaultLanguage = req.body.defaultLanguage
  const rate    = req.body.rate
  const bitcoinJungleUsername = req.body.bitcoinJungleUsername
  const tipSplit = req.body.tipSplit
  const bullBitcoin = req.body.bullBitcoin

  if(bullBitcoin) {
    console.log('bullBitcoin', bullBitcoin)
  }

  // these are needed but not user editable inputs
  const paymentTolerance = 1
  const defaultPaymentMethod = "BTC_LightningNetwork"
  const customLogo = defaultLogoUri
  const customCSS = defaultCssUri
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

  if(tipSplit && tipSplit.length) {
    for (var i = tipSplit.length - 1; i >= 0; i--) {
      if(tipSplit[i] != "") {
        const usernameExists = await fetchGetBitcoinJungleUsername(tipSplit[i])

        if(!usernameExists) {
          res.status(400).send({success: false, error: true, message: tipSplit[i] + " is not a valid username"})
          return
        }
      }
    }
  }

  // create store via api
  const store = await fetchCreateStore({
    storeName,
    storeOwnerEmail,
    defaultCurrency,
    defaultLanguage,
    paymentTolerance,
    defaultPaymentMethod,
    customLogo,
    customCSS,
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

  const lnUrlPaymentMethod = await fetchCreateLnUrlPaymentMethod({
    storeId: store.id,
    cryptoCode: "BTC",
    enabled: true,
    useBech32Scheme: true,
    lud12Enabled: false,
  })

  // create on-chain payment method via API
  const onChainPaymentMethod = await fetchCreateOnChainPaymentMethod({
    storeId: store.id,
    cryptoCode: "BTC",
    enabled: true,
    derivationScheme: onChainZpub,
  })

  // add store to our internal db
  const newStore = await addStore(db, store.id, rate, bitcoinJungleUsername, bullBitcoin)

  if(!newStore) {
    console.log('db error', newStore)
    res.status(500).send({success: false, error: true, message: "error writing to db"})
    return
  }

  // update store rate script for CRC support
  const rateScript = `BTC_CRC = bitcoinjungle(BTC_CRC);\nBTC_USD = bitcoinjungle(BTC_USD);`
  const btcPayServerRate = await updateBtcPayServerRate(store.id, rateScript)

  // customize the Data we need for the App
  let btcPayServerAppData = {
    appName: storeName,
    title: storeName,
    currency: defaultCurrency.toUpperCase(),
    defaultView: "Light",
    showCustomAmount: true,
    showDiscount: false,
    enableTips: true,
    requiresRefundEmail: false,
    checkoutType: "V2",
  }

  // create the App record in the btcpayserver db
  const btcPayServerApp = await createBtcPayServerApp(store.id, btcPayServerAppData)

  const storeApp = await setStoreAppId(db, store.id, btcPayServerApp.id)

  if(tipSplit && tipSplit.length) {
    const internalStore = await getStore(db, store.id)
    for (var i = tipSplit.length - 1; i >= 0; i--) {
      if(tipSplit[i] !== "") {
        await setTip(db, internalStore.id, tipSplit[i])
      }
    }
  }

  const emailSent = await sendEmail(storeOwnerEmail)

  // we're done!
  res.status(200).send({success: true, error: false, btcPayServerAppId: btcPayServerApp.id})
  return
})

app.get('/addStore', (req, res) => {
  res.sendFile('newStore/index.html', {root: basePath})
})

app.get('/getTipConfiguration', async (req, res) => {
  const appId = req.query.appId

  if(!appId) {
    res.status(400).send({success: false, error: true, message: "appId is required"})
    return
  }

  const data = await getTipsByAppId(db, appId)

  res.status(200).send({success: true, error: false, data: data})
})

app.post('/setTipSplit', async (req, res) => {
  const appId = req.body.appId
  const tipUsernames = req.body.tipUsernames

  if(!appId) {
    res.status(400).send({success: false, error: true, message: "appId is required"})
    return
  }

  if(!tipUsernames || !tipUsernames.length) {
    res.status(400).send({success: false, error: true, message: "tipUsernames is a required array"})
    return
  }

  const store = await getStoreByAppId(db, appId)

  if(!store) {
    res.status(404).send({success: false, error: true, message: "store not found"})
    return
  }

  if(tipUsernames && tipUsernames.length) {
    for (var i = tipUsernames.length - 1; i >= 0; i--) {
      const usernameExists = await fetchGetBitcoinJungleUsername(tipUsernames[i])

      if(!usernameExists) {
        res.status(400).send({success: false, error: true, message: tipUsernames[i] + " is not a valid username"})
        return
      }
    }
  }

  await clearTips(db, store.id)

  for (var i = tipUsernames.length - 1; i >= 0; i--) {
    await setTip(db, store.id, tipUsernames[i])
  }

  const data = await getTipsByAppId(db, appId)

  res.status(200).send({success: true, error: false, data: data})
  return
})

app.get('/tipLnurl/:appId', async (req, res) => {
  const appId = req.params.appId
  const amount = req.query.amount
  const comment = req.query.comment

  if(!appId || !appId.length) {
    return res.status(200).send({
      status: "ERROR",
      reason: "Invalid LNURL code",
    })
  }

  const app = await fetchGetApp(appId)

  if(!app) {
    return res.status(200).send({
      status: "ERROR",
      reason: "App not found",
    })
  }

  const internalStore = await getStoreByAppId(db, appId)

  if(!internalStore) {
    return res.status(200).send({
      status: "ERROR",
      reason: "Store not found",
    })
  }

  const store = await fetchGetStore(internalStore.storeId)

  if(!store) {
    return res.status(200).send({
      status: "ERROR",
      reason: "Store not found",
    })
  }

  if(amount) {
    const amountSats = Math.round(parseInt(amount, 10) / 1000)
    if ((amountSats * 1000).toString() !== amount) {
      return res.status(200).send({
        status: "ERROR",
        reason: "Millisatoshi amount is not supported, please send a value in full sats.",
      })
    }

    const invoice = await fetchCreateInvoice(app.storeId, amountSats, comment)
    if(!invoice) {
      return res.status(200).send({
        status: "ERROR",
        reason: "Error creating invoice.",
      })
    }

    const invoicePayments = await fetchInvoicePayments(app.storeId, invoice.id)
    const lnurlPaymentMethod = invoicePayments.find((el) => el.paymentMethod === 'BTC-LNURLPAY')

    if(!lnurlPaymentMethod) {
      return res.status(200).send({
        status: "ERROR",
        reason: "Error finding invoice.",
      })
    }

    const lightningInvoice = await fetchBtcPayServerLnUrl(invoice.id, Math.round(amountSats * 1000))

    if(!lightningInvoice) {
      return res.status(200).send({
        status: "ERROR",
        reason: "Error loading invoice.",
      })
    }

    return res.status(200).send({
      pr: lightningInvoice.pr,
      routes: [],
      successAction: {
        tag: "message",
        message: "Thank you for the tip!",
      }
    })
  }

  return res.status(200).send({
    callback: `https://btcpayserver.bitcoinjungle.app/tipLnurl/${appId}`,
    metadata: JSON.stringify([
      ["text/plain", `Paid to ${store.name}`]
    ]),
    tag: "payRequest",
    minSendable: 1000,
    maxSendable: 612000000000,
    commentAllowed: 2000
  })
})

app.get('/updateStoreAppIds', async (req, res) => {
  const stores = await getAllStores(db)
  let store, app

  for (var i = stores.length - 1; i >= 0; i--) {
    store = stores[i]

    console.log('store', store.storeId, store.bitcoinJungleUsername)

    const apps = await fetchGetApps(store.storeId)

    for(var y = apps.length - 1; y >= 0; y--) {
      app = apps[y]

      console.log('app', app.id)

      await setStoreAppId(db, store.storeId, app.id)
    }
  }

  res.status(200).send('ok')
  return
})

app.listen(port, () => {
  console.log(`Example app listening at http://localhost:${port}`)
})

app.get('/enableLnurl', async (req, res) => {
  const stores = await fetchGetAllStores()
  let store, lnUrlPaymentMethod

  for (var i = stores.length - 1; i >= 0; i--) {
    store = stores[i]

    console.log('store', store.id)

    lnUrlPaymentMethod = await fetchCreateLnUrlPaymentMethod({
      storeId: store.id,
      cryptoCode: "BTC",
      enabled: true,
      useBech32Scheme: true,
      lud12Enabled: false,
    })

    console.log('lnUrlPaymentMethod', lnUrlPaymentMethod)
  }

  res.status(200).send('ok')
  return
})

app.get('/findStores', async (req, res) => {
  const userId = req.query.userId
  const date = new Date().getUTCFullYear() + '-' + (new Date().getUTCMonth() + 1) + '-' + new Date().getUTCDate()
  const hash = req.query.hash

  if(!userId || !hash || !date) {
    res.status(400).send({success: false, error: true, message: "userId, hash and date are required"})
    return
  }

  const hashedUserId = hmacSHA256([userId, date], webhookSecret)

  if(hashedUserId !== hash) {
    console.log('invalid hash', hashedUserId, hash)
    res.status(400).send({success: false, error: true, message: "Invalid hash"})
    return
  }

  const stores = await findStoresByBbUserId(db, userId)
  let output = []

  if(stores && stores.length) {
    output = stores.map((el) => {
      const bb = JSON.parse(el.bullBitcoin)
      return {
        id: el.id,
        storeId: el.storeId,
        rate: el.rate,
        bitcoinJungleUsername: el.bitcoinJungleUsername,
        appId: el.appId,
        bullBitcoin: {
          percent: bb.percent,
          recipientId: bb.recipientId,
          userId: bb.userId,
        }
      }
    })
  }

  res.status(200).send({success: true, error: false, data: output})
  return
})

const hmacSHA256 = (data, secret) => {
  const hmac = crypto.createHmac('sha256', secret);
  hmac.update(data.join('|'));
  return hmac.digest('hex');
};

const sendEmail = async (storeOwnerEmail) => {
  const msg = {
    to: storeOwnerEmail,
    from: 'noreply@bitcoinjungle.app',
    subject: 'New Bitcoin Point of Sale Created',
    html: 'Please visit <a href="https://btcpayserver.bitcoinjungle.app/login/forgot-password">btcpayserver.bitcoinjungle.app</a> and enter ' + storeOwnerEmail + ' to create a password and log into the Point of Sale Admin system.',
  }

  return sgMail.send(msg)
    .then(() => {
      return true
    })
    .catch((error) => {
      console.error(error)

      return false
    })
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

const fetchLnUrl = async (bitcoinJungleUsername, milliSatAmount, callback) => {
  try {
    const response = await fetch(
      (!callback ? lnUrlBaseUri + ".well-known/lnurlp/" + bitcoinJungleUsername : callback) + (milliSatAmount ? "?amount=" + milliSatAmount : "")
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

const fetchBtcPayServerLnUrl = async (invoiceId, milliSatAmount) => {
  try {
    const response = await fetch(
      btcpayBaseUri + "BTC/UILNURL/pay/i/" + invoiceId + (milliSatAmount ? "?amount=" + milliSatAmount : "")
    )

    if (!response.ok) {
      return false
    }
    return await response.json()
  } catch (err) {
    console.log('fetchBtcPayServerLnUrl fail', err)
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
          htmlTitle: data.storeName + " - Point of Sale",
          defaultCurrency: data.defaultCurrency,
          defaultLang: data.defaultLanguage,
          paymentTolerance: data.paymentTolerance,
          defaultPaymentMethod: data.defaultPaymentMethod,
          customLogo: data.customLogo,
          customCSS: data.customCSS,
          lightningAmountInSatoshi: true,

          checkoutType: "V2",
          celebratePayment: true,
          showStoreHeader: true,
          showPayInWalletButton: false,
          lazyPaymentMethods: true,
          autoDetectLanguage: true,
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

const fetchCreateInvoice = async (storeId, amountSats, comment) => {
  try {
    const response = await fetch(
      btcpayBaseUri + "api/v1/stores/" + storeId + "/invoices",
      {
        method: "post",
        body: JSON.stringify({
          amount: amountSats,
          currency: "SATS",
          checkout: {
            paymentMethods: ["BTC-LNURLPAY"],
            defaultPaymentMethod: "BTC-LNURLPAY",
            lazyPaymentMethods: false,
          },
          metadata: {
            posData: {
              tip: ""+amountSats.toFixed(2),
              subTotal: ""+amountSats.toFixed(2),
              total: ""+amountSats.toFixed(2),
            },
            itemDesc: comment || "",
          },
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
    console.log('fetchCreateInvoice fail', err)
    return false
  }
}

const updateBtcPayServerRate = async (storeId, rateScript) => {
  try {
    const response = await fetch(
      btcpayBaseUri + `api/v1/stores/${storeId}/rates/configuration`,
      {
        method: "put",
        body: JSON.stringify({
          spread: "0",
          isCustomScript: true,
          effectiveScript: rateScript,
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
    console.log('updateBtcPayServerRate fail', err)
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

const fetchGetApps = async (storeId) => {
  try {
    const response = await fetch(
      btcpayBaseUri + "api/v1/stores/" + storeId + "/apps",
      {
        method: "get",
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
    console.log('fetchGetApps fail', err)
    return false
  }
}

const fetchGetApp = async (appId) => {
  try {
    const response = await fetch(
      btcpayBaseUri + "api/v1/apps/" + appId,
      {
        method: "get",
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
    console.log('fetchGetApp fail', err)
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
          role: "StoreOwner",
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

    return true
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

const fetchCreateLnUrlPaymentMethod = async (data) => {
  try {
    const response = await fetch(

      btcpayBaseUri + "api/v1/stores/" + data.storeId + "/payment-methods/LNURLPAY/" + data.cryptoCode,
      {
        method: "put",
        body: JSON.stringify({
          useBech32Scheme: data.useBech32Scheme,
          lud12Enabled: data.lud12Enabled,
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
    console.log('fetchCreateLnUrlPaymentMethod fail', err)
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

const fetchGetAllStores = async () => {
  try {
    const response = await fetch(
      btcpayBaseUri + "api/v1/stores",
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
    console.log('fetchGetAllStores fail', err)
    return false
  }
}

const fetchGetStore = async (storeId) => {
  try {
    const response = await fetch(
      btcpayBaseUri + "api/v1/stores/" + storeId,
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
    console.log('fetchGetStore fail', err)
    return false
  }
}

const createBtcPayServerApp = async (storeId, data) => {
  try {
    const response = await fetch(
      btcpayBaseUri + `api/v1/stores/${storeId}/apps/pos`,
      {
        method: "post",
        body: JSON.stringify(data),
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
    console.log('createBtcPayServerApp fail', err)
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

const getBbStores = async (db) => {
  try {
    return await db.all(
      "SELECT * FROM stores WHERE bullBitcoin is not null", 
    )
  } catch {
    return false
  }
}

const refreshBbTokens = async () => {
  console.log("refreshing bb tokens")

  const bbStores = await getBbStores(db)
  if(!bbStores) {
    console.log("no bb stores")
    return
  }

  for(const bbStore of bbStores) {
    console.log("refreshing bb token for store", bbStore.storeId)

    const bullBitcoin = JSON.parse(bbStore.bullBitcoin)

    if(bullBitcoin && bullBitcoin.token) {
      const headers = {
        'content-type': 'application/json; charset=utf-8',
        'Authorization': 'Bearer ' + bullBitcoin.token,
        'Cookie': 'bb_session_last_refreshed=' + bullBitcoin.bb_session_last_refreshed,
      };

      const body = JSON.stringify({
        jsonrpc: "2.0",
        id: "654",
        method: "getMyUser",
        params: {}
      });

      try {
        const response = await fetch(`${bullBitcoinBaseUrl}/api-users`, {
          method: 'POST',
          headers: headers,
          body: body,
        });

        const setCookieHeader = response.headers.get('set-cookie');

        if(setCookieHeader) {
          // Split the cookies and find the one for 'bb_session_last_refreshed'
          const cookies = setCookieHeader.split(';');
          const bbSessionCookie = cookies.find(cookie => cookie.trim().startsWith('bb_session_last_refreshed='));

          if (bbSessionCookie) {
            // Extract the value
            const bbSessionValue = bbSessionCookie.split('=')[1];
            console.log('bb_session_last_refreshed value:', bbSessionValue);

            // Update the store with the new bb_session_last_refreshed value
            await db.run(
              "UPDATE stores SET bullBitcoin = ? WHERE id = ?",
              [
                JSON.stringify({
                  ...bullBitcoin,
                  bb_session_last_refreshed: bbSessionValue
                }),
                bbStore.id
              ]
            )
          }
        }
      } catch (error) {
        console.error('Error refrehsing bbToken:', error);
      }
    }
  }

  console.log('done refreshing bb tokens for x bb stores', bbStores ? bbStores.length : 0)
}

setInterval(refreshBbTokens, 1000 * 60 * 60 * 24)
refreshBbTokens()

const getStoreByAppId = async (db, appId) => {
  try {
    return await db.get(
      "SELECT * FROM stores WHERE appId = ?", 
      [appId]
    )
  } catch {
    return false
  }
}

const getAllStores = async (db) => {
  try {
    return await db.all(
      "SELECT * FROM stores",
    )
  } catch {
    return false
  }
}

const getStores = async (db, bitcoinJungleUsername) => {
  try {
    return await db.all(
      "SELECT * FROM stores WHERE bitcoinJungleUsername = ?",
      [bitcoinJungleUsername] 
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

const addTipPayment = async(db, paymentId, storeId, invoiceId, timestamp, bitcoinJungleUsername, milliSatAmount) => {
  try {
    return await db.run(
      "INSERT INTO tip_payments (paymentId, storeId, invoiceId, timestamp, bitcoinJungleUsername, milliSatAmount) VALUES (?, ?, ?, ?, ?, ?)", 
      [
        paymentId,
        storeId,
        invoiceId,
        timestamp,
        bitcoinJungleUsername,
        milliSatAmount,
      ]
    )
  } catch(e) {
    console.log(e)
    return false
  }
}

const findStoresByBbUserId = async (db, bbUserId) => {
  try {
    return await db.all(
      "SELECT * FROM stores WHERE json_extract(bullBitcoin, '$.userId') = ?",
      [bbUserId]
    )
  } catch {
    return false
  }
}

const addStore = async(db, storeId, rate, bitcoinJungleUsername, bullBitcoin) => {
  try {
    return await db.run(
      "INSERT INTO stores (storeId, rate, bitcoinJungleUsername, bullBitcoin) VALUES (?, ?, ?, ?)", 
      [
        storeId,
        rate,
        bitcoinJungleUsername,
        bullBitcoin ? JSON.stringify(bullBitcoin) : null,
      ]
    )
  } catch(err) {
    console.log(err)
    return false
  }
}

const setStoreAppId = async (db, storeId, appId) => {
  try {
    return await db.run(
      "UPDATE stores SET appId = ? WHERE storeId = ?",
      [
        appId,
        storeId,
      ]
    )
  } catch {
    return false
  }
}

const clearTips = async (db, store_id) => {
  try {
    return await db.run(
      "DELETE FROM tips WHERE store_id = ?",
      [
        store_id,
      ]
    )
  } catch {
    return false
  }
}

const setTip = async (db, store_id, bitcoinJungleUsername) => {
  try {
    return await db.run(
      "INSERT INTO tips (store_id, bitcoinJungleUsername) VALUES (?, ?)", 
      [
        store_id,
        bitcoinJungleUsername
      ]
    )
  } catch(err) {
    console.log(err)
    return false
  }
}

const getTips = async (db, store_id) => {
  try {
    return await db.all(
      "SELECT * FROM tips WHERE store_id = ?",
      [
        store_id,
      ]
    )
  } catch {
    return false
  }
}

const getTipsByAppId = async (db, appId) => {
  try {
    return await db.all(
      `
      SELECT t.* 
      FROM tips t 
      JOIN stores s ON s.id = t.store_id
      WHERE s.appId = ?
      `,
      [
        appId,
      ]
    )
  } catch {
    return false
  }
}

const payLnurl = async (username, amount) => {
  // hit the LNURL endpoint for Bitcoin Jungle
  const lnUrl = await fetchLnUrl(username)

  console.log(lnUrl)

  if(!amount || amount == 0) {
    return true
  }

  if(!lnUrl) {
    console.log('no lnurl')
    return false
  }

  if(!lnUrl.callback) {
    console.log('no lnurl callback')
    return false
  }

  // use the Bitcoin Jungle LNURL endpoint to generate a bolt11 invoice for the milli-satoshi amount calculated
  const lnUrlWithAmount = await fetchLnUrl(username, amount, lnUrl.callback)

  if(!lnUrlWithAmount) {
    console.log('no lnUrlWithAmount')
    return false
  }

  if(lnUrlWithAmount.status == "ERROR") {
    return false
  }

  if(!lnUrlWithAmount.pr) {
    return false
  }
  
  const lnInvoice = await payLnInvoice(lnd, lnUrlWithAmount.pr)

  if(lnInvoice && lnInvoice.is_confirmed) {
    return lnInvoice
  }

  return false
}

const fetchGetBitcoinJungleUsername = async (username) => {
  try {
    const response = await fetch(
      "https://api.mainnet.bitcoinjungle.app/graphql",
      {
        method: "POST",
        body: "{\"operationName\":\"userDefaultWalletId\",\"variables\":{\"username\":\"" + username + "\"},\"query\":\"query userDefaultWalletId($username: Username!) {\\n  recipientWalletId: userDefaultWalletId(username: $username)\\n}\"}",
        headers: {
          "Content-Type": "application/json",
        },
      }
    )

    if (!response.ok) {
      console.log(response.status, response.statusText)
      return false
    }

    const data = await response.json()

    if(!data || !data.data || !data.data.recipientWalletId) {
      return false
    }

    return true

  } catch (err) {
    console.log('fetchGetBitcoinJungleUsername fail', err)
    return false
  }
}