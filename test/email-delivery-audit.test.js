import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { PGlite } from '@electric-sql/pglite'

test('email delivery audit is append-only and links retries to the failed attempt', async t => {
  const db = new PGlite()
  t.after(() => db.close())
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    CREATE FUNCTION uuid_generate_v4() RETURNS UUID LANGUAGE sql AS $$ SELECT gen_random_uuid() $$;
    CREATE TABLE branches (id UUID PRIMARY KEY);
    CREATE TABLE staff (id UUID PRIMARY KEY);
    CREATE TABLE orders (id UUID PRIMARY KEY);
  `)
  const migration = await readFile(new URL('../supabase_migrations/20261002_email_delivery_audit.sql', import.meta.url), 'utf8')
  await db.exec(migration)
  await db.exec(migration)

  const branchId = randomUUID(), staffId = randomUUID(), orderId = randomUUID()
  await db.query('INSERT INTO branches(id) VALUES ($1)', [branchId])
  await db.query('INSERT INTO staff(id) VALUES ($1)', [staffId])
  await db.query('INSERT INTO orders(id) VALUES ($1)', [orderId])
  const failedId = randomUUID(), retryId = randomUUID()
  await db.query(`INSERT INTO email_delivery_audit
    (id, order_id, branch_id, attempted_by_staff_id, notification_type, recipient_email,
     subject, message_body, order_number, garment_details, status, error_message)
    VALUES ($1,$2,$3,$4,'ready_for_pickup','customer@example.com','Ready','Pickup notice',
      'IC-20261002-0001','[{"service":"Wash and Fold","weight_kg":5}]','failed','Provider unavailable')`,
    [failedId, orderId, branchId, staffId])
  await db.query(`INSERT INTO email_delivery_audit
    (id, order_id, branch_id, attempted_by_staff_id, retry_of_id, notification_type,
     recipient_email, subject, message_body, order_number, garment_details, status, provider)
    SELECT $1,order_id,branch_id,$2,id,notification_type,recipient_email,subject,message_body,
      order_number,garment_details,'sent','gmail_smtp'
    FROM email_delivery_audit WHERE id=$3`, [retryId, staffId, failedId])

  const { rows } = await db.query('SELECT id,status,retry_of_id,garment_details FROM email_delivery_audit ORDER BY attempted_at,id')
  assert.equal(rows.length, 2)
  assert.equal(rows.find(row => row.id === retryId).retry_of_id, failedId)
  assert.equal(rows.find(row => row.id === failedId).garment_details[0].service, 'Wash and Fold')
  await assert.rejects(db.query("UPDATE email_delivery_audit SET status='sent' WHERE id=$1", [failedId]), /append-only/)
  await assert.rejects(db.query('DELETE FROM email_delivery_audit WHERE id=$1', [failedId]), /append-only/)
})
