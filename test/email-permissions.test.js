import assert from 'node:assert/strict'
import test from 'node:test'
import { configureRuntimeEnv, database } from '../backend/config/supabase.js'
import { sendAuditedEmail } from '../backend/controllers/notificationController.js'

const staff = { staffId: 'staff-1', role: 'staff', branchId: 'main-branch', branch: 'Main Branch' }
const admin = { staffId: 'owner-1', role: 'admin', branchId: null, branch: null }

// Records relay deliveries and audit rows instead of reaching Gmail or Supabase.
function mockEmail(t) {
  const sent = []
  const originalFrom = database.from
  const originalFetch = globalThis.fetch
  t.after(() => {
    database.from = originalFrom
    globalThis.fetch = originalFetch
    configureRuntimeEnv(null)
  })
  configureRuntimeEnv({ GOOGLE_APPS_SCRIPT_EMAIL_URL: 'https://relay.example.test', EMAIL_RELAY_SECRET: 'relay-secret' })
  globalThis.fetch = async (_url, options) => {
    sent.push(JSON.parse(options.body).to)
    return Response.json({ success: true })
  }
  database.from = table => ({
    select() { return this }, eq() { return this }, insert() { return this },
    async maybeSingle() {
      assert.equal(table, 'orders')
      return { data: { id: 'order-1', order_number: 'IC-20261030-00000001', branch_id: 'main-branch', branch: 'Main Branch', order_items: [] }, error: null }
    },
    async single() { return { data: { id: `audit-${sent.length}` }, error: null } },
  })
  return sent
}

test('staff send order notifications but not free-form emails from the shop Gmail', async t => {
  const sent = mockEmail(t)
  for (const notificationType of ['order_received', 'ready_for_pickup']) {
    const result = await sendAuditedEmail({
      to: 'customer@example.com', orderId: 'order-1', notificationType,
      subject: 'Your I&C Laundry order', body: 'Tracking number: IC-20261030-00000001',
    }, staff)
    assert.equal(result.success, true)
  }
  for (const notificationType of ['manual', undefined, 'anything-else']) {
    await assert.rejects(
      sendAuditedEmail({ to: 'anyone@example.com', subject: 'Hello', body: 'Free-form message', notificationType }, staff),
      error => error.status === 403 && error.message === 'Only administrators can send custom emails.',
    )
  }
  assert.deepEqual(sent, ['customer@example.com', 'customer@example.com'])
})

test('administrators still send free-form emails', async t => {
  const sent = mockEmail(t)
  const result = await sendAuditedEmail({ to: 'supplier@example.com', subject: 'Hello', body: 'Free-form message', notificationType: 'manual' }, admin)
  assert.equal(result.success, true)
  assert.deepEqual(sent, ['supplier@example.com'])
})
