import assert from 'node:assert/strict'
import test from 'node:test'
import worker from '../cloudflare/worker.js'
import { authClient, database } from '../backend/config/supabase.js'

const env = {
  RATE_LIMITER: { idFromName: name => name, get: () => ({ fetch: async () => Response.json({ allowed: true, retryAfterSeconds: 60 }) }) },
  ASSETS: { fetch: async () => new Response('not used') },
}
const staff = { id: 'staff-id', auth_id: 'auth-id', email: 'staff@example.com', username: 'staff.user', role: 'staff', branch: 'Main', branch_id: 'main', deleted_at: null, must_change_password: false }

function mockAuth(t, account = staff) {
  const signedOut = []
  const originalFrom = database.from
  const authDescriptor = Object.getOwnPropertyDescriptor(authClient, 'auth')
  const databaseAuthDescriptor = Object.getOwnPropertyDescriptor(database, 'auth')
  t.after(() => {
    database.from = originalFrom
    Object.defineProperty(authClient, 'auth', authDescriptor)
    Object.defineProperty(database, 'auth', databaseAuthDescriptor)
  })
  database.from = () => ({
    select() { return this }, is() { return this }, eq() { return this }, ilike() { return this },
    async limit() { return { data: [{ ...account }], error: null } },
    async maybeSingle() { return { data: { ...account }, error: null } },
  })
  const session = suffix => ({ access_token: `access-${suffix}`, refresh_token: `refresh-${suffix}`, expires_at: 4102444800, user: { id: staff.auth_id, email: staff.email } })
  Object.defineProperty(authClient, 'auth', { configurable: true, value: {
    async signInWithPassword() { const value = session('login'); return { data: { user: value.user, session: value }, error: null } },
    async refreshSession({ refresh_token }) {
      if (!refresh_token?.startsWith('refresh-')) return { data: {}, error: { message: 'Invalid Refresh Token', status: 400 } }
      const value = session('renewed'); return { data: { user: value.user, session: value }, error: null }
    },
    async getUser(token) {
      return token?.startsWith('access-') && token !== 'access-expired'
        ? { data: { user: { id: staff.auth_id, email: staff.email } }, error: null }
        : { data: { user: null }, error: { message: 'invalid JWT', status: 401 } }
    },
  } })
  Object.defineProperty(database, 'auth', { configurable: true, value: { admin: { async signOut(token) { signedOut.push(token); return { error: null } } } } })
  return signedOut
}

async function call(path, { method = 'GET', body, cookie, site } = {}) {
  const response = await worker.fetch(new Request(`https://test.iclaundry.local/api/${path}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
      ...(site ? { 'Sec-Fetch-Site': site } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), env)
  return { response, body: await response.json(), cookies: response.headers.getSetCookie() }
}

test('signing in sets HttpOnly session cookies and gives the page no tokens', async t => {
  mockAuth(t)
  const remembered = await call('auth/login', { method: 'POST', body: { identifier: 'staff.user', password: 'correct-password', remember: true } })
  assert.equal(remembered.response.status, 200)
  assert.equal(remembered.body.session.user.id, staff.auth_id)
  assert.equal(remembered.body.session.remember, true)
  assert.doesNotMatch(JSON.stringify(remembered.body), /access-login|refresh-login/)
  const access = remembered.cookies.find(cookie => cookie.startsWith('ic_access='))
  assert.match(access, /^ic_access=access-login; Path=\/api; HttpOnly; Secure; SameSite=Strict; Max-Age=2592000$/)
  assert.ok(remembered.cookies.some(cookie => cookie.startsWith('ic_refresh=refresh-login; Path=/api/auth; HttpOnly')))

  // Without "Remember me" the cookies end when the browser closes.
  const browserOnly = await call('auth/login', { method: 'POST', body: { identifier: 'staff.user', password: 'correct-password', remember: false } })
  assert.equal(browserOnly.body.session.remember, false)
  assert.ok(browserOnly.cookies.every(cookie => !cookie.includes('Max-Age')))
})

test('every tab learns the signed-in account from the cookie, renewing it when it has expired', async t => {
  mockAuth(t)
  const current = await call('auth/session', { cookie: 'ic_access=access-login; ic_refresh=refresh-login; ic_remember=1' })
  assert.equal(current.body.session.user.id, staff.auth_id)
  assert.equal(current.cookies.length, 0)

  const renewed = await call('auth/session', { cookie: 'ic_access=access-expired; ic_refresh=refresh-login; ic_remember=0' })
  assert.equal(renewed.body.session.remember, false)
  assert.ok(renewed.cookies.some(cookie => cookie.startsWith('ic_access=access-renewed') && !cookie.includes('Max-Age')))

  const signedOut = await call('auth/session')
  assert.deepEqual(signedOut.body, { session: null })

  const revoked = await call('auth/session', { cookie: 'ic_access=access-expired; ic_refresh=bad-token' })
  assert.deepEqual(revoked.body, { session: null })
  assert.ok(revoked.cookies.every(cookie => cookie.includes('Max-Age=0')), 'a dead session is cleared from the browser')
})

test('the cookie authenticates same-site requests only, and signing out clears and revokes it', async t => {
  const signedOut = mockAuth(t)
  const cookie = 'ic_access=access-login; ic_refresh=refresh-login; ic_remember=1'
  const sameSite = await call('auth/me', { cookie, site: 'same-origin' })
  assert.equal(sameSite.response.status, 200)
  assert.equal(sameSite.body.staffId, staff.id)

  const crossSite = await call('auth/me', { cookie, site: 'cross-site' })
  assert.equal(crossSite.response.status, 403)

  const renewed = await call('auth/refresh', { method: 'POST', body: {}, cookie })
  assert.ok(renewed.cookies.some(value => value.startsWith('ic_refresh=refresh-renewed') && value.includes('Max-Age=2592000')))

  const logout = await call('auth/logout', { method: 'POST', cookie })
  assert.deepEqual(logout.body, { success: true })
  assert.deepEqual(signedOut, ['access-login'])
  assert.equal(logout.cookies.length, 3)
  assert.ok(logout.cookies.every(value => value.includes('Max-Age=0')))

  const afterLogout = await call('auth/me')
  assert.equal(afterLogout.response.status, 401)
})

test('the session says whether a new account is an administrator or staff, so activation addresses it correctly', async t => {
  mockAuth(t, { ...staff, role: 'admin', must_change_password: true })
  const signedIn = await call('auth/login', { method: 'POST', body: { identifier: 'staff.user', password: 'temporary-password', remember: false } })
  assert.equal(signedIn.body.session.hc_must_change_password, true)
  assert.equal(signedIn.body.session.hc_role, 'admin')
  // A reloaded or duplicated tab gets the same answer from the cookie.
  const restored = await call('auth/session', { cookie: 'ic_access=access-login; ic_refresh=refresh-login; ic_remember=0' })
  assert.equal(restored.body.session.hc_role, 'admin')
  assert.doesNotMatch(JSON.stringify(restored.body), /access-login|refresh-login/)
})

test('a staff account is identified as staff', async t => {
  mockAuth(t, { ...staff, must_change_password: true })
  const signedIn = await call('auth/login', { method: 'POST', body: { identifier: 'staff.user', password: 'temporary-password' } })
  assert.equal(signedIn.body.session.hc_role, 'staff')
})
