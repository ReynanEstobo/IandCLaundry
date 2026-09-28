import assert from 'node:assert/strict'
import test from 'node:test'
import { analyticsDailyHistory, branchPerformance } from '../frontend/src/utils/analyticsMetrics.js'

test('analytics counts an order once when it has a deposit and balance payment', () => {
  const orders = [
    { id: 'order-1', branch: 'Main', status: 'released', created_at: '2026-09-01T08:00:00' },
  ]
  const payments = [
    { order_id: 'order-1', amount: 100, paid_at: '2026-09-01T09:00:00', orders: { id: 'order-1', branch: 'Main', status: 'released' } },
    { order_id: 'order-1', amount: 100, paid_at: '2026-09-03T09:00:00', orders: { id: 'order-1', branch: 'Main', status: 'released' } },
  ]

  assert.deepEqual(branchPerformance(orders, payments), [{ name: 'Main', orders: 1, revenue: 200 }])
  const history = analyticsDailyHistory(orders, payments)
  assert.equal(history.reduce((sum, day) => sum + day.orders, 0), 1)
  assert.equal(history.reduce((sum, day) => sum + day.revenue, 0), 200)
})

test('analytics deduplicates repeated order rows but retains every valid payment', () => {
  const order = { id: 'order-1', branch: 'Main', status: 'received', created_at: '2026-09-01T08:00:00' }
  const payments = [
    { amount: 50, paid_at: '2026-09-01T09:00:00', orders: { id: 'order-1', branch: 'Main', status: 'received' } },
    { amount: 25, paid_at: '2026-09-01T10:00:00', orders: { id: 'order-1', branch: 'Main', status: 'received' } },
  ]

  assert.deepEqual(branchPerformance([order, { ...order }], payments), [{ name: 'Main', orders: 1, revenue: 75 }])
  assert.deepEqual(analyticsDailyHistory([order, { ...order }], payments), [
    { date: '2026-09-01', revenue: 75, orders: 1 },
  ])
})

test('cancelled orders and their payments do not enter analytics', () => {
  const order = { id: 'cancelled-1', branch: 'Main', status: 'cancelled', created_at: '2026-09-01T08:00:00' }
  const payment = { amount: 100, paid_at: '2026-09-01T09:00:00', orders: { id: order.id, branch: 'Main', status: 'cancelled' } }

  assert.deepEqual(branchPerformance([order], [payment]), [])
  assert.deepEqual(analyticsDailyHistory([order], [payment]), [])
})
