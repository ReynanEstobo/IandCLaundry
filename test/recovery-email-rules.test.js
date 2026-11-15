import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import { authClient, configureRuntimeEnv, database } from '../backend/config/supabase.js'
import { confirmEmailChange } from '../backend/controllers/emailChangeController.js'
import { provisionStaff, updateProvisionedStaff } from '../backend/controllers/staffProvisionController.js'
import { updatePassword } from '../backend/controllers/authController.js'

const MIGRATION = () => readFile(new URL('../supabase_migrations/20261115_recovery_email_rules.sql', import.meta.url), 'utf8')
const ME = '00000000-0000-0000-0000-00000000000a'

// The tables the email-change functions use, with the same rules as live.
async function staffDatabase(t) {
  const db = new PGlite()
  t.after(() => db.close())
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    CREATE TABLE public.staff (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), auth_id uuid, full_name text, contact_email text, email text,
      phone text, must_change_password boolean DEFAULT false, branch_id uuid, deleted_at timestamptz);
    INSERT INTO public.staff(auth_id, full_name, contact_email, phone) VALUES ('${ME}', 'Richelle Roxas', 'me@school.edu.ph', '0912345678');
    INSERT INTO public.staff(full_name, contact_email, deleted_at) VALUES ('Old test account', 'reused@gmail.com', now());
    INSERT INTO public.staff(full_name, contact_email) VALUES ('Other admin', 'taken@gmail.com');
    ALTER TABLE public.staff ADD CONSTRAINT staff_phone_format_check CHECK (phone IS NULL OR phone = '' OR phone ~ '^09[0-9]{9}$') NOT VALID;
    ALTER TABLE public.staff ADD CONSTRAINT staff_contact_email_format_check
      CHECK (contact_email IS NULL OR contact_email = '' OR contact_email ~ '^[^[:space:]@]+@[^[:space:]@]+\\.[^[:space:]@]+$') NOT VALID;
    CREATE TABLE public.email_change_otps (id uuid PRIMARY KEY, auth_user_id uuid, staff_id uuid, previous_email text, new_email text,
      code_hash text, attempts int DEFAULT 0, requested_at timestamptz DEFAULT now(), expires_at timestamptz, consumed_at timestamptz);
    CREATE TABLE public.password_change_otps (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), auth_user_id uuid, consumed_at timestamptz);
    CREATE TABLE public.audit_logs (id serial, action text, table_name text, record_id uuid, actor_staff_id uuid, branch_id uuid, before_data jsonb, after_data jsonb);
  `)
  return db
}
const begin = (db, id, address) => db.query(`SELECT public.begin_account_email_change($1, $2, 'me@school.edu.ph', $3, 'hash') AS r`, [ME, id, address]).then(r => r.rows[0].r)
const confirm = (db, id) => db.query(`SELECT public.confirm_account_email_change($1, $2, 'hash') AS r`, [ME, id]).then(r => r.rows[0].r)

test('an address another active account uses is refused before any code is sent; a deleted account’s address can be reused', async t => {
  const db = await staffDatabase(t)
  // Before the update, Richelle's 10-digit phone makes the save itself fail.
  await db.exec(`UPDATE public.staff SET phone = phone WHERE false`)
  await assert.rejects(db.query(`UPDATE public.staff SET contact_email = 'x@gmail.com' WHERE auth_id = '${ME}'`), /staff_phone_format_check/)

  const migration = await MIGRATION()
  await db.exec(migration)
  await db.exec(migration)

  const taken = await begin(db, '00000000-0000-0000-0000-000000000001', 'TAKEN@gmail.com')
  assert.equal(taken.error, 'This email is already used by another account. Choose another address.')
  assert.equal((await db.query(`SELECT count(*)::int n FROM public.email_change_otps`)).rows[0].n, 0, 'no code was created')

  assert.equal((await begin(db, '00000000-0000-0000-0000-000000000002', 'reused@gmail.com')).success, true)
  const done = await confirm(db, '00000000-0000-0000-0000-000000000002')
  assert.equal(done.success, true, JSON.stringify(done))
  const me = (await db.query(`SELECT contact_email, phone FROM public.staff WHERE auth_id = '${ME}'`)).rows[0]
  assert.deepEqual(me, { contact_email: 'reused@gmail.com', phone: null }, 'the invalid phone was cleared, so the save worked')
  const validated = (await db.query(`SELECT bool_and(convalidated) v FROM pg_constraint WHERE conname IN ('staff_phone_format_check', 'staff_contact_email_format_check')`)).rows[0].v
  assert.equal(validated, true, 'both rules now cover every record')
})

test('if another account takes the address after the code was sent, confirming refuses it', async t => {
  const db = await staffDatabase(t)
  await db.exec(await MIGRATION())
  assert.equal((await begin(db, '00000000-0000-0000-0000-000000000003', 'late@gmail.com')).success, true)
  await db.exec(`INSERT INTO public.staff(full_name, contact_email) VALUES ('Faster admin', 'late@gmail.com')`)
  assert.equal((await confirm(db, '00000000-0000-0000-0000-000000000003')).error, 'This email is already used by another account. Choose another address.')
})

test('a refused save shows the reason instead of "Internal server error"', async t => {
  configureRuntimeEnv({ PASSWORD_OTP_SECRET: 'test' })
  const original = database.rpc
  t.after(() => { database.rpc = original; configureRuntimeEnv(null) })
  database.rpc = async () => ({ data: null, error: { code: '23514', message: 'new row for relation "staff" violates check constraint "staff_phone_format_check"' } })
  const identity = { staffId: 'staff-1', role: 'admin', user: { id: 'auth-1', email: 'a@accounts.iclaundry.local' } }
  await assert.rejects(confirmEmailChange({ challengeId: '00000000-0000-4000-8000-000000000000', otp: '123456' }, identity),
    error => error.status === 409 && /phone number saved on this account is not valid/.test(error.message))
  database.rpc = async () => ({ data: null, error: { code: 'XX000', message: 'something internal about table staff' } })
  await assert.rejects(confirmEmailChange({ challengeId: '00000000-0000-4000-8000-000000000000', otp: '123456' }, identity),
    error => error.status === 400 && /Unable to confirm the email change/.test(error.message) && !/table staff/.test(error.message))
})

test('the Staff page cannot give two active accounts the same recovery email', async t => {
  const accounts = [{ id: 'other', full_name: 'Chell Roxas', contact_email: 'shared@gmail.com' }]
  const original = database.from
  t.after(() => { database.from = original })
  database.from = table => {
    if (table !== 'staff') throw new Error(`unexpected table ${table}`)
    let pattern = null
    const lookup = {
      is: () => lookup,
      ilike: (_column, value) => { pattern = value; return lookup },
      limit: async () => ({ data: accounts.filter(a => a.contact_email === pattern), error: null }),
      eq: () => lookup,
      maybeSingle: async () => ({ data: { id: 'me', role: 'admin', full_name: 'Richelle Roxas', contact_email: 'mine@gmail.com' }, error: null }),
    }
    return { select: () => lookup }
  }
  const admin = { staffId: 'owner', role: 'admin' }
  await assert.rejects(provisionStaff({ full_name: 'New Admin', role: 'admin', contact_email: 'Shared@gmail.com' }, admin),
    error => error.status === 409 && /already used by Chell Roxas/.test(error.message))
  await assert.rejects(updateProvisionedStaff({ staffId: 'me', full_name: 'Richelle Roxas', role: 'admin', contact_email: 'shared@gmail.com' }, admin),
    error => error.status === 409 && /already used by Chell Roxas/.test(error.message))
  accounts[0].id = 'me'
  await assert.rejects(updateProvisionedStaff({ staffId: 'me', full_name: 'Richelle Roxas', role: 'admin', contact_email: 'shared@gmail.com', phone: '123' }, admin),
    /Phone number/, 'keeping your own address is allowed; the next check (phone) runs')
})

test('an ordinary password change does not re-save the staff record; only an activation does', async t => {
  const touched = []
  const originalFrom = database.from
  const originalAuth = Object.getOwnPropertyDescriptor(database, 'auth')
  const originalClient = Object.getOwnPropertyDescriptor(authClient, 'auth')
  t.after(() => { database.from = originalFrom; Object.defineProperty(database, 'auth', originalAuth); Object.defineProperty(authClient, 'auth', originalClient) })
  Object.defineProperty(database, 'auth', { configurable: true, value: { admin: { updateUserById: async () => ({ error: null }) } } })
  Object.defineProperty(authClient, 'auth', { configurable: true, value: { signInWithPassword: async () => ({ data: {}, error: null }) } })
  database.from = table => ({
    update: () => ({ eq: async () => { touched.push(table); return table === 'staff' ? { error: { code: '23514', message: 'violates check constraint "staff_phone_format_check"' } } : { error: null } } }),
    insert: async () => { touched.push(table); return { error: null } },
  })
  const admin = { staffId: 's1', role: 'admin', user: { id: 'u1', email: 'a@accounts.iclaundry.local' }, mustChangePassword: false }
  assert.deepEqual(await updatePassword({ currentPassword: 'Old!Passw0rd-123', newPassword: 'Malinis!Labada9x2026' }, admin), { success: true })
  assert.equal(touched.includes('staff'), false)
  await assert.rejects(updatePassword({ newPassword: 'Malinis!Labada9x2026' }, { ...admin, mustChangePassword: true }),
    error => error.status === 409 && /phone number saved on this account is not valid/.test(error.message))
})
