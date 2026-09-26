import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { PGlite } from '@electric-sql/pglite'

test('multi-service migration applies and duplicate order requests deduct stock once', async t => {
  const db = new PGlite()
  t.after(() => db.close())
  await db.exec(`
    CREATE ROLE authenticated; CREATE ROLE service_role;
    CREATE FUNCTION uuid_generate_v4() RETURNS uuid LANGUAGE sql AS $$ SELECT gen_random_uuid() $$;
    CREATE SCHEMA auth;
    CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql AS $$ SELECT 'authenticated'::text $$;
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
    CREATE TABLE inventory_items (id uuid PRIMARY KEY DEFAULT uuid_generate_v4(), name text, unit text,
      current_stock numeric, branch_id uuid, deleted_at timestamptz);
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
  const cancellationMigration = await readFile(new URL('../supabase_migrations/20260907_order_cancellation.sql', import.meta.url), 'utf8')
  await db.exec(cancellationMigration)
  const migration = await readFile(new URL('../supabase_migrations/20260926_multi_service_per_load.sql', import.meta.url), 'utf8')
  await db.exec(migration)
  assert.equal((await db.query("SELECT has_function_privilege('authenticated', 'public.cancel_branch_order(uuid,uuid,text)', 'EXECUTE') AS allowed")).rows[0].allowed, false)
  assert.equal((await db.query("SELECT has_function_privilege('service_role', 'public.cancel_branch_order(uuid,uuid,text)', 'EXECUTE') AS allowed")).rows[0].allowed, true)
  await db.exec(`
    CREATE TABLE cancellation_stage_probe (
      order_id uuid, status text, transition_type text, reason text
    );
    CREATE FUNCTION capture_cancellation_stage_probe() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.status = 'cancelled' AND OLD.status IS DISTINCT FROM NEW.status THEN
        INSERT INTO cancellation_stage_probe VALUES (
          NEW.id, NEW.status,
          current_setting('app.order_transition_type', true),
          current_setting('app.order_correction_reason', true)
        );
      END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER tr_capture_cancellation_stage_probe AFTER UPDATE OF status ON orders
    FOR EACH ROW EXECUTE FUNCTION capture_cancellation_stage_probe();
  `)

  const branchId = randomUUID(), staffId = randomUUID(), serviceId = randomUUID(), gownServiceId = randomUUID(), freeServiceId = randomUUID()
  const inventoryId = randomUUID(), hangerId = randomUUID(), addonId = randomUUID(), requestId = randomUUID()
  await db.query('INSERT INTO branches(id,name) VALUES ($1,$2)', [branchId, 'Main'])
  await db.query("INSERT INTO staff(id,role,branch_id) VALUES ($1,'admin',$2)", [staffId, branchId])
  await db.query("INSERT INTO service_types(id,name,bundle_kg,bundle_price,excess_kg_price,processing_type) VALUES ($1,'Comforter',5,350,50,'full_service')", [serviceId])
  await db.query("INSERT INTO service_types(id,name,bundle_kg,bundle_price,excess_kg_price,processing_type) VALUES ($1,'Gown',4,250,20,'air_dry_only')", [gownServiceId])
  await db.query("INSERT INTO service_types(id,name,bundle_kg,bundle_price,excess_kg_price,processing_type) VALUES ($1,'Complimentary',1,0,0,'full_service')", [freeServiceId])
  await db.exec(migration) // Safe to rerun without replacing an intentional zero price.
  assert.equal(Number((await db.query('SELECT bundle_price FROM service_types WHERE id=$1', [freeServiceId])).rows[0].bundle_price), 0)
  await db.query("INSERT INTO inventory_items(id,name,unit,current_stock,branch_id) VALUES ($1,'Detergent','ml',100,$2)", [inventoryId, branchId])
  await db.query("INSERT INTO inventory_items(id,name,unit,current_stock,branch_id) VALUES ($1,'Hanger','piece',100,$2)", [hangerId, branchId])
  await db.query('INSERT INTO service_inventory_requirements(branch_id,service_type_id,inventory_item_id,quantity_per_load) VALUES ($1,$2,$3,10)', [branchId, serviceId, inventoryId])
  await db.query('INSERT INTO service_inventory_requirements(branch_id,service_type_id,inventory_item_id,quantity_per_load) VALUES ($1,$2,$3,2)', [branchId, gownServiceId, hangerId])
  await db.query('INSERT INTO service_addon_items(id,branch_id,service_type_id,inventory_item_id,unit_price) VALUES ($1,$2,$3,$4,25)', [addonId, branchId, serviceId, inventoryId])

  const customer = { name: 'Test Customer', phone: '09123456789', email: 'customer@example.com' }
  const order = { client_request_id: requestId, amount_paid: 700, payment_method: 'cash', items: [
    { service_type_id: serviceId, weight_kg: 5 },
    { service_type_id: gownServiceId, weight_kg: 9 },
  ] }
  const call = (requestedOrder = order, requestedBranchId = branchId, requestedStaffId = staffId) => db.query('SELECT (create_branch_order($1,$2,$3::jsonb,$4::jsonb,$5::jsonb,1,NULL)).id AS id',
    [requestedBranchId, requestedStaffId, JSON.stringify(customer), JSON.stringify(requestedOrder), JSON.stringify({ [addonId]: 5 })])
  const first = await call(), second = await call()
  assert.equal(first.rows[0].id, second.rows[0].id)
  assert.equal((await db.query('SELECT count(*)::int AS count FROM orders')).rows[0].count, 1)
  assert.equal((await db.query('SELECT count(*)::int AS count FROM order_items')).rows[0].count, 2)
  assert.equal(Number((await db.query('SELECT current_stock FROM inventory_items WHERE id=$1', [inventoryId])).rows[0].current_stock), 85)
  assert.equal(Number((await db.query('SELECT current_stock FROM inventory_items WHERE id=$1', [hangerId])).rows[0].current_stock), 94)
  assert.equal((await db.query('SELECT count(*)::int AS count FROM inventory_usage_log')).rows[0].count, 3)
  assert.equal((await db.query('SELECT count(*)::int AS count FROM order_item_addons')).rows[0].count, 1)

  const otherBranchId = randomUUID(), otherStaffId = randomUUID()
  await db.query('INSERT INTO branches(id,name) VALUES ($1,$2)', [otherBranchId, 'Other'])
  await db.query("INSERT INTO staff(id,role,branch_id) VALUES ($1,'staff',$2)", [otherStaffId, otherBranchId])
  await assert.rejects(call(order, otherBranchId, otherStaffId), /already been used by another staff account or branch/)

  await db.query("SELECT transition_all_order_items($1,$2,'on_process')", [first.rows[0].id, staffId])
  await db.query("SELECT transition_all_order_items($1,$2,'completed')", [first.rows[0].id, staffId])
  assert.equal((await db.query('SELECT status FROM orders WHERE id=$1', [first.rows[0].id])).rows[0].status, 'ready')
  assert.equal((await db.query("SELECT count(*)::int AS count FROM order_items WHERE order_id=$1 AND status='completed'", [first.rows[0].id])).rows[0].count, 2)
  await db.query("UPDATE orders SET status='on_process', last_updated_by_staff_id=$2 WHERE id=$1", [first.rows[0].id, staffId])
  assert.equal((await db.query("SELECT count(*)::int AS count FROM order_items WHERE order_id=$1 AND status='on_process'", [first.rows[0].id])).rows[0].count, 2)
  await db.query("UPDATE orders SET status='received', last_updated_by_staff_id=$2 WHERE id=$1", [first.rows[0].id, staffId])
  assert.equal((await db.query("SELECT count(*)::int AS count FROM order_items WHERE order_id=$1 AND status='received' AND processing_started_at IS NULL AND completed_at IS NULL", [first.rows[0].id])).rows[0].count, 2)

  await assert.rejects(
    db.query("SELECT cancel_branch_order($1,$2,'Wrong branch attempt')", [first.rows[0].id, otherStaffId]),
    /only cancel orders assigned to your branch/
  )
  assert.equal(Number((await db.query('SELECT current_stock FROM inventory_items WHERE id=$1', [inventoryId])).rows[0].current_stock), 85)

  await db.query("SELECT cancel_branch_order($1,$2,'Customer request')", [first.rows[0].id, staffId])
  assert.equal(Number((await db.query('SELECT current_stock FROM inventory_items WHERE id=$1', [inventoryId])).rows[0].current_stock), 100)
  assert.equal(Number((await db.query('SELECT current_stock FROM inventory_items WHERE id=$1', [hangerId])).rows[0].current_stock), 100)
  assert.equal((await db.query('SELECT count(*)::int AS count FROM inventory_usage_log WHERE reversed_at IS NOT NULL')).rows[0].count, 3)
  assert.equal((await db.query("SELECT count(*)::int AS count FROM order_items WHERE status='cancelled'")).rows[0].count, 2)
  const cancelledOrder = (await db.query('SELECT status, cancelled_at, cancelled_by_staff_id, cancellation_reason FROM orders WHERE id=$1', [first.rows[0].id])).rows[0]
  assert.equal(cancelledOrder.status, 'cancelled')
  assert.ok(cancelledOrder.cancelled_at)
  assert.equal(cancelledOrder.cancelled_by_staff_id, staffId)
  assert.equal(cancelledOrder.cancellation_reason, 'Customer request')
  const cancellationAudit = (await db.query("SELECT * FROM audit_logs WHERE action='cancel' AND record_id=$1", [first.rows[0].id])).rows
  assert.equal(cancellationAudit.length, 1)
  assert.equal(cancellationAudit[0].actor_staff_id, staffId)
  assert.equal(cancellationAudit[0].branch_id, branchId)
  assert.equal(cancellationAudit[0].before_data.status, 'received')
  assert.equal(cancellationAudit[0].after_data.status, 'cancelled')
  assert.equal(cancellationAudit[0].after_data.cancellation_reason, 'Customer request')
  const cancellationStage = (await db.query('SELECT * FROM cancellation_stage_probe WHERE order_id=$1', [first.rows[0].id])).rows[0]
  assert.equal(cancellationStage.transition_type, 'cancel')
  assert.equal(cancellationStage.reason, 'Customer request')
  assert.equal((await db.query('SELECT count(*)::int AS count FROM inventory_adjustments WHERE order_id=$1', [first.rows[0].id])).rows[0].count, 3)
  assert.equal(Number((await db.query('SELECT sum(quantity_change) AS total FROM inventory_adjustments WHERE order_id=$1', [first.rows[0].id])).rows[0].total), 21)
  await assert.rejects(
    db.query("SELECT cancel_branch_order($1,$2,'Try twice')", [first.rows[0].id, staffId]),
    /already cancelled/
  )
  assert.equal((await db.query("SELECT count(*)::int AS count FROM audit_logs WHERE action='cancel' AND record_id=$1", [first.rows[0].id])).rows[0].count, 1)
  assert.equal((await db.query('SELECT count(*)::int AS count FROM inventory_adjustments WHERE order_id=$1', [first.rows[0].id])).rows[0].count, 3)

  await db.query('UPDATE inventory_items SET deleted_at=now() WHERE id=$1', [hangerId])
  await assert.rejects(call({ ...order, client_request_id: randomUUID() }), /automatic deduction items are unavailable/)
  await db.query('UPDATE inventory_items SET deleted_at=NULL WHERE id=$1', [hangerId])

  await db.query('UPDATE inventory_items SET current_stock=12 WHERE id=$1', [inventoryId])
  await assert.rejects(call({ ...order, client_request_id: randomUUID() }), /only 12 ml remaining; 15(?:\.0+)? ml is required/)
  assert.equal(Number((await db.query('SELECT current_stock FROM inventory_items WHERE id=$1', [inventoryId])).rows[0].current_stock), 12)
  assert.equal((await db.query('SELECT count(*)::int AS count FROM orders')).rows[0].count, 1)
})
