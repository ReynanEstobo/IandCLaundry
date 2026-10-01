import assert from 'node:assert/strict'
import test from 'node:test'
import { inventoryRunOutLabel, predictInventoryDaysLeft, suggestInventoryReorderQuantity } from '../frontend/src/utils/inventoryForecast.js'

test('inventory forecast uses recorded non-reversed consumption', () => {
  const item = { id: 'soap', branch_id: 'branch-1', current_stock: 12 }
  const logs = [
    { item_id: 'soap', quantity_used: 3, logged_at: '2026-09-28T08:00:00Z' },
    { item_id: 'soap', quantity_used: 3, logged_at: '2026-10-01T08:00:00Z' },
    { item_id: 'soap', quantity_used: 100, logged_at: '2026-10-01T09:00:00Z', reversed_at: '2026-10-01T10:00:00Z' },
  ]

  assert.equal(predictInventoryDaysLeft(item, logs), 6)
})

test('inventory forecast falls back to configured service usage', () => {
  const now = new Date('2026-10-01T12:00:00Z')
  const item = { id: 'bag', branch_id: 'branch-1', current_stock: 20 }
  const recipes = [{ inventory_item_id: 'bag', service_type_id: 'wash', branch_id: 'branch-1', quantity_per_load: 1 }]
  const orderItems = [
    { branch_id: 'branch-1', service_type_id: 'wash', loads: 5, created_at: '2026-09-22T12:00:00Z' },
  ]

  assert.equal(predictInventoryDaysLeft(item, [], recipes, orderItems, now), 40)
})

test('run-out label explains limited history instead of inventing a date', () => {
  assert.match(inventoryRunOutLabel(null), /more usage history/i)
  assert.match(inventoryRunOutLabel(3, new Date('2026-10-01T12:00:00Z')), /3 days.*Oct 4, 2026/i)
})

test('suggested reorder covers approximately thirty days of recorded usage', () => {
  const item = { id: 'soap', branch_id: 'branch-1', current_stock: 12, minimum_stock: 20 }
  const logs = [
    { item_id: 'soap', quantity_used: 3, logged_at: '2026-09-28T08:00:00Z' },
    { item_id: 'soap', quantity_used: 3, logged_at: '2026-10-01T08:00:00Z' },
  ]

  assert.equal(suggestInventoryReorderQuantity(item, logs), 60)
})

test('suggested reorder uses a minimum-level buffer when usage history is limited', () => {
  const item = { id: 'bags', branch_id: 'branch-1', current_stock: 8, minimum_stock: 20 }
  assert.equal(suggestInventoryReorderQuantity(item), 32)
})
