export const updateStorePaymentMethod = async ({
  fetchImpl,
  baseUri,
  apiKey,
  storeId,
  paymentMethodId,
  enabled,
  config,
}) => {
  try {
    const response = await fetchImpl(
      `${baseUri}api/v1/stores/${storeId}/payment-methods/${paymentMethodId}`,
      {
        method: 'put',
        body: JSON.stringify({ enabled, config }),
        headers: {
          'Authorization': `token ${apiKey}`,
          'Content-Type': 'application/json',
        },
      }
    )

    if (!response.ok) {
      return false
    }
    return await response.json()
  } catch {
    return false
  }
}
