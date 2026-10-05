import assert from 'node:assert/strict'
import test from 'node:test'
import { authClient, database } from '../backend/config/supabase.js'
import { login, requestForgotPasswordOtp, resetForgottenPassword } from '../backend/controllers/authController.js'
import { authenticate } from '../backend/middleware/authenticate.js'

test('Recycle Bin accounts cannot log in, recover passwords, or reuse sessions', async t => {
  const row = { id: 'staff-id', auth_id: 'auth-id', email: 'legacy@example.com', contact_email: 'recovery@example.com',
    username: 'staff.user', staff_code: 'IC-STAFF-ABC12345', role: 'staff', deleted_at: '2026-09-09', branch_id: 'main' }
  let signIns = 0
  const originalFrom = database.from
  const authDescriptor = Object.getOwnPropertyDescriptor(authClient, 'auth')
  t.after(() => { database.from = originalFrom; Object.defineProperty(authClient, 'auth', authDescriptor) })
  database.from = table => {
    assert.equal(table, 'staff', 'Deleted accounts must not access OTP storage')
    const filters = []
    return {
      select() { return this },
      is(key, value) { filters.push(item => (item[key] ?? null) === value); return this },
      eq(key, value) { filters.push(item => item[key] === value); return this },
      ilike(key, value) {
        const literal = value.replace(/\\([\\%_])/g, '$1').toLowerCase()
        filters.push(item => String(item[key] || '').toLowerCase() === literal)
        return this
      },
      async maybeSingle() { return { data: filters.every(filter => filter(row)) ? { ...row } : null, error: null } },
    }
  }
  Object.defineProperty(authClient, 'auth', { configurable: true, value: {
    async signInWithPassword({password}) {
      signIns++
      if (password !== 'correct-password') return { error: {message: 'Invalid login credentials'} }
      return { data: {user: {id: row.auth_id, email: row.email, user_metadata: {}}, session: {access_token: 'test-token'}} }
    },
    async getUser() { return {data: {user: {id: row.auth_id, email: row.email}}} },
  } })
  const missing = error => error.message === 'Account does not exist.'
  for (const identifier of [row.username, row.staff_code, row.email]) {
    await assert.rejects(login({identifier, password:'correct-password'}), missing)
  }
  for (const identifier of [row.username, row.staff_code, row.email, row.contact_email, 'unknown']) {
    const requestResult = await requestForgotPasswordOtp({ identifier })
    assert.deepEqual(requestResult, {
      success: true,
      cooldownSeconds: 180,
      message: 'If an active account has a recovery email, a verification code has been sent.',
    })
    await assert.rejects(
      resetForgottenPassword({ identifier, otp: '123456', newPassword: 'new-password-long' }),
      /verification code is invalid or expired/i,
    )
  }
  assert.equal(signIns, 0)
  const request = new Request('https://example.test/api/auth/password/otp', {headers:{Authorization:'Bearer test-token'}})
  await assert.rejects(authenticate(request), missing)
  // Restore the same legacy account. Its existing login and scope work again.
  row.deleted_at = null
  for (const role of ['staff', 'admin']) {
    row.role = role
    for (const identifier of [row.username, row.staff_code, row.email.toUpperCase()]) {
      const result = await login({identifier, password:'correct-password'})
      assert.equal(result.role, role)
      assert.equal(result.session.access_token, 'test-token')
    }
  }
  await assert.rejects(login({identifier:row.username,password:'wrong'}), /Invalid login credentials/)
  await assert.rejects(login({identifier:'staff.%',password:'correct-password'}), missing)
  const identity = await authenticate(request)
  assert.equal(identity.staffId, row.id)
  assert.equal(identity.branchId, row.branch_id)
})
