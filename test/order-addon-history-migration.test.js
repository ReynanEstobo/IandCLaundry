import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { PGlite } from '@electric-sql/pglite'

test('configuration deletion detaches but preserves historical order add-on snapshots', async t => {
  const db = new PGlite()
  t.after(() => db.close())
  await db.exec(`
    CREATE TABLE branches (id uuid PRIMARY KEY);
    CREATE TABLE service_types (id uuid PRIMARY KEY);
    CREATE TABLE inventory_items (id uuid PRIMARY KEY, branch_id uuid, deleted_at timestamptz);
    CREATE TABLE order_items (id uuid PRIMARY KEY, branch_id uuid, service_type_id uuid);
    CREATE TABLE service_addon_items (
      id uuid PRIMARY KEY, branch_id uuid, service_type_id uuid,
      inventory_item_id uuid, is_active boolean
    );
    CREATE TABLE order_item_addons (
      id uuid PRIMARY KEY, order_item_id uuid NOT NULL REFERENCES order_items(id),
      branch_id uuid NOT NULL REFERENCES branches(id),
      service_addon_item_id uuid,
      inventory_item_id uuid NOT NULL REFERENCES inventory_items(id),
      item_name_snapshot text NOT NULL, quantity numeric NOT NULL,
      unit_price_snapshot numeric NOT NULL, subtotal numeric NOT NULL,
      CONSTRAINT order_item_addons_service_addon_item_id_fkey
        FOREIGN KEY (service_addon_item_id) REFERENCES service_addon_items(id)
    );
  `)
  const historyMigration = await readFile(new URL('../supabase_migrations/20261005_preserve_order_addon_history.sql', import.meta.url), 'utf8')
  const fkMigration = await readFile(new URL('../supabase_migrations/20261006_preserve_archived_order_addon_history.sql', import.meta.url), 'utf8')
  await db.exec(fkMigration)
  await db.exec(historyMigration)

  const branchId = randomUUID(), serviceId = randomUUID(), inventoryId = randomUUID()
  const orderItemId = randomUUID(), configId = randomUUID(), historyId = randomUUID()
  await db.query('INSERT INTO branches VALUES ($1)', [branchId])
  await db.query('INSERT INTO service_types VALUES ($1)', [serviceId])
  await db.query('INSERT INTO inventory_items VALUES ($1,$2,NULL)', [inventoryId, branchId])
  await db.query('INSERT INTO order_items VALUES ($1,$2,$3)', [orderItemId, branchId, serviceId])
  await db.query('INSERT INTO service_addon_items VALUES ($1,$2,$3,$4,true)', [configId, branchId, serviceId, inventoryId])
  await db.query(
    'INSERT INTO order_item_addons VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
    [historyId, orderItemId, branchId, configId, inventoryId, 'Detergent snapshot', 2, 3.5, 7],
  )

  await db.query('DELETE FROM service_addon_items WHERE id=$1', [configId])
  const saved = (await db.query(
    'SELECT service_addon_item_id, inventory_item_id, item_name_snapshot, quantity, unit_price_snapshot, subtotal FROM order_item_addons WHERE id=$1',
    [historyId],
  )).rows[0]
  assert.equal(saved.service_addon_item_id, null)
  assert.equal(saved.inventory_item_id, inventoryId)
  assert.equal(saved.item_name_snapshot, 'Detergent snapshot')
  assert.equal(Number(saved.quantity), 2)
  assert.equal(Number(saved.unit_price_snapshot), 3.5)
  assert.equal(Number(saved.subtotal), 7)
})
