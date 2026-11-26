import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import { database } from '../backend/config/supabase.js'
import { createOrder } from '../backend/controllers/operationController.js'
import { describeSupplyChange, needsAmount, replacementOptions, serviceLoads, serviceRecipe, supplyChoiceProblem, supplyChoicesPayload } from '../frontend/src/utils/orderSupplies.js'

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8')
const MIGRATION = 'supabase_migrations/20261126_customer_supply_choices.sql'

test('the migration changes text that exists in the real order and list functions', async () => {
  const migration = (await read(MIGRATION)).replaceAll('\r', '')
  const orderSource = (await read('supabase_migrations/20261001_remove_note_fields.sql')).replaceAll('\r', '')
  const listSource = (await read('supabase_migrations/20261010_paginated_order_queue.sql')).replaceAll('\r', '')
  for (const tag of ['old1', 'old2', 'old3', 'old4']) {
    const part = migration.split(`$${tag}$`)[1]
    assert.ok(part, `part ${tag} is in the migration`)
    assert.equal(orderSource.split(part).length - 1, 1, `part ${tag} is found once in create_branch_order`)
  }
  assert.ok(listSource.includes("to_jsonb(oi) || jsonb_build_object('order_item_addons', COALESCE(("))
})

// The same small database the multi-service order test builds.
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
      notes text, branch text, branch_id uuid, created_by_staff_id uuid);
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
      stage_started_at timestamptz,
      created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now());
    CREATE TABLE payments (id uuid PRIMARY KEY DEFAULT uuid_generate_v4(), notes text);
    CREATE TABLE inventory_items (id uuid PRIMARY KEY DEFAULT uuid_generate_v4(), name text, unit text,
      current_stock numeric, branch text, branch_id uuid, deleted_at timestamptz);
    CREATE TABLE inventory_usage_log (id uuid PRIMARY KEY DEFAULT uuid_generate_v4(), item_id uuid,
      quantity_used numeric, order_id uuid, logged_at timestamptz DEFAULT now());
    CREATE TABLE loyalty_rewards (id uuid PRIMARY KEY DEFAULT uuid_generate_v4(), customer_id uuid,
      earned_order_id uuid, reward_type text, status text, discount_percent integer, free_load_kg numeric,
      expires_at timestamptz, redeemed_at timestamptz, redeemed_order_id uuid);
    CREATE TABLE customer_branches (customer_id uuid, branch_id uuid, first_served_at timestamptz,
      last_served_at timestamptz, order_count integer, UNIQUE(customer_id, branch_id));
    CREATE TABLE audit_logs (action text, table_name text, record_id uuid, actor_staff_id uuid,
      branch_id uuid, before_data jsonb, after_data jsonb,
      CONSTRAINT audit_logs_action_check CHECK (action IN ('delete','restore')));
    CREATE FUNCTION capture_audit_change() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN COALESCE(NEW, OLD); END $$;
    CREATE FUNCTION estimate_order_processing_minutes(uuid, uuid, numeric)
      RETURNS TABLE(minutes integer, source text) LANGUAGE sql AS $$ SELECT 120, 'branch_default'::text $$;
  `)
  for (const name of [
    '20260907_order_cancellation', '20260926_multi_service_per_load', '20261001_remove_note_fields',
    '20261001_z_cash_only_payments', '20261003_service_inventory_integrity', '20261004_delink_archived_service_inventory',
    '20261005_preserve_order_addon_history', '20261006_preserve_archived_order_addon_history',
    '20261008_reject_order_overpayment', '20261012_optional_order_email_and_payment_followup',
    '20261013_optional_customer_email_constraint',
  ]) await db.exec(await read(`supabase_migrations/${name}.sql`))
  const migration = await read(MIGRATION)
  await db.exec(migration)
  await db.exec(migration)
  return db
}

async function shop(db) {
  const ids = Object.fromEntries(['branch', 'other', 'staff', 'service', 'otherService', 'ariel', 'tide', 'liquid', 'breeze', 'downy', 'bag'].map(key => [key, randomUUID()]))
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
  const recipe = async (itemId, serviceId = ids.service) => (await db.query('INSERT INTO service_inventory_requirements(branch_id,service_type_id,inventory_item_id,quantity_per_load) VALUES ($1,$2,$3,1) RETURNING id', [ids.branch, serviceId, itemId])).rows[0].id
  ids.arielLine = await recipe(ids.ariel)
  ids.downyLine = await recipe(ids.downy)
  ids.bagLine = await recipe(ids.bag)
  ids.comforterLine = await recipe(ids.ariel, ids.otherService)
  return ids
}

const stockOf = async (db, id) => Number((await db.query('SELECT current_stock FROM inventory_items WHERE id=$1', [id])).rows[0].current_stock)

function placeOrder(db, ids, { weight = 8, supplies, extra = [], requestId = randomUUID() } = {}) {
  const item = { service_type_id: ids.service, weight_kg: weight, ...(supplies && { supplies }) }
  const order = { client_request_id: requestId, amount_paid: 0, payment_method: 'cash', items: [item, ...extra] }
  return db.query('SELECT (create_branch_order($1,$2,$3::jsonb,$4::jsonb,$5::jsonb,1,NULL)).* ', [
    ids.branch, ids.staff, JSON.stringify({ name: 'Ana Cruz', phone: '09171234567' }), JSON.stringify(order), '{}',
  ]).then(result => result.rows[0])
}

const recordedFor = async (db, orderId) => (await db.query(`SELECT s.choice, s.default_item_name_snapshot AS usual, s.used_item_name_snapshot AS used,
    s.quantity::float AS quantity, s.unit_snapshot AS unit
  FROM order_item_supplies s JOIN order_items oi ON oi.id = s.order_item_id WHERE oi.order_id = $1
  ORDER BY oi.created_at, s.default_item_name_snapshot`, [orderId])).rows

test('an order with no supply changes takes the usual supplies, exactly as before', async t => {
  const db = await orderDatabase(t)
  const ids = await shop(db)
  const order = await placeOrder(db, ids)
  assert.equal(Number(order.total_price), 200)
  assert.deepEqual(await Promise.all([ids.ariel, ids.downy, ids.bag, ids.tide].map(id => stockOf(db, id))), [19, 19, 19, 10])
  assert.equal((await db.query('SELECT count(*)::int AS n FROM inventory_usage_log WHERE order_id=$1', [order.id])).rows[0].n, 3)
  assert.equal((await db.query('SELECT count(*)::int AS n FROM order_item_supplies')).rows[0].n, 0)
  const definition = (await db.query("SELECT pg_get_functiondef('public.create_branch_order(uuid,uuid,jsonb,jsonb,jsonb,integer,uuid)'::regprocedure) AS d")).rows[0].d
  assert.equal(definition.split('INSERT INTO public.order_item_supplies').length - 1, 1, 'running the migration twice changes the function once')
})

test("a replacement, the customer's own supply and a left-out supply take only what is used, at the same price", async t => {
  const db = await orderDatabase(t)
  const ids = await shop(db)
  const supplies = [
    { requirement_id: ids.arielLine, choice: 'substitute', item_id: ids.tide },
    { requirement_id: ids.downyLine, choice: 'customer_own' },
    { requirement_id: ids.bagLine, choice: 'none' },
  ]
  const requestId = randomUUID()
  const order = await placeOrder(db, ids, { weight: 16, supplies, requestId }) // two loads
  assert.equal(Number(order.total_price), 400, 'the price does not change')
  assert.deepEqual(await Promise.all([ids.ariel, ids.downy, ids.bag, ids.tide].map(id => stockOf(db, id))), [20, 20, 20, 8])
  assert.deepEqual(await recordedFor(db, order.id), [
    { choice: 'substitute', usual: 'Ariel', used: 'Tide', quantity: 2, unit: 'sachets' },
    { choice: 'customer_own', usual: 'Downy', used: null, quantity: 2, unit: 'sachets' },
    { choice: 'none', usual: 'Plastic Bag', used: null, quantity: 2, unit: 'pcs' },
  ])
  const usage = (await db.query('SELECT item_id, quantity_used::float AS q FROM inventory_usage_log WHERE order_id=$1', [order.id])).rows
  assert.deepEqual(usage, [{ item_id: ids.tide, q: 2 }], 'the stock history shows only the replacement')

  const again = await placeOrder(db, ids, { weight: 16, supplies, requestId })
  assert.equal(again.id, order.id, 'sending the same order twice saves it once')
  assert.equal(await stockOf(db, ids.tide), 8, 'and takes the stock once')

  await db.query("SELECT cancel_branch_order($1,$2,'Customer changed their mind')", [order.id, ids.staff])
  assert.equal(await stockOf(db, ids.tide), 10, 'cancelling returns the replacement to stock')
})

test('a replacement counted in another unit uses the amount entered', async t => {
  const db = await orderDatabase(t)
  const ids = await shop(db)
  const order = await placeOrder(db, ids, {
    weight: 16,
    supplies: [
      { requirement_id: ids.arielLine, choice: 'substitute', item_id: ids.liquid, quantity: 75.5 },
      { requirement_id: ids.bagLine, choice: 'substitute', item_id: ids.tide, quantity: 3 },
    ],
  })
  assert.deepEqual(await Promise.all([ids.ariel, ids.liquid, ids.bag, ids.tide, ids.downy].map(id => stockOf(db, id))), [20, 924.5, 20, 7, 18])
  assert.deepEqual(await recordedFor(db, order.id), [
    { choice: 'substitute', usual: 'Ariel', used: 'Liquid Detergent', quantity: 75.5, unit: 'mL' },
    { choice: 'substitute', usual: 'Plastic Bag', used: 'Tide', quantity: 3, unit: 'sachets' },
  ])
})

test('two services sharing one replacement are checked against its stock together', async t => {
  const db = await orderDatabase(t)
  const ids = await shop(db)
  const comforter = { service_type_id: ids.otherService, weight_kg: 5, supplies: [{ requirement_id: ids.comforterLine, choice: 'substitute', item_id: ids.tide }] }
  const washSupplies = [{ requirement_id: ids.arielLine, choice: 'substitute', item_id: ids.tide }]
  await db.query('UPDATE inventory_items SET current_stock = 1 WHERE id = $1', [ids.tide])
  await assert.rejects(placeOrder(db, ids, { supplies: washSupplies, extra: [comforter] }), /Tide has only 1(\.0+)? sachets remaining; 2(\.0+)? sachets is required for this order/)
  await db.query('UPDATE inventory_items SET current_stock = 10 WHERE id = $1', [ids.tide])
  const order = await placeOrder(db, ids, { supplies: washSupplies, extra: [comforter] })
  assert.equal(await stockOf(db, ids.tide), 8)
  assert.equal(await stockOf(db, ids.ariel), 20, 'neither service used Ariel')
  assert.equal((await recordedFor(db, order.id)).length, 2)
})

test('unsuitable supply choices are refused and nothing is taken from stock', async t => {
  const db = await orderDatabase(t)
  const ids = await shop(db)
  for (const [supplies, message] of [
    [[{ requirement_id: ids.arielLine, choice: 'substitute', item_id: ids.liquid }], /Liquid Detergent is counted in mL, not sachets\. Enter how much Liquid Detergent to use/],
    [[{ requirement_id: ids.bagLine, choice: 'substitute', item_id: ids.tide }], /Tide is counted in sachets, not pcs/],
    [[{ requirement_id: ids.arielLine, choice: 'substitute', item_id: ids.liquid, quantity: 0 }], /greater than zero/],
    [[{ requirement_id: ids.bagLine, choice: 'substitute', item_id: ids.tide, quantity: 1.5 }], /whole number because it is counted in sachets/],
    [[{ requirement_id: ids.arielLine, choice: 'substitute', item_id: ids.downy }], /Downy is already one of this service's usual supplies/],
    [[{ requirement_id: ids.arielLine, choice: 'substitute', item_id: ids.breeze }], /not available at this branch/],
    [[{ requirement_id: ids.arielLine, choice: 'substitute', item_id: ids.ariel }], /other than Ariel/],
    [[{ requirement_id: ids.comforterLine, choice: 'none' }], /no longer matches this service/],
    [[{ requirement_id: ids.arielLine, choice: 'extra' }], /valid supply option/],
    [[{ requirement_id: ids.arielLine, choice: 'none' }, { requirement_id: ids.arielLine, choice: 'customer_own' }], /more than once/],
  ]) await assert.rejects(placeOrder(db, ids, { supplies }), message)

  await db.query('UPDATE inventory_items SET current_stock = 1 WHERE id = $1', [ids.tide])
  await assert.rejects(placeOrder(db, ids, { weight: 16, supplies: [{ requirement_id: ids.arielLine, choice: 'substitute', item_id: ids.tide }] }), /Tide has only/)
  await db.query('UPDATE inventory_items SET deleted_at = now() WHERE id = $1', [ids.liquid])
  await assert.rejects(placeOrder(db, ids, { supplies: [{ requirement_id: ids.arielLine, choice: 'substitute', item_id: ids.liquid, quantity: 5 }] }), /not available at this branch/, 'an archived item cannot be used')
  assert.deepEqual(await Promise.all([ids.ariel, ids.downy, ids.bag, ids.tide].map(id => stockOf(db, id))), [20, 20, 20, 1])
  assert.equal((await db.query('SELECT count(*)::int AS n FROM orders')).rows[0].n, 0)
})

function mockDatabase(t) {
  const originalFrom = database.from
  const originalRpc = database.rpc
  const calls = []
  database.from = table => {
    const query = { then(resolve, reject) { return Promise.resolve({ data: [], error: null }).then(resolve, reject) } }
    for (const method of ['select', 'update', 'insert', 'delete', 'order', 'range', 'limit', 'gte', 'lte', 'ilike', 'in', 'not', 'neq', 'eq', 'is']) {
      query[method] = (...args) => { calls.push({ table, method, args }); return query }
    }
    query.maybeSingle = query.single = async () => ({ data: null, error: null })
    return query
  }
  database.rpc = async (name, args) => { calls.push({ rpc: name, args }); return { data: {}, error: null } }
  t.after(() => { database.from = originalFrom; database.rpc = originalRpc })
  return calls
}

const staff = { role: 'staff', staffId: 'staff-a', branchId: 'branch-a', branch: 'Main' }
const line = '11111111-1111-4111-8111-111111111111'
const tide = '22222222-2222-4222-8222-222222222222'

test('the server passes valid supply choices to the database and refuses malformed ones', async t => {
  const calls = mockDatabase(t)
  const order = supplies => createOrder({
    customer: { name: 'Ana Cruz', phone: '09171234567' },
    order: { total_price: 200, items: [{ service_type_id: 'service-1', weight_kg: 8, supplies }] },
  }, staff)
  await order([{ requirement_id: line, choice: 'substitute', item_id: tide, quantity: 50 }, { requirement_id: line, choice: 'none' }])
  assert.deepEqual(calls.find(call => call.rpc === 'create_branch_order').args.p_order.items[0].supplies[0], { requirement_id: line, choice: 'substitute', item_id: tide, quantity: 50 })
  await order(undefined)
  for (const [supplies, message] of [
    ['none', /short list/],
    [Array.from({ length: 21 }, () => ({ requirement_id: line, choice: 'none' })), /short list/],
    [[{ choice: 'none' }], /usual supply/],
    [[{ requirement_id: line, choice: 'extra' }], /valid supply option/],
    [[{ requirement_id: line, choice: 'substitute' }], /item to use instead/],
    [[{ requirement_id: line, choice: 'substitute', item_id: tide, quantity: -1 }], /valid amount/],
    [[{ requirement_id: line, choice: 'substitute', item_id: tide, quantity: 'a lot' }], /valid amount/],
    [[{ requirement_id: line, choice: 'none', quantity: 2 }], /valid amount/],
  ]) await assert.rejects(order(supplies), message)
})

test('the order form offers any other item, asks for an amount when the unit differs, and sends only real changes', () => {
  const stock = [
    { id: 'ariel', name: 'Ariel', unit: 'sachets', current_stock: 20, branch_id: 'main' },
    { id: 'tide', name: 'Tide', unit: 'sachets', current_stock: 3, branch_id: 'main' },
    { id: 'liquid', name: 'Liquid', unit: 'mL', current_stock: 900, branch_id: 'main' },
    { id: 'breeze', name: 'Breeze', unit: 'sachets', current_stock: 9, branch_id: 'calzada' },
    { id: 'downy', name: 'Downy', unit: 'sachets', current_stock: 20, branch_id: 'main' },
    { id: 'bag', name: 'Plastic Bag', unit: 'pcs', current_stock: 50, branch_id: 'main' },
    { id: 'hanger', name: 'Hanger', unit: 'pcs', current_stock: 30, branch_id: 'main' },
  ]
  const requirements = [
    { id: 'line-ariel', branch_id: 'main', service_type_id: 'wash', inventory_item_id: 'ariel', quantity_per_load: 1 },
    { id: 'line-downy', branch_id: 'main', service_type_id: 'wash', inventory_item_id: 'downy', quantity_per_load: 1 },
    { id: 'line-bag', branch_id: 'main', service_type_id: 'wash', inventory_item_id: 'bag', quantity_per_load: 1 },
    { id: 'line-other', branch_id: 'calzada', service_type_id: 'wash', inventory_item_id: 'breeze', quantity_per_load: 1 },
  ]
  const recipe = serviceRecipe(requirements, stock, 'main', 'wash')
  assert.deepEqual(recipe.map(entry => entry.item.name), ['Ariel', 'Downy', 'Plastic Bag'])
  assert.deepEqual(replacementOptions(stock, recipe[0].item, recipe).map(item => item.name), ['Tide', 'Hanger', 'Liquid'],
    "same branch only, items counted the same way first, never the service's own usual supplies")
  assert.equal(needsAmount(recipe[0].item, stock[1]), false)
  assert.equal(needsAmount(recipe[0].item, stock[2]), true)
  assert.equal(serviceLoads(17, { bundle_kg: 8 }), 3)
  assert.equal(serviceLoads('', { bundle_kg: 8 }), 1)

  assert.deepEqual(supplyChoicesPayload({
    'line-ariel': { choice: 'substitute', itemId: 'liquid', amount: '60' },
    'line-downy': { choice: 'default' },
    'line-bag': { choice: 'substitute', itemId: 'hanger', amount: '' },
    'line-gone': { choice: 'none' },
  }, recipe, stock), [
    { requirement_id: 'line-ariel', choice: 'substitute', item_id: 'liquid', quantity: 60 },
    { requirement_id: 'line-bag', choice: 'substitute', item_id: 'hanger' },
  ])

  const problem = (choices, loads = 1) => supplyChoiceProblem(choices, recipe, stock, loads)
  assert.equal(problem({ 'line-downy': { choice: 'customer_own' } }), null)
  assert.match(problem({ 'line-downy': { choice: 'substitute', itemId: '' } }), /choose the item to use instead of Downy/)
  assert.match(problem({ 'line-ariel': { choice: 'substitute', itemId: 'liquid', amount: '' } }), /enter how much Liquid to use instead of Ariel/)
  assert.match(problem({ 'line-bag': { choice: 'substitute', itemId: 'tide', amount: '1.5' } }), /whole number/)
  assert.match(problem({ 'line-ariel': { choice: 'substitute', itemId: 'tide' } }, 4), /Tide has only 3 sachets left, but 4 sachets is needed/)
  assert.match(problem({ 'line-ariel': { choice: 'substitute', itemId: 'liquid', amount: '950' } }), /Liquid has only 900 mL left/)
  assert.equal(problem({ 'line-ariel': { choice: 'substitute', itemId: 'tide' } }, 3), null)

  assert.equal(describeSupplyChange({ choice: 'customer_own', default_item_name_snapshot: 'Downy' }), "Downy → Customer's own")
  assert.equal(describeSupplyChange({ choice: 'none', default_item_name_snapshot: 'Plastic Bag' }), 'Plastic Bag → Left out')
  assert.equal(describeSupplyChange({ choice: 'substitute', default_item_name_snapshot: 'Ariel', used_item_name_snapshot: 'Tide' }), 'Ariel → Tide')
})
