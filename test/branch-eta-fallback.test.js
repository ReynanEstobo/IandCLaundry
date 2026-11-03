import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { PGlite } from '@electric-sql/pglite'

const MAIN = '00000000-0000-0000-0000-00000000000a'
const CALZADA = '00000000-0000-0000-0000-00000000000b'
const WASH = '00000000-0000-0000-0000-0000000000a1'
const BLANKET = '00000000-0000-0000-0000-0000000000a2'

// The order RPC is large; this stand-in keeps its exact ETA source check,
// which is the only part of it the migration changes.
const ORDER_FUNCTION = `
CREATE FUNCTION public.create_branch_order(
  p_branch_id uuid, p_staff_id uuid, p_customer jsonb, p_order jsonb, p_items jsonb, p_loads integer, p_reward uuid
) RETURNS text LANGUAGE plpgsql AS $$
DECLARE v_item_eta INTEGER; v_item_eta_source TEXT; v_eta_source TEXT := 'branch_default_max';
BEGIN
  SELECT minutes, source INTO v_item_eta, v_item_eta_source
  FROM public.estimate_order_processing_minutes(p_branch_id, (p_order->>'service_type_id')::uuid, (p_order->>'weight_kg')::numeric);
    IF v_item_eta_source = 'historical_service_branch' THEN v_eta_source := 'historical_service_branch_max'; END IF;
  RETURN v_eta_source;
END $$;`

async function databaseWithHistory(t) {
  const db = new PGlite()
  t.after(() => db.close())
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    CREATE TABLE public.settings (default_processing_minutes integer, eta_buffer_minutes integer, eta_min_completed_orders integer);
    INSERT INTO public.settings VALUES (100, 20, 5);
    CREATE TABLE public.orders (
      id serial PRIMARY KEY, branch_id uuid, service_type_id uuid, weight_kg numeric, status text,
      processing_started_at timestamptz, ready_at timestamptz
    );
    -- Main: six 5 kg wash orders of 60 minutes, and five 12 kg blanket orders of 300 minutes.
    INSERT INTO public.orders(branch_id, service_type_id, weight_kg, status, processing_started_at, ready_at)
    SELECT '${MAIN}', '${WASH}', 5, 'released', now() - interval '1 day', now() - interval '1 day' + interval '60 minutes' FROM generate_series(1, 6);
    INSERT INTO public.orders(branch_id, service_type_id, weight_kg, status, processing_started_at, ready_at)
    SELECT '${MAIN}', '${BLANKET}', 12, 'released', now() - interval '1 day', now() - interval '1 day' + interval '300 minutes' FROM generate_series(1, 5);
    -- Calzada: blanket orders that are much faster, which must not affect Main.
    INSERT INTO public.orders(branch_id, service_type_id, weight_kg, status, processing_started_at, ready_at)
    SELECT '${CALZADA}', '${BLANKET}', 3, 'released', now() - interval '1 day', now() - interval '1 day' + interval '30 minutes' FROM generate_series(1, 9);
  `)
  const original = await readFile(new URL('../supabase_migrations/20260908_three_stage_order_eta.sql', import.meta.url), 'utf8')
  const functionStart = original.indexOf('CREATE OR REPLACE FUNCTION public.estimate_order_processing_minutes(')
  const functionEnd = original.indexOf('END $$;', functionStart) + 'END $$;'.length
  await db.exec(original.slice(functionStart, functionEnd))
  await db.exec(ORDER_FUNCTION)
  const migration = await readFile(new URL('../supabase_migrations/20261103_branch_eta_fallback.sql', import.meta.url), 'utf8')
  return { db, migration }
}

const estimate = (db, branch, service, weight) => db.query(
  'SELECT minutes, source FROM public.estimate_order_processing_minutes($1, $2, $3)', [branch, service, weight],
).then(result => result.rows[0])

test('an order ETA uses its branch\'s own history for the service before the shared default', async t => {
  const { db, migration } = await databaseWithHistory(t)
  // Before: a 5 kg blanket at Main has no same-weight history, so it gets the shared default.
  assert.deepEqual(await estimate(db, MAIN, BLANKET, 5), { minutes: 120, source: 'branch_default' })

  await db.exec(migration)
  assert.deepEqual(await estimate(db, MAIN, BLANKET, 5), { minutes: 320, source: 'historical_service_branch_any_weight' },
    'Main\'s own blanket orders (300 min + 20 buffer), not Calzada\'s 30-minute ones')
  assert.deepEqual(await estimate(db, MAIN, WASH, 5), { minutes: 80, source: 'historical_service_branch' }, 'same-weight history is still used first')
  assert.deepEqual(await estimate(db, CALZADA, WASH, 5), { minutes: 120, source: 'branch_default' },
    'a branch with no history for the service falls back to the Settings default, not another branch')
})

test('orders estimated from any-weight branch history are labelled as history-based', async t => {
  const { db, migration } = await databaseWithHistory(t)
  await db.exec(migration)
  await db.exec(migration)
  const label = async (service, weight) => (await db.query(
    `SELECT public.create_branch_order($1, NULL, '{}'::jsonb, $2::jsonb, '[]'::jsonb, 1, NULL) AS source`,
    [MAIN, JSON.stringify({ service_type_id: service, weight_kg: weight })],
  )).rows[0].source
  assert.equal(await label(BLANKET, 5), 'historical_service_branch_max')
  assert.equal(await label(WASH, 5), 'historical_service_branch_max')

  const { rows } = await db.query(`SELECT has_function_privilege('anon', 'public.estimate_order_processing_minutes(uuid,uuid,numeric)', 'EXECUTE') AS anon_can_run`)
  assert.equal(rows[0].anon_can_run, false)
})
