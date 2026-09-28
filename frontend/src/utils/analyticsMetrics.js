import { format } from 'date-fns'
import { paymentTimestamp, recordedPaymentAmount } from './businessForecast.js'

function uniqueOrders(orders = []) {
  const seen = new Set()
  return orders.filter((order, index) => {
    if (!order || order.status === 'cancelled') return false
    const identity = order.id || `row:${index}`
    if (seen.has(identity)) return false
    seen.add(identity)
    return true
  })
}

/**
 * Demand is based on orders created, while revenue is based on every valid
 * payment collection. Installments therefore cannot inflate order volume.
 */
export function analyticsDailyHistory(orders = [], payments = []) {
  const totals = new Map()
  const dayFor = date => {
    const key = format(new Date(date), 'yyyy-MM-dd')
    const current = totals.get(key) || { date: key, revenue: 0, orders: 0 }
    totals.set(key, current)
    return current
  }

  uniqueOrders(orders).forEach(order => {
    if (!order.created_at || Number.isNaN(+new Date(order.created_at))) return
    dayFor(order.created_at).orders += 1
  })

  payments.forEach(payment => {
    const paidAt = paymentTimestamp(payment)
    const amount = recordedPaymentAmount(payment)
    if (!paidAt || Number.isNaN(+new Date(paidAt)) || amount <= 0 || payment.orders?.status === 'cancelled') return
    dayFor(paidAt).revenue += amount
  })

  return [...totals.values()].sort((a, b) => a.date.localeCompare(b.date))
}

/**
 * Branch order counts come from unique orders. Payment rows contribute only
 * revenue, so a deposit plus a balance payment remains one order.
 */
export function branchPerformance(orders = [], payments = []) {
  const branches = new Map()
  const branchFor = name => {
    const key = name || 'Unassigned'
    const current = branches.get(key) || { name: key, orders: 0, revenue: 0 }
    branches.set(key, current)
    return current
  }

  uniqueOrders(orders).forEach(order => {
    branchFor(order.branch).orders += 1
  })

  payments.forEach(payment => {
    if (payment.orders?.status === 'cancelled') return
    const amount = recordedPaymentAmount(payment)
    if (amount <= 0) return
    branchFor(payment.orders?.branch || payment.branch).revenue += amount
  })

  return [...branches.values()]
}

