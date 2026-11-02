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

export const hasStoreOwner = (storeUsers, userId) => {
  if (!Array.isArray(storeUsers)) {
    return false
  }

  return storeUsers.some(storeUser =>
    (storeUser.id === userId || storeUser.userId === userId) &&
    (storeUser.storeRole === 'Owner' || storeUser.role === 'Owner')
  )
}

const internalOnlyPaths = ['/forward', '/beds24']

export const isInternalOnlyPath = (path) =>
  internalOnlyPaths.includes(path.toLowerCase().replace(/\/+$/, ''))

export const isLoopbackAddress = (address) =>
  ['127.0.0.1', '::ffff:127.0.0.1', '::1'].includes(address)
