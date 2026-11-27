import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import { database } from '../backend/config/supabase.js'
import { createOrder, updateOrderItemSupplies } from '../backend/controllers/operationController.js'
import { describeAuditEvent } from '../backend/controllers/auditController.js'
import {
  choicesFromRecorded, serviceLoads, serviceRecipe, supplyCharge, supplyChoiceProblem, supplyChoicesPayload,
} from '../frontend/src/utils/orderSupplies.js'

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8')
const MIGRATION = 'supabase_migrations/20261127_supply_replacements_and_charges.sql'

// The small order database of the supply-choice tests, with the cash-refund
// cancellation, the 20261126 supply choices, and this migration (run twice).
async function orderDatabase(t) {
  const db = new PGlite()
  t.after(() => db.close())
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    CREATE FUNCTION uuid_generate_v4() RETURNS uuid LANGUAGE sql AS $$ SELECT gen_random_uuid() $$;
    CREATE SCHEMA auth;
    CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql AS $$ SELECT 'authenticated'::text $$;
    CREATE FUNCTION current_staff_role() RETURNS text LANGUAGE sql AS $$ SELECT 'admin'::text $$;
    CREATE FUNCTION current_staff_branch_id() RETURNS uuid LANGUAGE sql AS $$ SELECT NULL::uuid $$;
    CREATE TABLE branches (id uuid PRIMARY KEY DEFAULT uuid_generate_v4(), name text, is_active boolean DEFAULT true);
    CREATE TABLE staff (id uuid PRIMARY KEY DEFAULT uuid_generate_v4(), role text, branch_id uuid, deleted_at timestamptz);
    CREATE TABLE customers (id uuid PRIMARY KEY DEFAULT uuid_generate_v4(), name text, phone text, email text,
      notes text, branch text, branch_id uuid, created_by_staff_id uuid, deleted_at timestamptz);
    CREATE TABLE service_types (id uuid PRIMARY KEY DEFAULT uuid_generate_v4(), name text, price_per_kg numeric DEFAULT 0,
      estimated_minutes integer DEFAULT 60, description text, is_active boolean DEFAULT true,
      created_at timestamptz DEFAULT now(), deleted_at timestamptz);
    CREATE TABLE settings (bundlekg numeric, bundleprice numeric, excesskgprice numeric, loyalty_enabled boolean,
      loyalty_discount_milestone integer, loyalty_free_load_milestone integer, loyalty_discount_percent integer,
      loyalty_reward_expiry_days integer, loyalty_program_started_at timestamptz);
    INSERT INTO settings VALUES (8,200,30,false,5,10,50,180,now());
    CREATE TABLE orders (id uuid PRIMARY KEY DEFAULT uuid_generate_v4(), customer_id uuid, service_type_id uuid,
      weight_kg numeric, total_price numeric, addons jsonb DEFAULT '{}'::jsonb, notes text, payment_method text,
      payment_status text, amount_paid numeric, branch text, branch_id uuid, created_by_staff_id uuid,
      last_updated_by_staff_id uuid, status text, estimated_processing_minutes integer, eta_source text,
      estimated_ready_at timestamptz, loyalty_original_total numeric, loyalty_discount_amount numeric,
      loyalty_reward_id uuid, processing_started_at timestamptz, ready_at timestamptz,
      actual_completion timestamptz, picked_up_at timestamptz, cancelled_by_staff_id uuid,
      stage_started_at timestamptz, order_number text,
      created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now());
    CREATE TABLE payments (id uuid PRIMARY KEY DEFAULT uuid_generate_v4(), notes text);
    CREATE TABLE inventory_items (id uuid PRIMARY KEY DEFAULT uuid_generate_v4(), name text, unit text,
      current_stock numeric, branch text, branch_id uuid, deleted_at timestamptz);
    CREATE TABLE inventory_usage_log (id uuid PRIMARY KEY DEFAULT uuid_generate_v4(), item_id uuid,
      quantity_used numeric, order_id uuid, logged_at timestamptz DEFAULT now());
    CREATE TABLE inventory_adjustments (id uuid PRIMARY KEY DEFAULT uuid_generate_v4(), item_id uuid, order_id uuid,
      branch_id uuid, quantity_change numeric, reason text, created_by_staff_id uuid, created_at timestamptz DEFAULT now());
    CREATE TABLE loyalty_rewards (id uuid PRIMARY KEY DEFAULT uuid_generate_v4(), customer_id uuid,
      earned_order_id uuid, reward_type text, status text, discount_percent integer, free_load_kg numeric,
      expires_at timestamptz, redeemed_at timestamptz, redeemed_order_id uuid);
    CREATE TABLE customer_branches (customer_id uuid, branch_id uuid, first_served_at timestamptz,
      last_served_at timestamptz, order_count integer, UNIQUE(customer_id, branch_id));
    CREATE TABLE audit_logs (id uuid PRIMARY KEY DEFAULT uuid_generate_v4(), action text, table_name text,
      record_id uuid, actor_staff_id uuid, branch_id uuid, before_data jsonb, after_data jsonb,
      event_type text NOT NULL DEFAULT 'legacy', event_category text NOT NULL DEFAULT 'data_change',
      changed_fields jsonb NOT NULL DEFAULT '{}'::jsonb, reason text, source text NOT NULL DEFAULT 'application',
      created_at timestamptz DEFAULT now());
    CREATE FUNCTION capture_audit_change() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN COALESCE(NEW, OLD); END $$;
    CREATE FUNCTION estimate_order_processing_minutes(uuid, uuid, numeric)
      RETURNS TABLE(minutes integer, source text) LANGUAGE sql AS $$ SELECT 120, 'branch_default'::text $$;
  `)
  for (const name of [
    '20260907_order_cancellation', '20260926_multi_service_per_load', '20261001_remove_note_fields',
    '20261001_z_cash_only_payments', '20261003_service_inventory_integrity', '20261004_delink_archived_service_inventory',
    '20261005_preserve_order_addon_history', '20261006_preserve_archived_order_addon_history',
    '20261008_reject_order_overpayment', '20261012_optional_order_email_and_payment_followup',
    '20261013_optional_customer_email_constraint', '20261114_z_refund_cash_on_cancellation',
    '20261126_customer_supply_choices',
  ]) await db.exec(await read(`supabase_migrations/${name}.sql`))
  // The live Audit Log accepts these actions (20260916_strict_validation_and_audit_trail).
  await db.exec(`ALTER TABLE audit_logs DROP CONSTRAINT IF EXISTS audit_logs_action_check;
    ALTER TABLE audit_logs ADD CONSTRAINT audit_logs_action_check CHECK (action IN ('insert', 'update', 'delete', 'restore',
      'cancel', 'provision', 'credentials_reset', 'password_changed', 'email_changed', 'order_transition',
      'payment_collected', 'inventory_restock', 'inventory_adjustment', 'system'));`)
  const migration = await read(MIGRATION)
  await db.exec(migration)
  await db.exec(migration)
  return db
}

// One branch with Wash & Fold (8 kg loads, ₱200) whose usual supplies are one
// Ariel, one Downy and one plastic bag per load, and its approved options.
async function shop(db) {
  const ids = Object.fromEntries(['branch', 'other', 'staff', 'service', 'otherService', 'ariel', 'tide', 'liquid', 'breeze', 'downy', 'bag', 'hanger']
    .map(key => [key, randomUUID()]))
  await db.query("INSERT INTO branches(id,name) VALUES ($1,'Main'),($2,'Calzada')", [ids.branch, ids.other])
  await db.query("INSERT INTO staff(id,role,branch_id) VALUES ($1,'admin',$2)", [ids.staff, ids.branch])
  await db.query("INSERT INTO service_types(id,name,bundle_kg,bundle_price,excess_kg_price,processing_type) VALUES ($1,'Wash & Fold',8,200,25,'full_service'),($2,'Comforter',5,350,50,'full_service')", [ids.service, ids.otherService])
  const item = (id, name, unit, stock, branchId) => db.query('INSERT INTO inventory_items(id,name,unit,current_stock,branch,branch_id) VALUES ($1,$2,$3,$4,$5,$6)', [id, name, unit, stock, branchId === ids.branch ? 'Main' : 'Calzada', branchId])
  await item(ids.ariel, 'Ariel', 'sachets', 20, ids.branch)
  await item(ids.tide, 'Tide', 'sachets', 10, ids.branch)
  await item(ids.liquid, 'Liquid Detergent', 'mL', 1000, ids.branch)
  await item(ids.breeze, 'Breeze', 'sachets', 10, ids.other)
  await item(ids.downy, 'Downy', 'sachets', 20, ids.branch)
  await item(ids.bag, 'Plastic Bag', 'pcs', 20, ids.branch)
  await item(ids.hanger, 'Hanger', 'pcs', 20, ids.branch)
  const recipe = async (itemId, serviceId = ids.service) => (await db.query('INSERT INTO service_inventory_requirements(branch_id,service_type_id,inventory_item_id,quantity_per_load) VALUES ($1,$2,$3,1) RETURNING id', [ids.branch, serviceId, itemId])).rows[0].id
  ids.arielLine = await recipe(ids.ariel)
  ids.downyLine = await recipe(ids.downy)
  ids.bagLine = await recipe(ids.bag)
  ids.comforterLine = await recipe(ids.ariel, ids.otherService)
  // A detergent may not be left out; the customer may not bring their own bag.
  await db.query('UPDATE service_inventory_requirements SET allow_leave_out = false WHERE id = $1', [ids.arielLine])
  await db.query('UPDATE service_inventory_requirements SET allow_customer_own = false WHERE id = $1', [ids.bagLine])
  const approve = async (line, itemId, perLoad, charge) => (await db.query(
    'INSERT INTO service_supply_replacements(requirement_id,branch_id,service_type_id,replacement_item_id,quantity_per_load,extra_charge_per_load) VALUES ($1,$2,$2,$3,$4,$5) RETURNING id',
    [line, ids.branch, itemId, perLoad, charge])).rows[0].id
  ids.tideOption = await approve(ids.arielLine, ids.tide, 1, 10) // +₱10 per load
  ids.liquidOption = await approve(ids.arielLine, ids.liquid, 60, 0) // 60 mL per load, no charge
  ids.comforterTide = await approve(ids.comforterLine, ids.tide, 1, 15)
  return ids
}

const stockOf = async (db, id) => Number((await db.query('SELECT current_stock FROM inventory_items WHERE id=$1', [id])).rows[0].current_stock)
const stocks = (db, ids, keys) => Promise.all(keys.map(key => stockOf(db, ids[key])))

function placeOrder(db, ids, { weight = 8, supplies, extra = [], requestId = randomUUID(), paid = 0, phone = '09171234567' } = {}) {
  const item = { service_type_id: ids.service, weight_kg: weight, ...(supplies && { supplies }) }
  const order = { client_request_id: requestId, amount_paid: paid, payment_method: 'cash', items: [item, ...extra] }
  return db.query('SELECT (create_branch_order($1,$2,$3::jsonb,$4::jsonb,$5::jsonb,1,NULL)).* ', [
    ids.branch, ids.staff, JSON.stringify({ name: 'Ana Cruz', phone }), JSON.stringify(order), '{}',
  ]).then(result => result.rows[0])
}

const itemOf = async (db, orderId) => (await db.query('SELECT * FROM order_items WHERE order_id=$1 ORDER BY created_at', [orderId])).rows[0]
const changeSupplies = (db, ids, itemId, supplies) => db.query('SELECT * FROM update_order_item_supplies($1,$2,$3::jsonb)', [itemId, ids.staff, JSON.stringify(supplies)]).then(result => result.rows[0])
const recorded = async (db, orderId) => (await db.query(`SELECT s.choice, s.used_item_name_snapshot AS used, s.quantity::float AS quantity,
    s.extra_charge::float AS charge FROM order_item_supplies s JOIN order_items oi ON oi.id = s.order_item_id
  WHERE oi.order_id = $1 ORDER BY s.default_item_name_snapshot`, [orderId])).rows
const supplyAudit = async (db, orderId) => (await db.query("SELECT action, before_data, after_data FROM audit_logs WHERE record_id=$1 AND event_type='order_supplies_changed' ORDER BY created_at", [orderId])).rows

test('scenario 1–2: an approved replacement adds its charge per load and takes its own amount', async t => {
  const db = await orderDatabase(t)
  const ids = await shop(db)
  const order = await placeOrder(db, ids, { weight: 16, supplies: [{ requirement_id: ids.arielLine, choice: 'substitute', replacement_id: ids.tideOption }] })
  assert.equal(Number(order.total_price), 420, '₱400 for two loads plus ₱10 per load for Tide')
  assert.equal(Number((await itemOf(db, order.id)).supply_charge), 20)
  assert.deepEqual(await stocks(db, ids, ['ariel', 'tide', 'downy', 'bag']), [20, 8, 18, 18])
  assert.deepEqual(await recorded(db, order.id), [{ choice: 'substitute', used: 'Tide', quantity: 2, charge: 20 }])
  const [entry] = await supplyAudit(db, order.id)
  assert.equal(entry.action, 'insert')
  assert.equal(describeAuditEvent({ ...entry, event_type: 'order_supplies_changed', table_name: 'order_item_supplies', branch: { name: 'Main' } }),
    'Supplies changed for the customer on an order at Main: Ariel → Tide (+₱20.00).')

  const free = await placeOrder(db, ids, { supplies: [{ requirement_id: ids.arielLine, choice: 'substitute', replacement_id: ids.liquidOption }] })
  assert.equal(Number(free.total_price), 200, 'a replacement approved with no charge keeps the price')
})

test('scenario 7 and 18: the amount and the charge come from the settings, never from the request', async t => {
  const db = await orderDatabase(t)
  const ids = await shop(db)
  const order = await placeOrder(db, ids, { weight: 16, supplies: [{ requirement_id: ids.arielLine, choice: 'substitute', replacement_id: ids.liquidOption, quantity: 1, extra_charge_per_load: -50, quantity_per_load: 1 }] })
  assert.equal(await stockOf(db, ids.liquid), 880, '60 mL per load for two loads, whatever amount was sent')
  assert.equal(Number(order.total_price), 400)
  // An older form that sends the item instead of the approved option still works, and only for approved items.
  const legacy = await placeOrder(db, ids, { supplies: [{ requirement_id: ids.arielLine, choice: 'substitute', item_id: ids.tide, quantity: 9 }] })
  assert.equal(Number(legacy.total_price), 210)
  assert.equal(await stockOf(db, ids.tide), 9)
})

test('scenario 3–4 and 8: only what the Administrator allows is accepted, and nothing is taken when refused', async t => {
  const db = await orderDatabase(t)
  const ids = await shop(db)
  const own = await placeOrder(db, ids, { supplies: [{ requirement_id: ids.downyLine, choice: 'customer_own' }, { requirement_id: ids.bagLine, choice: 'none' }] })
  assert.equal(Number(own.total_price), 200, "the customer's own supply and a left-out one keep the price")
  assert.deepEqual(await stocks(db, ids, ['ariel', 'downy', 'bag']), [19, 20, 20])
  for (const [supplies, message] of [
    [[{ requirement_id: ids.arielLine, choice: 'none' }], /Ariel cannot be left out for this service/],
    [[{ requirement_id: ids.bagLine, choice: 'customer_own' }], /cannot bring their own Plastic Bag/],
    [[{ requirement_id: ids.arielLine, choice: 'substitute', item_id: ids.hanger }], /not an approved replacement for Ariel/],
    [[{ requirement_id: ids.downyLine, choice: 'substitute', replacement_id: ids.tideOption }], /not an approved replacement for Downy/],
    [[{ requirement_id: ids.arielLine, choice: 'substitute', replacement_id: ids.comforterTide }], /not an approved replacement for Ariel/],
    [[{ requirement_id: ids.arielLine, choice: 'substitute' }], /not an approved replacement/],
    [[{ requirement_id: ids.comforterLine, choice: 'customer_own' }], /no longer matches this service/],
  ]) await assert.rejects(placeOrder(db, ids, { supplies }), message)
  assert.deepEqual(await stocks(db, ids, ['ariel', 'tide', 'liquid', 'downy', 'bag']), [19, 10, 1000, 20, 20])
  assert.equal((await db.query('SELECT count(*)::int AS n FROM orders')).rows[0].n, 1)
})

test('scenario 6, 9 and 16: stock of a replacement is checked across services, and archived or paused options are refused', async t => {
  const db = await orderDatabase(t)
  const ids = await shop(db)
  const comforter = { service_type_id: ids.otherService, weight_kg: 5, supplies: [{ requirement_id: ids.comforterLine, choice: 'substitute', replacement_id: ids.comforterTide }] }
  const wash = [{ requirement_id: ids.arielLine, choice: 'substitute', replacement_id: ids.tideOption }]
  await db.query('UPDATE inventory_items SET current_stock = 1 WHERE id = $1', [ids.tide])
  await assert.rejects(placeOrder(db, ids, { supplies: wash, extra: [comforter] }), /Tide has only 1(\.0+)? sachets remaining; 2(\.0+)? sachets is required for this order/)
  await db.query('UPDATE inventory_items SET current_stock = 10 WHERE id = $1', [ids.tide])
  const order = await placeOrder(db, ids, { supplies: wash, extra: [comforter] })
  assert.equal(Number(order.total_price), 200 + 350 + 10 + 15, 'each service adds its own replacement charge')
  assert.equal(await stockOf(db, ids.tide), 8)
  await db.query('UPDATE service_supply_replacements SET is_active = false WHERE id = $1', [ids.tideOption])
  await assert.rejects(placeOrder(db, ids, { supplies: wash }), /not an approved replacement/)
  await db.query('UPDATE service_supply_replacements SET is_active = true WHERE id = $1', [ids.tideOption])
  await db.query('UPDATE inventory_items SET deleted_at = now() WHERE id = $1', [ids.tide])
  await assert.rejects(placeOrder(db, ids, { supplies: wash }), /not an approved replacement/)
})

test('scenario 10–11: a percentage reward also discounts the supply charge; a free load covers only the service', async t => {
  const db = await orderDatabase(t)
  const ids = await shop(db)
  await db.query('UPDATE settings SET loyalty_enabled = true, loyalty_discount_milestone = 1, loyalty_free_load_milestone = 10, loyalty_program_started_at = now() - interval \'1 day\'')
  const discounted = await placeOrder(db, ids, { supplies: [{ requirement_id: ids.arielLine, choice: 'substitute', replacement_id: ids.tideOption }] })
  assert.equal(Number(discounted.loyalty_original_total), 210)
  assert.equal(Number(discounted.total_price), 105, '50% off the service and the ₱10 charge')

  await db.query('UPDATE settings SET loyalty_discount_milestone = 5, loyalty_free_load_milestone = 1')
  const freeLoad = await placeOrder(db, ids, { phone: '09179999999', supplies: [{ requirement_id: ids.arielLine, choice: 'substitute', replacement_id: ids.tideOption }] })
  assert.equal(Number(freeLoad.total_price), 10, 'the free load covers the ₱200 service; the ₱10 charge is still paid')
})

test('scenario 12 and 17: supplies can be changed while the service is still Received, with stock, charge and total recalculated', async t => {
  const db = await orderDatabase(t)
  const ids = await shop(db)
  const order = await placeOrder(db, ids, { weight: 16, paid: 200 })
  const item = await itemOf(db, order.id)
  assert.deepEqual(await stocks(db, ids, ['ariel', 'tide']), [18, 10])

  const changed = await changeSupplies(db, ids, item.id, [{ requirement_id: ids.arielLine, choice: 'substitute', replacement_id: ids.tideOption }, { requirement_id: ids.downyLine, choice: 'customer_own' }])
  assert.equal(Number(changed.total_price), 420)
  assert.equal(changed.payment_status, 'partial')
  assert.deepEqual(await stocks(db, ids, ['ariel', 'tide', 'downy', 'bag']), [20, 8, 20, 18], 'the old supplies went back and only the new ones were taken')
  assert.deepEqual((await recorded(db, order.id)).map(row => row.choice), ['substitute', 'customer_own'])
  const entries = await supplyAudit(db, order.id)
  assert.equal(entries.at(-1).action, 'update')
  const editEntry = { ...entries.at(-1), event_type: 'order_supplies_changed', table_name: 'order_item_supplies' }
  assert.match(describeAuditEvent(editEntry), /were changed: Ariel from the shop's usual to Tide \(\+₱20\.00\); Downy from the shop's usual to customer's own\./)
  // Entries saved without the old supplies still read as before.
  assert.match(describeAuditEvent({ ...editEntry, before_data: null }), /were changed to: Ariel → Tide \(\+₱20\.00\); Downy → customer's own\./)

  // Paid ₱420 in full; dropping the charged replacement would leave an overpayment.
  await db.query('UPDATE orders SET amount_paid = 420 WHERE id = $1', [order.id])
  await assert.rejects(changeSupplies(db, ids, item.id, []), /already paid ₱420\.00, more than the new total of ₱400\.00/)
  assert.equal(await stockOf(db, ids.tide), 8, 'a refused change takes and returns nothing')

  await db.query('UPDATE orders SET amount_paid = 0 WHERE id = $1', [order.id])
  const back = await changeSupplies(db, ids, item.id, [])
  assert.equal(Number(back.total_price), 400)
  assert.deepEqual(await stocks(db, ids, ['ariel', 'tide', 'downy']), [18, 10, 18])

  await db.query("UPDATE orders SET status = 'on_process' WHERE id = $1", [order.id])
  await db.query("UPDATE order_items SET status = 'on_process' WHERE id = $1", [item.id])
  await assert.rejects(changeSupplies(db, ids, item.id, [{ requirement_id: ids.downyLine, choice: 'none' }]), /before work on the service starts/)
})

test('scenario 13: cancelling returns supplies only for services that had not started', async t => {
  const db = await orderDatabase(t)
  const ids = await shop(db)
  const supplies = [{ requirement_id: ids.arielLine, choice: 'substitute', replacement_id: ids.tideOption }]
  const early = await placeOrder(db, ids, { supplies })
  await db.query("SELECT cancel_branch_order($1,$2,'Customer changed their mind')", [early.id, ids.staff])
  assert.deepEqual(await stocks(db, ids, ['tide', 'downy', 'bag']), [10, 20, 20], 'nothing was used yet, so everything went back')

  const started = await placeOrder(db, ids, { supplies })
  await db.query("UPDATE orders SET status = 'on_process' WHERE id = $1", [started.id])
  await db.query("UPDATE order_items SET status = 'on_process' WHERE order_id = $1", [started.id])
  await db.query("SELECT cancel_branch_order($1,$2,'Customer collected it early')", [started.id, ids.staff])
  assert.deepEqual(await stocks(db, ids, ['tide', 'downy', 'bag']), [9, 19, 19], 'washing had started, so the supplies stay used')
})

test('scenario 15: changing a charge later never changes an existing order', async t => {
  const db = await orderDatabase(t)
  const ids = await shop(db)
  const order = await placeOrder(db, ids, { supplies: [{ requirement_id: ids.arielLine, choice: 'substitute', replacement_id: ids.tideOption }] })
  await db.query('UPDATE service_supply_replacements SET extra_charge_per_load = 50 WHERE id = $1', [ids.tideOption])
  assert.equal(Number((await db.query('SELECT total_price FROM orders WHERE id=$1', [order.id])).rows[0].total_price), 210)
  assert.deepEqual(await recorded(db, order.id), [{ choice: 'substitute', used: 'Tide', quantity: 1, charge: 10 }])
})

test('the settings refuse unsuitable replacements and take the branch and service from the usual supply', async t => {
  const db = await orderDatabase(t)
  const ids = await shop(db)
  const approve = (itemId, perLoad = 1, charge = 0, branch = ids.other) => db.query(
    'INSERT INTO service_supply_replacements(requirement_id,branch_id,service_type_id,replacement_item_id,quantity_per_load,extra_charge_per_load) VALUES ($1,$2,$2,$3,$4,$5) RETURNING branch_id, service_type_id',
    [ids.downyLine, branch, itemId, perLoad, charge])
  for (const [itemId, perLoad, charge, message] of [
    [ids.breeze, 1, 0, /current inventory item of the same branch/],
    [ids.downy, 1, 0, /cannot replace itself/],
    [ids.ariel, 1, 0, /already one of this service's usual supplies/],
    [ids.hanger, 1.5, 0, /whole number because it is counted in pcs/],
    [ids.hanger, 1, -1, /check/i],
    [ids.hanger, 0, 0, /check/i],
  ]) await assert.rejects(approve(itemId, perLoad, charge), message)
  const saved = (await approve(ids.hanger, 2, 5)).rows[0]
  assert.equal(saved.branch_id, ids.branch)
  assert.equal(saved.service_type_id, ids.service)
  await db.query('DELETE FROM service_inventory_requirements WHERE id = $1', [ids.downyLine])
  assert.equal((await db.query('SELECT count(*)::int AS n FROM service_supply_replacements WHERE requirement_id = $1', [ids.downyLine])).rows[0].n, 0,
    'removing a usual supply removes its replacements')
})

function mockDatabase(t, row = { id: '33333333-3333-4333-8333-333333333333', branch_id: 'branch-a', order_id: 'order-1' }) {
  const originalFrom = database.from
  const originalRpc = database.rpc
  const calls = []
  database.from = table => {
    const query = { then(resolve, reject) { return Promise.resolve({ data: [], error: null }).then(resolve, reject) } }
    for (const method of ['select', 'update', 'insert', 'delete', 'order', 'range', 'limit', 'gte', 'lte', 'ilike', 'in', 'not', 'neq', 'eq', 'is']) {
      query[method] = (...args) => { calls.push({ table, method, args }); return query }
    }
    query.maybeSingle = query.single = async () => ({ data: table === 'order_items' ? row : null, error: null })
    return query
  }
  database.rpc = async (name, args) => { calls.push({ rpc: name, args }); return { data: {}, error: null } }
  t.after(() => { database.from = originalFrom; database.rpc = originalRpc })
  return calls
}

const staff = { role: 'staff', staffId: 'staff-a', branchId: 'branch-a', branch: 'Main' }
const line = '11111111-1111-4111-8111-111111111111'
const option = '22222222-2222-4222-8222-222222222222'

test('the server passes only the choice to the database and refuses malformed ones', async t => {
  const calls = mockDatabase(t)
  const order = supplies => createOrder({
    customer: { name: 'Ana Cruz', phone: '09171234567' },
    order: { total_price: 200, items: [{ service_type_id: 'service-1', weight_kg: 8, supplies }] },
  }, staff)
  await order([
    { requirement_id: line, choice: 'substitute', replacement_id: option, quantity: 50, extra_charge_per_load: 0 },
    { requirement_id: line, choice: 'none', quantity: 3 },
  ])
  assert.deepEqual(calls.find(call => call.rpc === 'create_branch_order').args.p_order.items[0].supplies, [
    { requirement_id: line, choice: 'substitute', replacement_id: option },
    { requirement_id: line, choice: 'none' },
  ], 'amounts and prices sent by the browser are dropped')
  await order(undefined)
  assert.equal('supplies' in calls.filter(call => call.rpc === 'create_branch_order').at(-1).args.p_order.items[0], false)
  for (const [supplies, message] of [
    ['none', /short list/],
    [Array.from({ length: 21 }, () => ({ requirement_id: line, choice: 'none' })), /short list/],
    [[{ choice: 'none' }], /usual supply/],
    [[{ requirement_id: line, choice: 'extra' }], /valid supply option/],
    [[{ requirement_id: line, choice: 'substitute' }], /item to use instead/],
  ]) await assert.rejects(order(supplies), message)

  await updateOrderItemSupplies({ orderItemId: '33333333-3333-4333-8333-333333333333', supplies: [{ requirement_id: line, choice: 'customer_own' }] }, staff)
  assert.deepEqual(calls.find(call => call.rpc === 'update_order_item_supplies').args, {
    p_order_item_id: '33333333-3333-4333-8333-333333333333', p_staff_id: 'staff-a', p_supplies: [{ requirement_id: line, choice: 'customer_own' }],
  })
  await assert.rejects(updateOrderItemSupplies({ orderItemId: 'not-an-id' }, staff), /service on the order/)
})

test('staff of another branch cannot change the supplies of an order', async t => {
  mockDatabase(t, { id: '33333333-3333-4333-8333-333333333333', branch_id: 'branch-b', order_id: 'order-1' })
  await assert.rejects(updateOrderItemSupplies({ orderItemId: '33333333-3333-4333-8333-333333333333', supplies: [] }, staff), /orders assigned to your branch/)
})

test('the order form offers only approved options and previews their charge', () => {
  const stock = [
    { id: 'ariel', name: 'Ariel', unit: 'sachets', current_stock: 20, branch_id: 'main' },
    { id: 'tide', name: 'Tide', unit: 'sachets', current_stock: 3, branch_id: 'main' },
    { id: 'liquid', name: 'Liquid', unit: 'mL', current_stock: 900, branch_id: 'main' },
    { id: 'old', name: 'Old Soap', unit: 'sachets', current_stock: 9, branch_id: 'main', deleted_at: '2026-11-01' },
    { id: 'downy', name: 'Downy', unit: 'sachets', current_stock: 20, branch_id: 'main' },
    { id: 'bag', name: 'Plastic Bag', unit: 'pcs', current_stock: 50, branch_id: 'main' },
  ]
  const requirements = [
    { id: 'line-ariel', branch_id: 'main', service_type_id: 'wash', inventory_item_id: 'ariel', quantity_per_load: 1, allow_leave_out: false },
    { id: 'line-downy', branch_id: 'main', service_type_id: 'wash', inventory_item_id: 'downy', quantity_per_load: 1 },
    { id: 'line-bag', branch_id: 'main', service_type_id: 'wash', inventory_item_id: 'bag', quantity_per_load: 1, allow_customer_own: false },
  ]
  const replacements = [
    { id: 'opt-tide', requirement_id: 'line-ariel', replacement_item_id: 'tide', quantity_per_load: 1, extra_charge_per_load: 10 },
    { id: 'opt-liquid', requirement_id: 'line-ariel', replacement_item_id: 'liquid', quantity_per_load: 60, extra_charge_per_load: 0 },
    { id: 'opt-old', requirement_id: 'line-ariel', replacement_item_id: 'old', quantity_per_load: 1, extra_charge_per_load: 0 },
    { id: 'opt-downy', requirement_id: 'line-ariel', replacement_item_id: 'downy', quantity_per_load: 1, extra_charge_per_load: 0 },
    { id: 'opt-paused', requirement_id: 'line-ariel', replacement_item_id: 'liquid', quantity_per_load: 1, extra_charge_per_load: 0, is_active: false },
  ]
  const recipe = serviceRecipe(requirements, stock, 'main', 'wash', replacements)
  assert.deepEqual(recipe.map(entry => entry.item.name), ['Ariel', 'Downy', 'Plastic Bag'])
  assert.deepEqual(recipe[0].replacements.map(entry => entry.item.name), ['Liquid', 'Tide'], 'archived, paused, and usual items are not offered')
  assert.equal(recipe[0].allowLeaveOut, false)
  assert.equal(recipe[2].allowCustomerOwn, false)
  assert.equal(serviceLoads(17, { bundle_kg: 8 }), 3)

  const choices = { 'line-ariel': { choice: 'substitute', replacementId: 'opt-tide' }, 'line-downy': { choice: 'customer_own' }, 'line-gone': { choice: 'none' } }
  assert.deepEqual(supplyChoicesPayload(choices, recipe), [
    { requirement_id: 'line-ariel', choice: 'substitute', replacement_id: 'opt-tide' },
    { requirement_id: 'line-downy', choice: 'customer_own' },
  ])
  assert.equal(supplyCharge(choices, recipe, 2), 20)
  assert.equal(supplyCharge({ 'line-ariel': { choice: 'substitute', replacementId: 'opt-liquid' } }, recipe, 2), 0)

  const problem = (next, loads = 1) => supplyChoiceProblem(next, recipe, loads)
  assert.equal(problem(choices), null)
  assert.match(problem({ 'line-ariel': { choice: 'none' } }), /Ariel cannot be left out/)
  assert.match(problem({ 'line-bag': { choice: 'customer_own' } }), /cannot bring their own Plastic Bag/)
  assert.match(problem({ 'line-ariel': { choice: 'substitute', replacementId: '' } }), /choose the item to use instead of Ariel/)
  assert.match(problem({ 'line-ariel': { choice: 'substitute', replacementId: 'opt-tide' } }, 4), /Tide has only 3 sachets left, but 4 sachets is needed/)

  assert.deepEqual(choicesFromRecorded([
    { service_inventory_requirement_id: 'line-ariel', choice: 'substitute', replacement_id: 'opt-tide' },
    { service_inventory_requirement_id: 'line-downy', choice: 'customer_own' },
    { service_inventory_requirement_id: null, choice: 'none' },
  ]), { 'line-ariel': { choice: 'substitute', replacementId: 'opt-tide' }, 'line-downy': { choice: 'customer_own' } })
})
