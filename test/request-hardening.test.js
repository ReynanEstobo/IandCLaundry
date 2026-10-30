import assert from 'node:assert/strict'
import test from 'node:test'
import worker from '../cloudflare/worker.js'
import { database } from '../backend/config/supabase.js'
import { handleData } from '../backend/controllers/dataController.js'
import { execute } from '../backend/models/databaseModel.js'

const staff = { role: 'staff', staffId: 'staff-a', branchId: 'branch-a', branch: 'Main' }
const admin = { role: 'admin', staffId: 'admin-a' }
const env = {
  RATE_LIMITER: { idFromName: name => name, get: () => ({ fetch: async () => Response.json({ allowed: true, retryAfterSeconds: 60 }) }) },
  ASSETS: { fetch: async () => new Response('not used') },
}

// Every query resolves to the given result, whatever it chains.
function databaseReturning(t, result) {
  const calls = []
  const originalFrom = database.from
  t.after(() => { database.from = originalFrom })
  database.from = table => {
    const query = new Proxy({}, {
      get: (_target, method) => method === 'then'
        ? resolve => resolve(result)
        : (...args) => { calls.push({ table, method, args }); return query },
    })
    return query
  }
  return calls
}

test('orders and inventory records are created only through their secure workflows', async t => {
  const calls = databaseReturning(t, { data: [], error: null, count: 0 })
  for (const identity of [staff, admin]) {
    for (const table of ['orders', 'inventory_items', 'inventory_restocks', 'inventory_usage_log']) {
      await assert.rejects(
        execute(table, { operation: 'insert', payload: { branch: 'Main', item_id: 'item-1', name: 'Item', weight_kg: 8 } }, identity),
        /can only be created through their secure workflow/,
      )
    }
  }
  assert.equal(calls.some(call => call.method === 'insert'), false)
  // Service configuration on the Services page still inserts through this endpoint.
  await execute('service_types', { operation: 'insert', payload: { name: 'Wash and Fold' }, returning: true }, admin)
  assert.equal(calls.some(call => call.table === 'service_types' && call.method === 'insert'), true)
})

test('malformed queries do not describe the database schema', async t => {
  for (const [error, expected] of [
    [{ code: '42703', message: 'column settings.secret_column does not exist' }, 'The request could not be processed.'],
    [{ code: 'PGRST200', message: "Could not find a relationship between 'settings' and 'staff'" }, 'The request could not be processed.'],
    [{ code: 'PGRST100', message: 'failed to parse select parameter' }, 'The request could not be processed.'],
    // Messages the app's screens show are unchanged.
    [{ code: 'P0001', message: 'You can only process service items assigned to your branch' }, 'You can only process service items assigned to your branch'],
    [{ code: '23505', message: 'duplicate key value violates unique constraint "branches_name_key"' }, 'duplicate key value violates unique constraint "branches_name_key"'],
    [{ code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned' }, 'JSON object requested, multiple (or no) rows returned'],
  ]) {
    await t.test(error.code, async t => {
      databaseReturning(t, { data: null, error, count: null })
      await assert.rejects(handleData('settings', { operation: 'select', selection: '*' }, admin), failure => {
        assert.equal(failure.status, 400)
        assert.equal(failure.message, expected)
        return true
      })
    })
  }
})

test('request bodies over 64 KB are refused even without a Content-Length header', async () => {
  const oversized = JSON.stringify({ name: 'Visitor', email: 'visitor@example.com', message: 'x'.repeat(70 * 1024) })
  const chunked = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(oversized))
      controller.close()
    },
  })
  const response = await worker.fetch(new Request('https://test.iclaundry.local/api/public/contact', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.20' }, body: chunked, duplex: 'half',
  }), env)
  assert.equal(response.status, 413)
  assert.equal((await response.json()).error, 'Request body is too large.')
})
