import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { PGlite } from '@electric-sql/pglite'

test('inventory corrections and restocks preserve the signed-in audit actor', async () => {
  const db = new PGlite()
  await db.exec(`
    CREATE ROLE service_role;
    CREATE TABLE staff (id uuid PRIMARY KEY, deleted_at timestamptz);
    CREATE TABLE inventory_items (
      id uuid PRIMARY KEY, name text, branch text, branch_id uuid, unit text,
      current_stock numeric, minimum_stock numeric, cost_per_unit numeric,
      updated_at timestamptz DEFAULT now()
    );
    CREATE TABLE inventory_restocks (
      id bigserial PRIMARY KEY, item_id uuid, quantity_added numeric,
      cost_total numeric, supplier text
    );
    CREATE TABLE expenses (
      id bigserial PRIMARY KEY, category text, description text, amount numeric,
      expense_date date, branch text, branch_id uuid
    );
    CREATE TABLE audit_logs (
      id bigserial PRIMARY KEY, table_name text, record_id uuid,
      actor_staff_id uuid, before_stock numeric, after_stock numeric
    );
    CREATE FUNCTION capture_inventory_actor() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      INSERT INTO audit_logs(table_name, record_id, actor_staff_id, before_stock, after_stock)
      VALUES ('inventory_items', NEW.id,
        NULLIF(current_setting('app.audit_actor_staff_id', true), '')::uuid,
        OLD.current_stock, NEW.current_stock);
      RETURN NEW;
    END $$;
    CREATE TRIGGER tr_inventory_actor AFTER UPDATE ON inventory_items
      FOR EACH ROW EXECUTE FUNCTION capture_inventory_actor();
  `)
  const migration = await readFile(new URL('../supabase_migrations/20261122_inventory_audit_actor.sql', import.meta.url), 'utf8')
  await db.exec(migration)

  const staffId = '10000000-0000-0000-0000-000000000001'
  const itemId = '20000000-0000-0000-0000-000000000001'
  await db.query('INSERT INTO staff(id) VALUES ($1)', [staffId])
  await db.query("INSERT INTO inventory_items(id,name,branch,unit,current_stock,minimum_stock,cost_per_unit) VALUES ($1,'Soap','Main','pcs',10,2,5)", [itemId])

  await db.query('SELECT update_inventory_item_with_actor($1,$2::jsonb,$3)', [itemId, JSON.stringify({ current_stock: 12 }), staffId])
  await db.query('SELECT restock_branch_inventory($1,$2,$3,$4,$5)', [itemId, 3, 0, '', staffId])

  const actors = (await db.query('SELECT actor_staff_id, before_stock, after_stock FROM audit_logs ORDER BY id')).rows
  assert.deepEqual(actors.map(row => row.actor_staff_id), [staffId, staffId])
  assert.deepEqual(actors.map(row => [Number(row.before_stock), Number(row.after_stock)]), [[10, 12], [12, 15]])
  await db.close()
})
