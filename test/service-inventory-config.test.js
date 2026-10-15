import test from 'node:test'
import assert from 'node:assert/strict'
import { findInvalidServiceInventoryConfigs } from '../frontend/src/utils/serviceInventoryConfig.js'

test('flags active checklist entries whose inventory item belongs to another branch', () => {
  const invalid = findInvalidServiceInventoryConfigs(
    [{ id: 'recipe-1', branch_id: 'branch-a', inventory_item_id: 'item-1', is_active: true }],
    [{ id: 'item-1', name: 'Detergent', branch_id: 'branch-b' }],
  )

  assert.equal(invalid.length, 1)
  assert.equal(invalid[0].inventory_name, 'Detergent')
  assert.match(invalid[0].invalid_reason, /different branch/)
})

test('flags archived or missing inventory items and ignores inactive configuration rows', () => {
  const invalid = findInvalidServiceInventoryConfigs(
    [
      { id: 'archived', branch_id: 'branch-a', inventory_item_id: 'item-1', is_active: true },
      { id: 'missing', branch_id: 'branch-a', inventory_item_id: 'item-2', is_active: true },
      { id: 'inactive', branch_id: 'branch-a', inventory_item_id: 'item-3', is_active: false },
    ],
    [{ id: 'item-1', name: 'Fabcon', branch_id: 'branch-a', deleted_at: '2026-10-01T00:00:00Z' }],
  )

  assert.deepEqual(invalid.map(row => [row.id, row.invalid_reason]), [
    ['archived', 'Inventory item is archived'],
    ['missing', 'Inventory item no longer exists'],
  ])
})

