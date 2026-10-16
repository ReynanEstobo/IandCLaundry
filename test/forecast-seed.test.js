import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { PGlite } from '@electric-sql/pglite'

test('forecast supplement creates dated ledger, usage and ETA history without resetting existing data', async t => {
  const db = new PGlite()
  t.after(() => db.close())
  // Reuse the minimal pre-migration schema exercised by the order integration test.
  const source = await readFile(new URL('./multi-service-database.test.js', import.meta.url), 'utf8')
  const schema = source.match(/await db\.exec\(`([\s\S]*?)`\)/)?.[1]
  assert.ok(schema, 'order integration fixture must exist')
  await db.exec(schema)
  await db.exec(`
    ALTER TABLE staff ADD COLUMN created_at timestamptz DEFAULT now();
    ALTER TABLE customers ADD COLUMN created_at timestamptz DEFAULT now();
    CREATE TABLE expenses (category text, description text, amount numeric, expense_date date, branch text, branch_id uuid);
    CREATE TABLE order_stage_history (id uuid DEFAULT gen_random_uuid(), order_id uuid, branch_id uuid,
      staff_id uuid, previous_status text, status text, changed_at timestamptz DEFAULT now());
    DROP TABLE payments;
  `)
  for (const name of [
    '20260908_order_stage_corrections.sql',
    '20260917_payment_ledger_reporting.sql',
    '20260907_order_cancellation.sql',
    '20260926_multi_service_per_load.sql',
    '20261001_remove_note_fields.sql',
    '20261003_service_inventory_integrity.sql',
    '20261008_reject_order_overpayment.sql',
  ]) {
    const sql = await readFile(new URL(`../supabase_migrations/${name}`, import.meta.url), 'utf8')
    await db.exec(sql.replace('CREATE EXTENSION IF NOT EXISTS "uuid-ossp";', ''))
  }
  await db.exec(`
    INSERT INTO staff(role) VALUES ('admin');
    INSERT INTO branches(name) VALUES ('Main'), ('Calzada'), ('Nasugbu');
    INSERT INTO service_types(name, bundle_kg, bundle_price, excess_kg_price, estimated_minutes)
    VALUES ('Wash & Fold Demo',8,300,35,120),('Comforter Demo',8,450,50,180),('Air Dry Demo',8,260,25,90);
    INSERT INTO inventory_items(name,unit,current_stock,branch_id)
    SELECT 'Demo Detergent','L',500,id FROM branches;
    INSERT INTO inventory_items(name,unit,current_stock,branch_id)
    SELECT 'Demo Garment Bag','pcs',100,id FROM branches;
    INSERT INTO service_inventory_requirements(branch_id,service_type_id,inventory_item_id,quantity_per_load)
    SELECT i.branch_id,s.id,i.id,0.1 FROM inventory_items i CROSS JOIN service_types s
    WHERE i.name='Demo Detergent' AND s.name <> 'Air Dry Demo';
    INSERT INTO service_addon_items(branch_id,service_type_id,inventory_item_id,unit_price)
    SELECT i.branch_id,s.id,i.id,20 FROM inventory_items i CROSS JOIN service_types s
    WHERE i.name='Demo Garment Bag' AND s.name='Wash & Fold Demo';
    INSERT INTO customers(name,phone,email) VALUES ('Existing demo','09999991000','existing@example.test');
  `)
  const sql = await readFile(new URL('../scripts/seed-forecast-history.sql', import.meta.url), 'utf8')
  await db.exec(sql)
  const branches = (await db.query(`SELECT branch_id, count(*)::int AS orders,
    count(DISTINCT (created_at AT TIME ZONE 'Asia/Manila')::date)::int AS days FROM orders GROUP BY branch_id`)).rows
  assert.equal(branches.length, 3)
  assert.ok(branches.every(b => b.days === 90 && b.orders >= 300))
  const result = (await db.query(`SELECT
    (SELECT count(*) FROM customers WHERE email='existing@example.test')::int AS preserved,
    (SELECT count(*) FROM orders WHERE ready_at <= processing_started_at OR amount_paid <> total_price)::int AS bad_orders,
    (SELECT count(DISTINCT (paid_at AT TIME ZONE 'Asia/Manila')::date) FROM payments)::int AS payment_days,
    (SELECT count(DISTINCT (logged_at AT TIME ZONE 'Asia/Manila')::date) FROM inventory_usage_log)::int AS usage_days,
    (SELECT min(current_stock) FROM inventory_items) AS minimum_stock`)).rows[0]
  assert.equal(result.preserved, 1)
  assert.equal(result.bad_orders, 0)
  assert.equal(result.payment_days, 90)
  assert.equal(result.usage_days, 90)
  assert.ok(Number(result.minimum_stock) >= 0)
  await assert.rejects(db.exec(sql), /already exists/)
  await db.exec('ROLLBACK')
  await assert.rejects(db.exec('UPDATE payments SET amount=1'), /append-only/)
})
