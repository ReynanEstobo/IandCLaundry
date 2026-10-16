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
  const removeNotesMigration = await readFile(new URL('../supabase_migrations/20261001_remove_note_fields.sql', import.meta.url), 'utf8')
  const cashOnlyMigration = await readFile(new URL('../supabase_migrations/20261001_z_cash_only_payments.sql', import.meta.url), 'utf8')
  const inventoryIntegrityMigration = await readFile(new URL('../supabase_migrations/20261003_service_inventory_integrity.sql', import.meta.url), 'utf8')
  const delinkArchivedInventoryMigration = await readFile(new URL('../supabase_migrations/20261004_delink_archived_service_inventory.sql', import.meta.url), 'utf8')
  const preserveOrderAddonHistoryMigration = await readFile(new URL('../supabase_migrations/20261005_preserve_order_addon_history.sql', import.meta.url), 'utf8')
  const repairOrderAddonHistoryForeignKeyMigration = await readFile(new URL('../supabase_migrations/20261006_preserve_archived_order_addon_history.sql', import.meta.url), 'utf8')
  const rejectOrderOverpaymentMigration = await readFile(new URL('../supabase_migrations/20261008_reject_order_overpayment.sql', import.meta.url), 'utf8')
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
  await db.exec(removeNotesMigration)
  await db.exec(cashOnlyMigration)
  await db.exec(inventoryIntegrityMigration)
  await db.exec(delinkArchivedInventoryMigration)
  await db.exec(preserveOrderAddonHistoryMigration)
  await db.exec(repairOrderAddonHistoryForeignKeyMigration)
  await db.exec(rejectOrderOverpaymentMigration)
  for (const table of ['customers', 'orders', 'order_items', 'payments']) {
    const result = await db.query(`SELECT COUNT(*)::int AS count FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 AND column_name='notes'`, [table])
    assert.equal(result.rows[0].count, 0)
  }
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
  const call = (requestedOrder = order, requestedBranchId = branchId, requestedStaffId = staffId, requestedAddons = { [addonId]: 5 }) => db.query('SELECT (create_branch_order($1,$2,$3::jsonb,$4::jsonb,$5::jsonb,1,NULL)).id AS id',
    [requestedBranchId, requestedStaffId, JSON.stringify(customer), JSON.stringify(requestedOrder), JSON.stringify(requestedAddons)])
  await assert.rejects(
    call({ ...order, client_request_id: randomUUID(), payment_method: 'gcash' }),
    /Cash is the only accepted payment method/,
  )
  await assert.rejects(
    call({ ...order, client_request_id: randomUUID(), amount_paid: 826 }),
    /Payment cannot be greater than the full order total/,
  )
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
  await assert.rejects(
    call({ ...order, client_request_id: randomUUID() }, branchId, otherStaffId),
    /only create orders for your assigned branch/,
  )
  await assert.rejects(
    call({ ...order, client_request_id: randomUUID() }, branchId, randomUUID()),
    /valid active staff account/,
  )
  await assert.rejects(
    db.query("SELECT transition_all_order_items($1,$2,'on_process')", [first.rows[0].id, otherStaffId]),
    /only process service items assigned to your branch/,
  )

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

  // Archiving an item automatically disables its service link, so affected
  // orders continue without consuming the archived item.
  await db.query('UPDATE inventory_items SET deleted_at=now() WHERE id=$1', [hangerId])
  assert.equal((await db.query('SELECT is_active FROM service_inventory_requirements WHERE inventory_item_id=$1', [hangerId])).rows[0].is_active, false)
  const orderAfterArchive = await call({ ...order, client_request_id: randomUUID() })
  assert.ok(orderAfterArchive.rows[0].id)
  await db.query("SELECT cancel_branch_order($1,$2,'Test cleanup after archive')", [orderAfterArchive.rows[0].id, staffId])

  // Simulate a legacy/corrupt add-on config whose item belongs to another
  // branch. The final row trigger rejects it and the RPC transaction rolls
  // back before stock can be taken from that branch.
  const foreignInventoryId = randomUUID()
  await db.query("INSERT INTO inventory_items(id,name,unit,current_stock,branch_id) VALUES ($1,'Foreign detergent','ml',40,$2)", [foreignInventoryId, otherBranchId])
  await db.exec('ALTER TABLE service_addon_items DISABLE TRIGGER tr_validate_service_addon_item')
  await db.query('UPDATE service_addon_items SET inventory_item_id=$1 WHERE id=$2', [foreignInventoryId, addonId])
  await assert.rejects(
    call({ ...order, client_request_id: randomUUID() }),
    /add-on configuration or inventory item is unavailable for this order branch and service/,
  )
  assert.equal(Number((await db.query('SELECT current_stock FROM inventory_items WHERE id=$1', [foreignInventoryId])).rows[0].current_stock), 40)
  assert.equal((await db.query('SELECT count(*)::int AS count FROM orders')).rows[0].count, 2)
  await db.query('UPDATE service_addon_items SET inventory_item_id=$1 WHERE id=$2', [inventoryId, addonId])
  await db.exec('ALTER TABLE service_addon_items ENABLE TRIGGER tr_validate_service_addon_item')

  await db.query('UPDATE inventory_items SET current_stock=12 WHERE id=$1', [inventoryId])
  await assert.rejects(call({ ...order, client_request_id: randomUUID() }), /only 12 ml remaining; 15(?:\.0+)? ml is required/)
  assert.equal(Number((await db.query('SELECT current_stock FROM inventory_items WHERE id=$1', [inventoryId])).rows[0].current_stock), 12)
  assert.equal((await db.query('SELECT count(*)::int AS count FROM orders')).rows[0].count, 2)

  // Archiving and then restoring inventory must leave both kinds of service
  // links inactive. Existing order add-on snapshots remain readable, and a
  // new order without that add-on does not consume the restored stock.
  const historicalAddonId = (await db.query(
    'SELECT id FROM order_item_addons WHERE order_item_id IN (SELECT id FROM order_items WHERE order_id=$1)',
    [first.rows[0].id],
  )).rows[0].id
  const historicalBeforeArchive = (await db.query(
    'SELECT item_name_snapshot, quantity, unit_price_snapshot, subtotal FROM order_item_addons WHERE id=$1',
    [historicalAddonId],
  )).rows[0]
  await db.query('UPDATE inventory_items SET deleted_at=now() WHERE id=$1', [inventoryId])
  assert.equal((await db.query(
    'SELECT (SELECT count(*) FROM service_inventory_requirements WHERE inventory_item_id=$1 AND is_active IS TRUE) + (SELECT count(*) FROM service_addon_items WHERE inventory_item_id=$1 AND is_active IS TRUE) AS active_count',
    [inventoryId],
  )).rows[0].active_count, 0)
  await db.query('UPDATE inventory_items SET deleted_at=NULL WHERE id=$1', [inventoryId])
  assert.equal((await db.query(
    'SELECT (SELECT count(*) FROM service_inventory_requirements WHERE inventory_item_id=$1 AND is_active IS TRUE) + (SELECT count(*) FROM service_addon_items WHERE inventory_item_id=$1 AND is_active IS TRUE) AS active_count',
    [inventoryId],
  )).rows[0].active_count, 0)
  await assert.rejects(
    call({ ...order, client_request_id: randomUUID() }),
    /selected add-ons are unavailable for this branch/,
  )
  const orderAfterRestore = await call({ ...order, client_request_id: randomUUID() }, branchId, staffId, {})
  assert.ok(orderAfterRestore.rows[0].id)
  assert.equal(Number((await db.query('SELECT current_stock FROM inventory_items WHERE id=$1', [inventoryId])).rows[0].current_stock), 12)
  const historicalAfterArchive = (await db.query(
    'SELECT item_name_snapshot, quantity, unit_price_snapshot, subtotal FROM order_item_addons WHERE id=$1',
    [historicalAddonId],
  )).rows[0]
  assert.deepEqual(historicalAfterArchive, historicalBeforeArchive)
  await db.query("SELECT cancel_branch_order($1,$2,'Test cleanup after restore')", [orderAfterRestore.rows[0].id, staffId])

  // Removing a service add-on config detaches the FK but preserves the order's
  // historical item, quantity, and price snapshots.
  await assert.rejects(
    db.query('UPDATE order_item_addons SET service_addon_item_id=NULL, quantity=6 WHERE id=$1', [historicalAddonId]),
    /selected add-on configuration or inventory item is unavailable/,
  )
  await db.query('DELETE FROM service_addon_items WHERE id=$1', [addonId])
  const historicalAddon = (await db.query(
    'SELECT service_addon_item_id, inventory_item_id, item_name_snapshot, quantity, unit_price_snapshot, subtotal FROM order_item_addons WHERE order_item_id IN (SELECT id FROM order_items WHERE order_id=$1)',
    [first.rows[0].id],
  )).rows[0]
  assert.equal(historicalAddon.service_addon_item_id, null)
  assert.equal(historicalAddon.inventory_item_id, inventoryId)
  assert.equal(historicalAddon.item_name_snapshot, 'Detergent')
  assert.equal(Number(historicalAddon.quantity), 5)
  assert.equal(Number(historicalAddon.unit_price_snapshot), 25)
  assert.equal(Number(historicalAddon.subtotal), 125)

  // A 50% loyalty discount must be applied before the 50% downpayment floor.
  // One completed order makes the next order eligible at the configured
  // second-order discount milestone: ₱350 becomes ₱175, so ₱87.50 is due.
  await db.query(`UPDATE settings SET loyalty_enabled=true, loyalty_discount_milestone=2,
    loyalty_free_load_milestone=10, loyalty_discount_percent=50, loyalty_program_started_at=now() - interval '1 day'`)
  const customerId = (await db.query('SELECT customer_id FROM orders WHERE id=$1', [first.rows[0].id])).rows[0].customer_id
  await db.query(`INSERT INTO orders(customer_id, service_type_id, weight_kg, total_price, amount_paid,
    payment_method, payment_status, branch, branch_id, status, picked_up_at)
    VALUES ($1,$2,5,350,350,'cash','paid','Main',$3,'released',now())`, [customerId, serviceId, branchId])
  const loyaltyOrder = {
    client_request_id: randomUUID(), amount_paid: 88, payment_method: 'cash',
    items: [{ service_type_id: serviceId, weight_kg: 5 }],
  }
  await assert.rejects(call({ ...loyaltyOrder, amount_paid: 87.49 }, branchId, staffId, {}), /Minimum 50% payment required: 87\.5/)
  const discountedOrder = await call(loyaltyOrder, branchId, staffId, {})
  const discountedOrderRow = (await db.query('SELECT total_price, amount_paid, loyalty_discount_amount FROM orders WHERE id=$1', [discountedOrder.rows[0].id])).rows[0]
  assert.equal(Number(discountedOrderRow.total_price), 175)
  assert.equal(Number(discountedOrderRow.amount_paid), 88)
  assert.equal(Number(discountedOrderRow.loyalty_discount_amount), 175)
})
