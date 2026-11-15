import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { PGlite } from '@electric-sql/pglite'

const BRANCH = '00000000-0000-0000-0000-00000000000a'
const ADMIN = '00000000-0000-0000-0000-0000000000f1'
const WASH = '00000000-0000-0000-0000-0000000000a1'
const BLANKET = '00000000-0000-0000-0000-0000000000a2'
const ORDER = '00000000-0000-0000-0000-0000000000c1'

const migrationText = name => readFile(new URL(`../supabase_migrations/${name}`, import.meta.url), 'utf8')
async function functionFrom(file, signature) {
  const text = await migrationText(file)
  const start = text.indexOf(`CREATE OR REPLACE FUNCTION public.${signature}`)
  assert.ok(start >= 0, `${signature} is in ${file}`)
  return text.slice(start, text.indexOf('END $$;', start) + 'END $$;'.length)
}

// The tables the stage-correction function reads, the original functions, then
// this fix.
async function database(t) {
  const db = new PGlite()
  t.after(() => db.close())
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    CREATE TABLE public.settings (default_processing_minutes integer, eta_buffer_minutes integer, eta_min_completed_orders integer, status_undo_seconds integer);
    INSERT INTO public.settings VALUES (100, 15, 5, 60);
    CREATE TABLE public.staff (id uuid PRIMARY KEY, role text, branch_id uuid, deleted_at timestamptz);
    INSERT INTO public.staff VALUES ('${ADMIN}', 'admin', NULL, NULL);
    CREATE TABLE public.orders (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), branch_id uuid, service_type_id uuid, weight_kg numeric,
      status text, amount_paid numeric DEFAULT 0, total_price numeric DEFAULT 0, payment_status text DEFAULT 'unpaid',
      processing_started_at timestamptz, ready_at timestamptz, actual_completion timestamptz, picked_up_at timestamptz,
      estimated_processing_minutes integer, eta_source text, estimated_ready_at timestamptz,
      original_estimated_ready_at timestamptz, eta_revised_at timestamptz, eta_revision_reason text,
      last_updated_by_staff_id uuid, created_by_staff_id uuid, last_status_changed_at timestamptz, updated_at timestamptz
    );
    ALTER TABLE public.orders ADD COLUMN customer_id uuid, ADD COLUMN order_number text, ADD COLUMN priority_order integer,
      ADD COLUMN created_at timestamptz DEFAULT now();
    CREATE TABLE public.order_items (
      id uuid DEFAULT gen_random_uuid(), order_id uuid, service_type_id uuid, weight_kg numeric, status text DEFAULT 'received',
      created_at timestamptz DEFAULT now()
    );
    CREATE TABLE public.order_item_addons (order_item_id uuid, created_at timestamptz DEFAULT now());
    CREATE TABLE public.order_stage_history (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), order_id uuid, branch_id uuid, staff_id uuid, previous_status text, status text,
      transition_type text, correction_reason text, eta_before timestamptz, eta_after timestamptz, changed_at timestamptz DEFAULT now()
    );
    CREATE TABLE public.customers (id uuid PRIMARY KEY, name text, phone text, email text, branch text, created_at timestamptz, deleted_at timestamptz);
    CREATE TABLE public.customer_branches (customer_id uuid, branch_id uuid, last_served_at timestamptz);
    CREATE TABLE public.loyalty_rewards (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), customer_id uuid, earned_at timestamptz DEFAULT now());
  `)
  await db.exec(await functionFrom('20261103_branch_eta_fallback.sql', 'estimate_order_processing_minutes('))
  await db.exec(await functionFrom('20260908_order_stage_corrections.sql', 'transition_branch_order('))
  // The stage history trigger and the Orders list (part 3 of the fix updates it).
  await db.exec(await functionFrom('20260908_order_stage_corrections.sql', 'capture_order_stage_change()'))
  await db.exec('CREATE TRIGGER tr_capture_order_stage_change AFTER INSERT OR UPDATE OF status ON public.orders FOR EACH ROW EXECUTE FUNCTION public.capture_order_stage_change()')
  await db.exec(await sqlFunctionFrom('20261010_paginated_order_queue.sql', 'list_orders_page('))
  return db
}

async function sqlFunctionFrom(file, signature) {
  const text = await migrationText(file)
  const start = text.indexOf(`CREATE OR REPLACE FUNCTION public.${signature}`)
  const body = text.indexOf('AS $$', start)
  return text.slice(start, text.indexOf('\n$$;', body) + '\n$$;'.length)
}

const applyFix = async db => db.exec(await migrationText('20261115_z_correction_eta_sort_and_undo.sql'))
const minutesUntilReady = async db => Number((await db.query(
  `SELECT round(extract(epoch FROM (estimated_ready_at - now())) / 60) AS minutes FROM public.orders WHERE id = '${ORDER}'`,
)).rows[0].minutes)
const correct = (db, status) => db.query(
  'SELECT status FROM public.transition_branch_order($1, $2, $3, $4)', [ORDER, ADMIN, status, 'Started by mistake'],
)
const placeOrder = (db, minutes) => db.exec(`
  INSERT INTO public.orders(id, branch_id, service_type_id, weight_kg, status, processing_started_at, estimated_processing_minutes, estimated_ready_at)
  VALUES ('${ORDER}', '${BRANCH}', '${WASH}', 6, 'on_process', now(), ${minutes}, now() + interval '${minutes} minutes');
  INSERT INTO public.order_items(order_id, service_type_id, weight_kg) VALUES ('${ORDER}', '${WASH}', 6), ('${ORDER}', '${BLANKET}', 3);
