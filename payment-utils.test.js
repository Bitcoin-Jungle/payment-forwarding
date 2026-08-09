import test from 'node:test'
import assert from 'node:assert/strict'
import { calculateBtcTotal } from './payment-utils.js'

test('reads the BTCPay 2.4 payment-method response', () => {
  const total = calculateBtcTotal([{
    currency: 'BTC',
    paymentMethodId: 'BTC-LN',
    payments: [{ value: '0.00000711', status: 'Settled' }]
  }])

  assert.equal(total, 0.00000711)
})

test('keeps compatibility with the BTCPay 1.13 response', () => {
  const total = calculateBtcTotal([{
    cryptoCode: 'BTC',
    payments: [{ value: '0.00000100' }, { value: '0.00000200' }]
  }])

  assert.equal(total, 0.000003)
})

test('falls back to paymentMethodId when needed', () => {
  const total = calculateBtcTotal([{
    paymentMethodId: 'BTC-CHAIN',
    payments: [{ value: '0.00000400' }]
  }])

  assert.equal(total, 0.000004)
})

test('fails closed when BTCPay reports no paid BTC', () => {
  assert.throws(
    () => calculateBtcTotal([{ currency: 'BTC', payments: [] }]),
    /zero or invalid BTC paid total/
  )
})

test('fails closed on an unknown response shape', () => {
  assert.throws(
    () => calculateBtcTotal([{ payments: [{ value: '0.00000711' }] }]),
    /no BTC payment method/
  )
})

test('fails closed on an invalid payment value', () => {
  assert.throws(
    () => calculateBtcTotal([{ currency: 'BTC', payments: [{ value: 'not-a-number' }] }]),
    /invalid BTC payment value/
  )
})
