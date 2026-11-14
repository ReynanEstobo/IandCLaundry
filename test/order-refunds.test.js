import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { PGlite } from '@electric-sql/pglite'

const MAIN = '00000000-0000-0000-0000-00000000000a'
const CALZADA = '00000000-0000-0000-0000-00000000000b'
const MAIN_STAFF = '00000000-0000-0000-0000-0000000000a1'
const CALZADA_STAFF = '00000000-0000-0000-0000-0000000000b1'

// Only the tables cancel_branch_order and the refund migration touch.
async function database(t) {
  const db = new PGlite()
  t.after(() => db.close())
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    CREATE FUNCTION uuid_generate_v4() RETURNS uuid LANGUAGE sql AS $$ SELECT gen_random_uuid() $$;
    CREATE TABLE public.branches (id uuid PRIMARY KEY, name text);
    INSERT INTO public.branches VALUES ('${MAIN}', 'Main'), ('${CALZADA}', 'Calzada');
    CREATE TABLE public.staff (id uuid PRIMARY KEY, role text, branch_id uuid, deleted_at timestamptz);
    INSERT INTO public.staff VALUES ('${MAIN_STAFF}', 'staff', '${MAIN}', NULL), ('${CALZADA_STAFF}', 'staff', '${CALZADA}', NULL);
    CREATE TABLE public.orders (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), status text, branch text, branch_id uuid,
      amount_paid numeric(12,2) DEFAULT 0, estimated_ready_at timestamptz, cancelled_at timestamptz,
      cancelled_by_staff_id uuid, cancellation_reason text, last_updated_by_staff_id uuid,
      stage_started_at timestamptz, updated_at timestamptz);
    CREATE TABLE public.inventory_items (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), current_stock numeric);
    CREATE TABLE public.inventory_usage_log (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), item_id uuid,
      quantity_used numeric, order_id uuid, reversed_at timestamptz, reversed_by_staff_id uuid);
    CREATE TABLE public.inventory_adjustments (item_id uuid, order_id uuid, branch_id uuid, quantity_change numeric,
      reason text, created_by_staff_id uuid);
    CREATE TABLE public.audit_logs (action text, table_name text, record_id uuid, actor_staff_id uuid,
      branch_id uuid, before_data jsonb, after_data jsonb);
  `)
  await db.exec(await readFile(new URL('../supabase_migrations/20261114_z_refund_cash_on_cancellation.sql', import.meta.url), 'utf8'))
  return db
}

const newOrder = async (db, paid, branchId = MAIN, branch = 'Main') =>
  (await db.query(`INSERT INTO public.orders(status, branch, branch_id, amount_paid) VALUES ('received', $1, $2, $3) RETURNING id`, [branch, branchId, paid])).rows[0].id
const cancel = (db, orderId, staffId, reason = 'Customer changed their mind') =>
  db.query('SELECT * FROM public.cancel_branch_order($1, $2, $3)', [orderId, staffId, reason])

test('cancelling a paid order records a full refund under the person who cancelled', async t => {
  const db = await database(t)
  const orderId = await newOrder(db, 180)
  const { rows: [order] } = await cancel(db, orderId, MAIN_STAFF)
  assert.equal(order.status, 'cancelled')
  assert.equal(Number(order.refunded_amount), 180)
  assert.equal(Number(order.amount_paid), 180, 'the cash received stays on record')
  const { rows: refunds } = await db.query('SELECT * FROM public.order_refunds WHERE order_id = $1', [orderId])
  assert.equal(refunds.length, 1)
  assert.equal(Number(refunds[0].amount), 180)
  assert.equal(refunds[0].refunded_by_staff_id, MAIN_STAFF)
  assert.equal(refunds[0].branch, 'Main')
  assert.equal(refunds[0].reason, 'Customer changed their mind')
  await assert.rejects(cancel(db, orderId, MAIN_STAFF), /already cancelled/)
})

test('cancelling an unpaid order records no refund', async t => {
  const db = await database(t)
  const orderId = await newOrder(db, 0)
  const { rows: [order] } = await cancel(db, orderId, MAIN_STAFF)
  assert.equal(Number(order.refunded_amount), 0)
  const { rows } = await db.query('SELECT count(*)::int AS n FROM public.order_refunds')
  assert.equal(rows[0].n, 0)
})

test('refunds cannot be edited or deleted, and staff cannot cancel another branch\'s order', async t => {
  const db = await database(t)
  await cancel(db, await newOrder(db, 120), MAIN_STAFF)
  await assert.rejects(db.query('UPDATE public.order_refunds SET amount = 1'), /cannot be changed or deleted/)
  await assert.rejects(db.query('DELETE FROM public.order_refunds'), /cannot be changed or deleted/)
  const otherBranchOrder = await newOrder(db, 90)
  await assert.rejects(cancel(db, otherBranchOrder, CALZADA_STAFF), /assigned to your branch/)
  const { rows } = await db.query('SELECT count(*)::int AS n FROM public.order_refunds')
  assert.equal(rows[0].n, 1, 'the blocked cancellation recorded no refund')
})

test('the refund migration leaves earlier cancelled orders as they are', async t => {
  const db = new PGlite()
  t.after(() => db.close())
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    CREATE FUNCTION uuid_generate_v4() RETURNS uuid LANGUAGE sql AS $$ SELECT gen_random_uuid() $$;
    CREATE TABLE public.branches (id uuid PRIMARY KEY, name text);
    CREATE TABLE public.staff (id uuid PRIMARY KEY, role text, branch_id uuid, deleted_at timestamptz);
    CREATE TABLE public.orders (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), status text, amount_paid numeric(12,2));
    INSERT INTO public.orders(status, amount_paid) VALUES ('cancelled', 150), ('released', 200);
    CREATE TABLE public.inventory_items (id uuid PRIMARY KEY);
  `)
  const migration = await readFile(new URL('../supabase_migrations/20261114_z_refund_cash_on_cancellation.sql', import.meta.url), 'utf8')
  await db.exec(migration)
  await db.exec(migration)
  const { rows } = await db.query(`SELECT status, refunded_amount::float AS refunded, (SELECT count(*)::int FROM public.order_refunds) AS refunds FROM public.orders ORDER BY status`)
  assert.deepEqual(rows.map(row => [row.status, row.refunded]), [['cancelled', 0], ['released', 0]])
  assert.equal(rows[0].refunds, 0)
})