`)

test('before the fix, every correction halved the estimate again', async t => {
  const db = await database(t)
  await placeOrder(db, 240)
  await correct(db, 'received')
  assert.equal(await minutesUntilReady(db), 120, 'back to Received promised half the time')
  await db.exec(`UPDATE public.orders SET status = 'on_process' WHERE id = '${ORDER}'`)
  await correct(db, 'received')
  assert.equal(await minutesUntilReady(db), 60, 'and halved it again')
})

test('back to Received restarts the work: a fresh, full estimate from now', async t => {
  const db = await database(t)
  await applyFix(db)
  await placeOrder(db, 240)
  await correct(db, 'received')
  // No order history at this branch: the Settings fallback (100) plus the buffer (15).
  assert.equal(await minutesUntilReady(db), 115)
  const order = (await db.query(`SELECT estimated_processing_minutes, eta_source, eta_revised_at FROM public.orders WHERE id = '${ORDER}'`)).rows[0]
  assert.equal(order.estimated_processing_minutes, 115)
  assert.equal(order.eta_source, 'revised_after_correction')
  assert.ok(order.eta_revised_at)
})

test('back from Ready to On Process uses half of a fresh estimate, and repeated corrections do not shrink it', async t => {
  const db = await database(t)
  await applyFix(db)
  await placeOrder(db, 240)
  await db.exec(`UPDATE public.orders SET status = 'ready', ready_at = now() WHERE id = '${ORDER}'`)
  await correct(db, 'on_process')
  assert.equal(await minutesUntilReady(db), 58, 'half of 115, rounded up')
  for (let round = 0; round < 3; round += 1) {
    await db.exec(`UPDATE public.orders SET status = 'ready', ready_at = now() WHERE id = '${ORDER}'`)
    await correct(db, 'on_process')
    assert.equal(await minutesUntilReady(db), 58, 'the same every time')
  }
  await correct(db, 'received')
  assert.equal(await minutesUntilReady(db), 115)
})

test('the longest service decides, using the branch\'s own history when it has enough', async t => {
  const db = await database(t)
  await applyFix(db)
  // Five finished 3 kg blanket loads at this branch, 200 minutes each.
  await db.exec(`
    INSERT INTO public.orders(branch_id, service_type_id, weight_kg, status, processing_started_at, ready_at)
    SELECT '${BRANCH}', '${BLANKET}', 3, 'released', now() - interval '1 day', now() - interval '1 day' + interval '200 minutes' FROM generate_series(1, 5);
  `)
  await placeOrder(db, 240)
  await correct(db, 'received')
  assert.equal(await minutesUntilReady(db), 215, 'blanket history (200) plus the buffer (15) is longer than the wash fallback')
})

test('the fix can be run twice', async t => {
  const db = await database(t)
  await applyFix(db)
  await applyFix(db)
  await placeOrder(db, 240)
  await correct(db, 'received')
  assert.equal(await minutesUntilReady(db), 115)
})

test('customer sorting covers every customer, not only one page', async t => {
  const db = await database(t)
  await applyFix(db)
  await db.exec(`
    INSERT INTO public.customers(id, name, phone, email, branch, created_at) VALUES
      ('00000000-0000-0000-0000-000000000001', 'Carlo Villanueva', '09170000003', NULL, 'Main', now() - interval '1 day'),
      ('00000000-0000-0000-0000-000000000002', 'Ana Reyes', '09170000001', 'ana@example.com', 'Calzada', now() - interval '3 days'),
      ('00000000-0000-0000-0000-000000000003', 'Zaldy Cruz', '09170000002', NULL, 'Nasugbu', now() - interval '2 days'),
      ('00000000-0000-0000-0000-000000000004', 'Bea Santos', '09170000004', 'bea@example.com', 'Main', now());
    INSERT INTO public.loyalty_rewards(customer_id) VALUES ('00000000-0000-0000-0000-000000000003'), ('00000000-0000-0000-0000-000000000003');
  `)
  const page = async (...args) => (await db.query('SELECT public.list_customers_page(NULL, NULL, $1, $2, $3, $4) AS page', args)).rows[0].page
  const names = result => result.data.map(customer => customer.name)

  assert.deepEqual(names(await page(2, 0, 'name', 'asc')), ['Ana Reyes', 'Bea Santos'])
  assert.deepEqual(names(await page(2, 2, 'name', 'asc')), ['Carlo Villanueva', 'Zaldy Cruz'])
  assert.deepEqual(names(await page(2, 0, 'name', 'desc')), ['Zaldy Cruz', 'Carlo Villanueva'])
  assert.deepEqual(names(await page(1, 0, 'rewards', 'desc')), ['Zaldy Cruz'])
  assert.deepEqual(names(await page(2, 0, 'email', 'asc')), ['Ana Reyes', 'Bea Santos'], 'customers without email come last')
  assert.deepEqual(names(await page(4, 0, null, 'asc')), ['Bea Santos', 'Carlo Villanueva', 'Zaldy Cruz', 'Ana Reyes'], 'no sort: newest first, as before')
  const result = await page(2, 0, 'name', 'asc')
  assert.equal(result.count, 4)
  assert.equal(Object.hasOwn(result.data[0], 'sort_text'), false, 'sorting columns are not returned')
  assert.equal(Object.hasOwn(result.data[0], 'list_position'), false)
})

// --- 3. "Move back" for staff: the list says exactly what the database allows ---
import { canStaffUndoStage, withUndoDeadline } from '../frontend/src/utils/orderStageRules.js'

const STAFF_A = '00000000-0000-0000-0000-0000000000a5'
const STAFF_B = '00000000-0000-0000-0000-0000000000b5'

async function undoDatabase(t) {
  const db = await database(t)
  await db.exec(`INSERT INTO public.staff VALUES ('${STAFF_A}', 'staff', '${BRANCH}', NULL), ('${STAFF_B}', 'staff', '${BRANCH}', NULL)`)
  await applyFix(db)
  await db.exec(`
    INSERT INTO public.orders(id, branch_id, service_type_id, weight_kg, status, order_number, created_by_staff_id)
    VALUES ('${ORDER}', '${BRANCH}', '${WASH}', 6, 'received', 'IC-1', '${ADMIN}');
    INSERT INTO public.order_items(order_id, service_type_id, weight_kg) VALUES ('${ORDER}', '${WASH}', 6);
  `)
  return db
}

// Each staff screen action and what it does to the order row.
const advance = (db, staff, status) => db.exec(`UPDATE public.orders SET status = '${status}', last_updated_by_staff_id = '${staff}' WHERE id = '${ORDER}'`)
const payment = (db, staff) => db.exec(`UPDATE public.orders SET amount_paid = COALESCE(amount_paid, 0) + 50, last_updated_by_staff_id = '${staff}', updated_at = now() WHERE id = '${ORDER}'`)

async function screenShows(db, staffId) {
  const requestedAt = Date.now()
  const order = (await db.query(`SELECT public.list_orders_page('${BRANCH}', NULL, NULL, 10, 0) AS page`)).rows[0].page.data.find(row => row.id === ORDER)
  return canStaffUndoStage(withUndoDeadline(order, requestedAt), { staffId, now: Date.now() })
}
async function databaseAllows(db, staffId) {
  const status = (await db.query(`SELECT status FROM public.orders WHERE id = '${ORDER}'`)).rows[0].status
  const target = status === 'ready' ? 'on_process' : 'received'
  await db.exec('BEGIN')
  try {
    await db.query('SELECT public.transition_branch_order($1, $2, $3, $4)', [ORDER, staffId, target, 'Undo'])
    return true
  } catch (error) {
    if (!/Only an administrator can correct this order now/.test(error.message)) throw error
    return false
  } finally {
    await db.exec('ROLLBACK')
  }
}
async function agree(db, staffId, expected, label) {
  const shown = await screenShows(db, staffId)
  const allowed = await databaseAllows(db, staffId)
  assert.equal(allowed, expected, `${label}: the database ${expected ? 'allows' : 'refuses'} it`)
  assert.equal(shown, allowed, `${label}: the screen ${allowed ? 'shows' : 'hides'} Move back`)
}

test('Move back shows for staff exactly when the database allows the undo', async t => {
  const db = await undoDatabase(t)
  await advance(db, STAFF_A, 'on_process')
  await agree(db, STAFF_A, true, 'A just started the order')
  await agree(db, STAFF_B, false, 'B did not make that change')

  await payment(db, ADMIN)
  await agree(db, STAFF_A, true, 'an administrator recorded a payment afterwards (not a stage change)')

  await advance(db, ADMIN, 'ready')
  await payment(db, STAFF_A)
  await agree(db, STAFF_A, false, 'an administrator marked it ready, then A recorded a payment')

  await advance(db, STAFF_A, 'on_process')
  await agree(db, STAFF_A, false, 'A\'s latest change was itself a correction, not an advance')
})

test('Move back for staff disappears when the undo window ends', async t => {
  const db = await undoDatabase(t)
  await db.exec('UPDATE public.settings SET status_undo_seconds = 2')
  await advance(db, STAFF_A, 'on_process')
  await agree(db, STAFF_A, true, 'within 2 seconds')
  await new Promise(resolve => setTimeout(resolve, 2500))
  await agree(db, STAFF_A, false, 'after 2 seconds')
  await advance(db, STAFF_A, 'ready')
  await agree(db, STAFF_A, true, 'A marked it ready just now')
})

test('the list tells the screen how many seconds are left, from the database clock', async t => {
  const db = await undoDatabase(t)
  await advance(db, STAFF_A, 'on_process')
  const order = (await db.query(`SELECT public.list_orders_page('${BRANCH}', NULL, NULL, 10, 0) AS page`)).rows[0].page.data[0]
  assert.equal(order.stage_undo.staff_id, STAFF_A)
  assert.ok(order.stage_undo.seconds_left >= 58 && order.stage_undo.seconds_left <= 60, `seconds left: ${order.stage_undo.seconds_left}`)
  // A shop computer whose clock is 10 minutes off still gets the right window.
  const requestedAt = Date.now() + 10 * 60_000
  const shifted = withUndoDeadline(order, requestedAt)
  assert.equal(canStaffUndoStage(shifted, { staffId: STAFF_A, now: requestedAt + 30_000 }), true)
  assert.equal(canStaffUndoStage(shifted, { staffId: STAFF_A, now: requestedAt + 61_000 }), false)
  await applyFix(db)
  const again = (await db.query(`SELECT public.list_orders_page('${BRANCH}', NULL, NULL, 10, 0) AS page`)).rows[0].page.data[0]
  assert.equal(again.stage_undo.staff_id, STAFF_A, 'running the fix twice changes nothing')
})
