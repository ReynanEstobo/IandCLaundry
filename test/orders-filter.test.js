import assert from 'node:assert/strict'
import test from 'node:test'
import { filterOrders } from '../frontend/src/utils/filterOrders.js'

const orders = [
  { order_number: 'IC-1001', status: 'ready', customers: { name: 'Reynan Estobo' } },
  { order_number: 'IC-1002', status: 'received', customers: { name: 'Reynan Estobo' } },
  { order_number: 'IC-1003', status: 'ready', customers: { name: 'Mara Santos' } },
  { order_number: 'IC-1004', status: 'cancelled', customers: { name: 'Mara Santos' } },
]

test('search narrows orders to the selected status', () => {
  const result = filterOrders(orders, { status: 'ready', searchTerm: 'reynan' })
  assert.deepEqual(result.map(order => order.order_number), ['IC-1001'])
  assert.ok(result.every(order => order.status === 'ready'))
})

test('order-number search cannot show a result from another selected status', () => {
  const result = filterOrders(orders, { status: 'received', searchTerm: 'IC-1001' })
  assert.deepEqual(result, [])
})

test('the all-status filter still searches across every status', () => {
  const result = filterOrders(orders, { status: 'all', searchTerm: 'mara' })
  assert.deepEqual(result.map(order => order.order_number), ['IC-1003', 'IC-1004'])
})

test('search is case-insensitive and ignores surrounding whitespace', () => {
  const result = filterOrders(orders, { status: 'ready', searchTerm: '  IC-1003  ' })
  assert.deepEqual(result.map(order => order.order_number), ['IC-1003'])
})

test('a blank search returns all orders allowed by the selected status', () => {
  const result = filterOrders(orders, { status: 'cancelled', searchTerm: '   ' })
  assert.deepEqual(result.map(order => order.order_number), ['IC-1004'])
})
