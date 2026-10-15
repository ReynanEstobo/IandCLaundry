import assert from 'node:assert/strict'
import test from 'node:test'
import { getAvailableOrderAddons, resolveBranchId } from '../frontend/src/utils/orderAddons.js'

const branches = [
  { id: 'branch-a', name: 'Main - Brgy 7' },
  { id: 'branch-b', name: '2nd Branch - Brgy Calzada' },
]

test('resolves a selected branch name to its database ID without case or whitespace sensitivity', () => {
  assert.equal(resolveBranchId(branches, ' main - brgy 7 '), 'branch-a')
})

test('keeps only active add-on inventory configured for the selected branch and service', () => {
  const addons = [
    { id: 'valid', branch_id: 'branch-a', inventory_branch_id: 'branch-a', service_type_id: 'service-1' },
    { id: 'wrong-config-branch', branch_id: 'branch-b', inventory_branch_id: 'branch-a', service_type_id: 'service-1' },
    { id: 'wrong-inventory-branch', branch_id: 'branch-a', inventory_branch_id: 'branch-b', service_type_id: 'service-1' },
    { id: 'wrong-service', branch_id: 'branch-a', inventory_branch_id: 'branch-a', service_type_id: 'service-2' },
    { id: 'archived-item', branch_id: 'branch-a', inventory_branch_id: 'branch-a', service_type_id: 'service-1', inventory_deleted_at: '2026-10-01T00:00:00Z' },
  ]

  assert.deepEqual(
    getAvailableOrderAddons(addons, 'branch-a', new Set(['service-1'])).map(addon => addon.id),
    ['valid'],
  )
})

test('does not expose add-ons when the selected branch cannot be resolved', () => {
  assert.deepEqual(getAvailableOrderAddons([
    { id: 'addon', branch_id: 'branch-a', inventory_branch_id: 'branch-a', service_type_id: 'service-1' },
  ], null, ['service-1']), [])
})
