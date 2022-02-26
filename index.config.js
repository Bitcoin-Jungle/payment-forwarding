// this configures `pm2` to run the script, use like `pm2 start index.config.js`
module.exports = {
  apps: [{
    name: "paymentForwarding",
    script: "$REPLACE_ME_PATH_TO_REPO/index.js",
    interpreter : 'node@16.14.0',
    env: {
      NODE_ENV: "production",
      port: $REPLACE_ME_WITH_A_PORT,
      webhookSecret: $REPLACE_ME_WITH_SECRET_SET_IN_BTCPAYSERVER,
      dbLocation: $REPLACE_ME_ABSOLUTE_PATH_TO_DB_LOCATION,
      btcpayBaseUri: $REPLACE_ME_URL_TO_BTCPAYSERVER,
      lnUrlBaseUri: $REPLACE_ME_URL_TO_GALOY_INSTANCE_PAY_PAGE,
      btcpayApiKey: $REPLACE_ME_BTCPAYSERVER_API_KEY,
      lndTlsCert: $REPLACE_ME_LND_TLS_CERT_BASE64,
      lndMacaroon: $REPLACE_ME_LND_ADMIN_MACAROON_BASE64,
      lndIpAndPort: $REPLACE_ME_LND_PATH_AND_PORT_X.X.X.X:xxxx,
    },
  }]
}