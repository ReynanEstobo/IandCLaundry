import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import { database } from '../backend/config/supabase.js'
import { lookupCustomer } from '../backend/controllers/customerController.js'
import { restoreRecord } from '../backend/controllers/auditController.js'

const ARCHIVED_PHONE = '09171234567'

// The order RPC is large; this stand-in keeps its exact customer lookup block,
// which is the only part the migration changes.
const ORDER_FUNCTION = `
CREATE FUNCTION public.create_branch_order(
  p_branch_id uuid, p_staff_id uuid, p_customer jsonb, p_order jsonb, p_items jsonb, p_loads integer, p_reward uuid
) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v_customer_id UUID; v_customer_email TEXT;
BEGIN
  SELECT id, email INTO v_customer_id, v_customer_email FROM public.customers
  WHERE regexp_replace(phone, '[^0-9]', '', 'g') = regexp_replace(trim(p_customer->>'phone'), '[^0-9]', '', 'g')
  LIMIT 1 FOR UPDATE;
  IF v_customer_id IS NULL THEN
    INSERT INTO public.customers(name, phone, email)
    VALUES (trim(p_customer->>'name'), trim(p_customer->>'phone'), NULLIF(trim(p_customer->>'email'), ''))
    RETURNING id INTO v_customer_id;
  END IF;
  RETURN v_customer_id;
END $$;

CREATE FUNCTION public.register_branch_customer(
  p_branch_id uuid, p_staff_id uuid, p_name text, p_phone text, p_email text
) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v_customer public.customers;
BEGIN
  SELECT * INTO v_customer FROM public.customers
  WHERE regexp_replace(phone, '[^0-9]', '', 'g') = regexp_replace(p_phone, '[^0-9]', '', 'g')
  LIMIT 1 FOR UPDATE;
  IF v_customer.id IS NULL THEN
    INSERT INTO public.customers(name, phone, email) VALUES (trim(p_name), trim(p_phone), NULLIF(trim(p_email), ''))
    RETURNING * INTO v_customer;
  END IF;
  RETURN v_customer.id;
END $$;`

async function databaseWithArchivedCustomer(t) {
  const db = new PGlite()
  t.after(() => db.close())
  await db.exec(`
    CREATE TABLE public.customers (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text, phone text, email text, deleted_at timestamptz
    );
    CREATE UNIQUE INDEX customers_normalized_phone_unique ON public.customers ((regexp_replace(phone, '[^0-9]', '', 'g')));
    ${ORDER_FUNCTION}
  `)
  const { rows } = await db.query(`INSERT INTO public.customers(name, phone, deleted_at) VALUES ('Archived Ana', $1, now()) RETURNING id`, [ARCHIVED_PHONE])
  const migration = await readFile(new URL('../supabase_migrations/20261023_archived_customers_not_matched.sql', import.meta.url), 'utf8')
  return { db, archivedId: rows[0].id, migration }
}

const placeOrder = (db, name) => db.query(
  `SELECT public.create_branch_order(NULL, NULL, $1::jsonb, '{}'::jsonb, '[]'::jsonb, 1, NULL) AS id`,
  [JSON.stringify({ name, phone: ARCHIVED_PHONE, email: '' })],
).then(result => result.rows[0].id)

test('an order for an archived customer\'s phone registers a new customer instead', async t => {
  const { db, archivedId, migration } = await databaseWithArchivedCustomer(t)
  assert.equal(await placeOrder(db, 'Before'), archivedId, 'before the migration the archived customer is matched')

  await db.exec(migration)
  const newId = await placeOrder(db, 'New Bea')
  assert.notEqual(newId, archivedId)
  assert.equal(await placeOrder(db, 'Again'), newId, 'the new active customer is matched on the next order')

  const { rows } = await db.query('SELECT name, deleted_at IS NULL AS active FROM public.customers ORDER BY active')
  assert.deepEqual(rows, [{ name: 'Archived Ana', active: false }, { name: 'New Bea', active: true }])

  const registered = await db.query(`SELECT public.register_branch_customer(NULL, NULL, 'X', $1, '') AS id`, [ARCHIVED_PHONE])
  assert.equal(registered.rows[0].id, newId)
})

test('phone numbers stay unique among active customers, and the migration can run twice', async t => {
  const { db, migration } = await databaseWithArchivedCustomer(t)
  await db.exec(migration)
  await db.exec(migration)
  await db.query(`INSERT INTO public.customers(name, phone) VALUES ('Active', $1)`, [ARCHIVED_PHONE])
  await assert.rejects(db.query(`INSERT INTO public.customers(name, phone) VALUES ('Duplicate', $1)`, [ARCHIVED_PHONE]), /customers_active_phone_unique/)
  await assert.rejects(db.query(`UPDATE public.customers SET deleted_at = NULL WHERE name = 'Archived Ana'`), /customers_active_phone_unique/)

  const { rows } = await db.query(`SELECT pg_get_functiondef('public.create_branch_order(uuid,uuid,jsonb,jsonb,jsonb,integer,uuid)'::regprocedure) AS body`)
  assert.equal(rows[0].body.split('AND deleted_at IS NULL').length - 1, 1)
})

// Records each Supabase query chain and answers it with the next queued result.
function withDatabaseMock(t, results) {
  const calls = []
  const original = database.from
  database.from = table => {
    const call = { table, steps: [] }
    calls.push(call)
    const chain = new Proxy({}, {
      get(_target, key) {
        if (key === 'then') {
          const result = results.shift() || { data: [], error: null }
          return (resolve, reject) => Promise.resolve(result).then(resolve, reject)
        }
        return (...args) => { call.steps.push([key, ...args]); return chain }
      },
    })
    return chain
  }
  t.after(() => { database.from = original })
  return calls
}

test('the order form\'s phone check only looks at active customers', async t => {
  const calls = withDatabaseMock(t, [{ data: [], error: null }])
  const result = await lookupCustomer('0917-123-4567', { role: 'admin' })
  assert.deepEqual(result, { exists: false, visible: false, customer: null, loyalty: { nextReward: null } })
  assert.equal(calls[0].table, 'customers')
  assert.deepEqual(calls[0].steps.filter(([step]) => ['eq', 'is'].includes(step)), [['eq', 'phone', ARCHIVED_PHONE], ['is', 'deleted_at', null]])
})

test('restoring an archived customer whose number now belongs to someone else is refused', async t => {
  const calls = withDatabaseMock(t, [
    { data: { id: 'archived-1', phone: ARCHIVED_PHONE, deleted_at: '2026-10-01' }, error: null },
    { data: [{ id: 'active-2', name: 'New Bea' }], error: null },
  ])
  await assert.rejects(
    restoreRecord({ table: 'customers', id: 'archived-1' }, { role: 'admin', staffId: 'admin-1' }),
    error => error.status === 409 && /New Bea now uses the phone number 09171234567/.test(error.message),
  )
  assert.equal(calls.some(call => call.steps.some(([step]) => step === 'update')), false)
})
