import assert from 'node:assert/strict'
import test from 'node:test'
import { database } from '../backend/config/supabase.js'
import { execute } from '../backend/models/databaseModel.js'

const staff = { role: 'staff', staffId: 'staff-a', branchId: 'branch-a', branch: 'Main' }
const admin = { role: 'admin', staffId: 'admin-a' }
const archive = { operation: 'delete', filters: [{ type: 'eq', column: 'id', value: 'customer-1' }] }

// customer_branches answers with the given branch links; every other query
// answers with the customer row. Records which tables were written.
function databaseWithLinks(t, branchIds) {
  const calls = []
  const originalFrom = database.from
  t.after(() => { database.from = originalFrom })
  database.from = table => {
    const result = table === 'customer_branches'
      ? { data: branchIds.map(branch_id => ({ branch_id })), error: null }
      : { data: [{ id: 'customer-1', branch: 'Main', branch_id: 'branch-a' }], error: null, count: 1 }
    const query = new Proxy({}, {
      get: (_target, method) => method === 'then'
        ? resolve => resolve(result)
        : (...args) => { calls.push({ table, method }); return query },
    })
    return query
  }
  return calls
}
const archived = calls => calls.some(call => call.table === 'customers' && call.method === 'update')

test('staff cannot archive a customer another branch also serves', async t => {
  const calls = databaseWithLinks(t, ['branch-a', 'branch-b'])
  await assert.rejects(execute('customers', archive, staff), /also served at another branch, so only an administrator can archive them/)
  assert.equal(archived(calls), false)
})

test('staff cannot archive a customer served only at another branch', async t => {
  const calls = databaseWithLinks(t, ['branch-b'])
  await assert.rejects(execute('customers', archive, staff), /only an administrator/)
  assert.equal(archived(calls), false)
})

test('staff can archive a customer served only at their own branch', async t => {
  const calls = databaseWithLinks(t, ['branch-a'])
  await execute('customers', archive, staff)
  assert.equal(archived(calls), true)
  assert.ok(calls.some(call => call.table === 'audit_logs' && call.method === 'insert'), 'the archive is recorded in the audit log')
})

test('an administrator can archive a shared customer', async t => {
  const calls = databaseWithLinks(t, ['branch-a', 'branch-b'])
  await execute('customers', archive, admin)
  assert.equal(archived(calls), true)
})
