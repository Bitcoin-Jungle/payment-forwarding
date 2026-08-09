import test from 'node:test'
import assert from 'node:assert/strict'
import { hasStoreOwner, updateStorePaymentMethod } from './btcpay-v2-api.js'

const cases = [
  {
    paymentMethodId: 'BTC-LN',
    config: { connectionString: 'Internal Node' },
  },
  {
    paymentMethodId: 'BTC-LNURL',
    config: { useBech32Scheme: true, lud12Enabled: false },
  },
  {
    paymentMethodId: 'BTC-CHAIN',
    config: 'zpub-test',
  },
]

for (const expected of cases) {
  test(`uses the BTCPay 2.4 ${expected.paymentMethodId} endpoint and body`, async () => {
    let request
    const result = await updateStorePaymentMethod({
      fetchImpl: async (url, options) => {
        request = { url, options }
        return {
          ok: true,
          json: async () => ({ paymentMethodId: expected.paymentMethodId, enabled: true }),
        }
      },
      baseUri: 'https://btcpay.example/',
      apiKey: 'secret',
      storeId: 'store-id',
      paymentMethodId: expected.paymentMethodId,
      enabled: true,
      config: expected.config,
    })

    assert.equal(request.url, `https://btcpay.example/api/v1/stores/store-id/payment-methods/${expected.paymentMethodId}`)
    assert.equal(request.options.method, 'put')
    assert.deepEqual(JSON.parse(request.options.body), { enabled: true, config: expected.config })
    assert.equal(result.paymentMethodId, expected.paymentMethodId)
  })
}

test('reports a rejected BTCPay update as failure', async () => {
  const result = await updateStorePaymentMethod({
    fetchImpl: async () => ({ ok: false }),
    baseUri: 'https://btcpay.example/',
    apiKey: 'secret',
    storeId: 'store-id',
    paymentMethodId: 'BTC-LN',
    enabled: true,
    config: { connectionString: 'Internal Node' },
  })

  assert.equal(result, false)
})

test('recognizes an existing v2.4 store owner', () => {
  assert.equal(hasStoreOwner([{ id: 'user-id', storeRole: 'Owner' }], 'user-id'), true)
})

test('keeps compatibility with legacy store-user fields', () => {
  assert.equal(hasStoreOwner([{ userId: 'user-id', role: 'Owner' }], 'user-id'), true)
})

test('does not accept a non-owner membership', () => {
  assert.equal(hasStoreOwner([{ id: 'user-id', storeRole: 'Manager' }], 'user-id'), false)
})
