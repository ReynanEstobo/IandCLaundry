// "Not ready yet" correction emails for orders marked ready by mistake.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import { database } from '../backend/config/supabase.js'
import { readyCorrectionMessage, retryEmailDelivery, sendReadyCorrectionEmail } from '../backend/controllers/notificationController.js'

const admin = { role: 'admin', staffId: 'admin-a' }
const source = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8')
const migration = name => readFile(new URL(`../supabase_migrations/${name}`, import.meta.url), 'utf8')

// Answers each table from `tables` (rows, or a function of that query's calls)
// and records the calls.
function fakeDatabase(t, tables = {}) {
  const calls = []
  const originalFrom = database.from
  t.after(() => { database.from = originalFrom })
  database.from = table => {
    const own = []
    const answer = () => {
      const entry = tables[table]
      const rows = typeof entry === 'function' ? entry(own) : (entry ?? [])
      const single = own.some(call => ['single', 'maybeSingle'].includes(call.method))
      return { data: single ? (rows[0] ?? null) : rows, error: null, count: rows.length }
    }
    const query = new Proxy({}, {
      get: (_target, method) => method === 'then'
        ? (resolve, reject) => Promise.resolve(answer()).then(resolve, reject)
        : (...args) => { const call = { table, method, args }; own.push(call); calls.push(call); return query },
    })
    return query
  }
  return calls
}

test('the database accepts the correction email type and still refuses unknown types', async t => {
  const db = new PGlite()
  t.after(() => db.close())
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    CREATE FUNCTION uuid_generate_v4() RETURNS UUID LANGUAGE sql AS $$ SELECT gen_random_uuid() $$;
    CREATE TABLE branches (id UUID PRIMARY KEY); CREATE TABLE staff (id UUID PRIMARY KEY); CREATE TABLE orders (id UUID PRIMARY KEY);
  `)
  await db.exec(await migration('20261002_email_delivery_audit.sql'))
  const fix = await migration('20261115_zz_ready_correction_email.sql')
  await db.exec(fix)
  await db.exec(fix)
  const insert = type => db.query(`INSERT INTO email_delivery_audit (notification_type, recipient_email, subject, message_body, garment_details, status)
    VALUES ($1, 'customer@example.com', 'Subject', 'Body', '[]', 'sent')`, [type])
  await insert('ready_correction')
  await insert('ready_for_pickup')
  await assert.rejects(insert('something_else'), /email_delivery_audit_notification_type_check/)
})

test('the correction email apologises, says not to come yet, and gives the new pickup time', () => {
  const message = readyCorrectionMessage({ customerName: 'Leonora Castro', orderNumber: 'IC-20261115-00001585', estimatedReadyAt: '2026-11-15T12:30:00Z' })
  assert.equal(message.subject, 'Correction: your I&C Laundry order IC-20261115-00001585 is not ready yet')
  assert.match(message.body, /^Hello Leonora Castro,/)
  assert.match(message.body, /sent by mistake/)
  assert.match(message.body, /please do not come to the shop for it yet/)
  assert.match(message.body, /New estimated pickup time: November 15(,| at) 8:30\s?PM/, 'in Philippine time')
  assert.match(readyCorrectionMessage({ orderNumber: 'IC-1' }).body, /^Hello Customer,[\s\S]*pickup time: to be confirmed/)
})

test('no correction is sent when no ready email reached the customer', async t => {
  const calls = fakeDatabase(t, { email_delivery_audit: [] })
  assert.deepEqual(await sendReadyCorrectionEmail('order-1', admin), { status: 'not_needed' })
  const audit = calls.filter(call => call.table === 'email_delivery_audit')
  assert.ok(audit.some(call => call.method === 'eq' && call.args[0] === 'status' && call.args[1] === 'sent'), 'only emails that were actually sent count')
  assert.equal(calls.some(call => call.method === 'insert'), false, 'nothing is sent or recorded')
})

test('no second correction is sent when the latest email was already a correction', async t => {
  fakeDatabase(t, { email_delivery_audit: [{ notification_type: 'ready_correction', recipient_email: 'c@example.com', attempted_at: '2026-11-15T07:00:00Z' }] })
  assert.deepEqual(await sendReadyCorrectionEmail('order-1', admin), { status: 'not_needed' })
})

test('a failed email that no longer matches the order is not retried', async t => {
  const failedReady = { id: 'd1', status: 'failed', notification_type: 'ready_for_pickup', order_id: 'o1', recipient_email: 'c@example.com', subject: 'Ready', attempted_at: '2026-11-15T07:00:00Z', branch_id: null }
  fakeDatabase(t, { email_delivery_audit: [failedReady], orders: [{ id: 'o1', status: 'on_process' }] })
  await assert.rejects(retryEmailDelivery({ deliveryId: 'd1' }, admin),
    error => error.status === 409 && /now On Process, so this email no longer matches it/.test(error.message))
})

test('a failed correction is not retried once the order is ready again', async t => {
  const failedCorrection = { id: 'd2', status: 'failed', notification_type: 'ready_correction', order_id: 'o1', recipient_email: 'c@example.com', subject: 'Correction', attempted_at: '2026-11-15T07:00:00Z', branch_id: null }
  fakeDatabase(t, { email_delivery_audit: [failedCorrection], orders: [{ id: 'o1', status: 'ready' }] })
  await assert.rejects(retryEmailDelivery({ deliveryId: 'd2' }, admin), /now Ready for Pick-up/)
})

test('moving an order back from Ready sends the correction and tells staff the result', async () => {
  const route = await source('backend/controllers/operationController.js')
  assert.match(route, /order\.status === 'ready' && nextStatus === 'on_process'[\s\S]{0,300}sendReadyCorrectionEmail\(orderId, identity\)/)
  assert.match(route, /return \{ data, readyCorrection \}/)
  const orders = await source('frontend/src/pages/Orders.jsx')
  assert.match(orders, /order\.status === "ready" && newStatus === "on_process"\) reportReadyCorrection\(order, transition\?\.readyCorrection\)/)
  assert.match(orders, /Correction email sent to \$\{correction\.to\}/)
  assert.match(orders, /reminder: "correction_failed"/)
  assert.match(orders, /reminder: "correction_manual"/)
  assert.match(orders, /Tell the customer it is not ready yet/)
  const audit = await source('frontend/src/pages/SMS.jsx')
  assert.match(audit, /ready_correction: "Not ready yet \(correction\)"/)
  assert.match(audit, /delivery\.order_moved_on/)
})

test('failed-email messages point staff to an administrator, since only admins can open Delivery Audit', async () => {
  const orders = await source('frontend/src/pages/Orders.jsx')
  assert.match(orders, /An administrator can retry it from Notifications → Delivery Audit\./)
  assert.match(orders, /You can retry it from Notifications → Delivery Audit\./)
  assert.equal((orders.match(/\$\{retryNote\(isAdmin\)\}/g) || []).length, 3, 'ready, confirmation and correction failures')
  assert.doesNotMatch(orders, /or retry it from Notifications|you can also retry it/)
})
