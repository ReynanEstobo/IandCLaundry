import { apiFetch } from './client'

export async function createBranchOrder(payload) {
  return apiFetch('/api/orders/create', { method: 'POST', body: JSON.stringify(payload) })
}

export async function cancelBranchOrder(orderId, reason) {
  return apiFetch('/api/orders/cancel', { method: 'POST', body: JSON.stringify({ orderId, reason }) })
}

export async function settleAndReleaseBranchOrder(orderId) {
  return apiFetch('/api/orders/settle-and-release', { method: 'POST', body: JSON.stringify({ orderId }) })
}

export async function collectBranchOrderPayment(orderId, amount, paymentMethod) {
  return apiFetch('/api/orders/collect-payment', { method: 'POST', body: JSON.stringify({ orderId, amount, paymentMethod }) })
}

export async function transitionBranchOrder(orderId, status, correctionReason = '') {
  return apiFetch('/api/orders/transition', { method: 'POST', body: JSON.stringify({ orderId, status, correctionReason }) })
}

export async function restockBranchInventory(payload) {
  return apiFetch('/api/inventory/restock', { method: 'POST', body: JSON.stringify(payload) })
}

export async function getVisibleCustomers() {
  return apiFetch('/api/customers/visible')
}

export async function lookupCustomerByPhone(phone) {
  return apiFetch(`/api/customers/lookup?phone=${encodeURIComponent(phone)}`)
}

export async function registerBranchCustomer(payload) {
  return apiFetch('/api/customers/register', { method: 'POST', body: JSON.stringify(payload) })
}

export async function getLoyaltyRewards() {
  return apiFetch('/api/loyalty/rewards')
}

export async function revokeLoyaltyReward(rewardId, reason) {
  return apiFetch('/api/loyalty/revoke', { method: 'POST', body: JSON.stringify({ rewardId, reason }) })
}
