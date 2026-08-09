export const calculateBtcTotal = (paymentMethods) => {
  if (!Array.isArray(paymentMethods)) {
    throw new Error('BTCPay payment-method response is not an array')
  }

  let btcPaymentMethodFound = false
  let btcTotal = 0

  paymentMethods.forEach(paymentMethod => {
    // BTCPay <=1.13 used cryptoCode. BTCPay 2.4 uses currency.
    const cryptoCode = paymentMethod.cryptoCode ?? paymentMethod.currency ?? paymentMethod.paymentMethodId?.split('-')[0]
    if (cryptoCode !== 'BTC') {
      return
    }

    btcPaymentMethodFound = true
    if (!Array.isArray(paymentMethod.payments)) {
      throw new Error('BTCPay BTC payment method has no payments array')
    }

    paymentMethod.payments.forEach(payment => {
      const value = Number.parseFloat(payment.value)
      if (!Number.isFinite(value) || value < 0) {
        throw new Error('BTCPay returned an invalid BTC payment value')
      }
      btcTotal += value
    })
  })

  if (!btcPaymentMethodFound) {
    throw new Error('BTCPay returned no BTC payment method')
  }
  if (!Number.isFinite(btcTotal) || btcTotal <= 0) {
    throw new Error('BTCPay returned a zero or invalid BTC paid total')
  }

  return btcTotal
}
