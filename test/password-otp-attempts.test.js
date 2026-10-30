import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import { configureRuntimeEnv, database } from '../backend/config/supabase.js'
import { verifyPasswordChangeOtp } from '../backend/controllers/authController.js'

const SECRET = 'test-otp-secret'
const RIGHT_CODE = '123456'

// Real SQL for the attempt check; the service's challenge lookup and RPC call
// are pointed at the same database.
async function otpDatabase(t) {
  const db = new PGlite()
  const originalFrom = database.from
  const originalRpc = database.rpc
  t.after(async () => {
    database.from = originalFrom
    database.rpc = originalRpc
    configureRuntimeEnv(null)
    await db.close()
  })
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    CREATE TABLE public.password_change_otps (
      id UUID PRIMARY KEY, auth_user_id UUID NOT NULL, code_hash TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0 AND attempts <= 5),
      requested_at TIMESTAMPTZ NOT NULL DEFAULT now(), expires_at TIMESTAMPTZ NOT NULL, consumed_at TIMESTAMPTZ
    );
  `)
  const migration = await readFile(new URL('../supabase_migrations/20261030_z_atomic_password_otp_check.sql', import.meta.url), 'utf8')
  await db.exec(migration)
  await db.exec(migration) // Safe to rerun.
  configureRuntimeEnv({ PASSWORD_OTP_SECRET: SECRET })

  const userId = randomUUID()
  const challengeId = randomUUID()
  const codeHash = code => createHash('sha256').update(`${SECRET}:${challengeId}:${code}`).digest('hex')
  await db.query(
    "INSERT INTO password_change_otps (id, auth_user_id, code_hash, expires_at) VALUES ($1, $2, $3, now() + interval '10 minutes')",
    [challengeId, userId, codeHash(RIGHT_CODE)],
  )
  database.from = table => {
    assert.equal(table, 'password_change_otps')
    return {
      select() { return this }, eq() { return this }, is() { return this }, order() { return this }, limit() { return this },
      async maybeSingle() {
        const { rows } = await db.query('SELECT * FROM password_change_otps WHERE id = $1 AND consumed_at IS NULL', [challengeId])
        return { data: rows[0] || null, error: null }
      },
    }
  }
  database.rpc = async (name, args) => {
    const { rows } = await db.query(`SELECT public.${name}($1, $2, $3) AS outcome`, [args.p_challenge_id, args.p_auth_user_id, args.p_code_hash])
    return { data: rows[0].outcome, error: null }
  }
  const attempts = async () => (await db.query('SELECT attempts FROM password_change_otps')).rows[0].attempts
  return { db, identity: { user: { id: userId }, mustChangePassword: false }, attempts }
}

test('password codes allow five wrong tries even when guesses arrive together', async t => {
  const { identity, attempts } = await otpDatabase(t)
  const guesses = await Promise.allSettled(
    Array.from({ length: 20 }, (_, index) => verifyPasswordChangeOtp({ otp: String(200000 + index) }, identity)),
  )
  const messages = guesses.map(result => result.reason?.message)
  assert.equal(messages.filter(message => message === 'Invalid verification code.').length, 5)
  assert.equal(messages.filter(message => message === 'Your verification code has expired. Request a new code.').length, 15)
  assert.equal(await attempts(), 5)
  // After five wrong tries even the right code is refused until a new one is requested.
  await assert.rejects(verifyPasswordChangeOtp({ otp: RIGHT_CODE }, identity), /has expired/)
})

test('the right password code is accepted without using up a try', async t => {
  const { db, identity, attempts } = await otpDatabase(t)
  await assert.rejects(verifyPasswordChangeOtp({ otp: '000000' }, identity), /^Error: Invalid verification code\.$/)
  await assert.rejects(verifyPasswordChangeOtp({ otp: '12345' }, identity), /Enter the 6-digit verification code/)
  assert.deepEqual(await verifyPasswordChangeOtp({ otp: RIGHT_CODE }, identity), { success: true })
  // Checking the code does not consume it; the password update does.
  assert.deepEqual(await verifyPasswordChangeOtp({ otp: RIGHT_CODE }, identity), { success: true })
  assert.equal(await attempts(), 1)

  await db.exec("UPDATE password_change_otps SET expires_at = now() - interval '1 second'")
  await assert.rejects(verifyPasswordChangeOtp({ otp: RIGHT_CODE }, identity), /has expired/)
})
