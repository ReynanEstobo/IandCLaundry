import assert from 'node:assert/strict'
import test from 'node:test'
import worker from '../cloudflare/worker.js'
import { authClient, database } from '../backend/config/supabase.js'

// Sign-in is limited per device (5 per 3 minutes), per account (10) and per
// network address (30), so several phones and laptops on one shop or venue
// Wi-Fi no longer share one small allowance.
const account = { id: 'staff-id', auth_id: 'auth-id', email: 'staff@example.com', username: 'staff.user', role: 'staff', branch: 'Main', branch_id: 'main', deleted_at: null, must_change_password: false }

function mockSignIn(t) {
  const originalFrom = database.from
  const authDescriptor = Object.getOwnPropertyDescriptor(authClient, 'auth')
  t.after(() => {
    database.from = originalFrom
    Object.defineProperty(authClient, 'auth', authDescriptor)
  })
  database.from = () => ({
    select() { return this }, is() { return this }, eq() { return this }, ilike() { return this },
    async limit() { return { data: [{ ...account }], error: null } },
    async maybeSingle() { return { data: { ...account }, error: null } },
  })
  const session = { access_token: 'access-login', refresh_token: 'refresh-login', expires_at: 4102444800, user: { id: account.auth_id, email: account.email } }
  Object.defineProperty(authClient, 'auth', { configurable: true, value: {
    async signInWithPassword() { return { data: { user: session.user, session }, error: null } },
  } })
}

// Counts like the RateLimiter Durable Object: one window per key.
function limiter() {
  const counts = new Map()
  const keys = []
  const env = {
    ASSETS: { fetch: async () => new Response('not used') },
    RATE_LIMITER: {
      idFromName: name => name,
      get: name => ({ fetch: async (_url, options) => {
        const { limit } = JSON.parse(options.body)
        const count = (counts.get(name) || 0) + 1
        counts.set(name, count)
        keys.push(name)
        return Response.json({ allowed: count <= limit, retryAfterSeconds: 120 })
      } }),
    },
  }
  return { env, keys }
}

async function signIn(env, { ip, cookie, identifier }) {
  const response = await worker.fetch(new Request('https://test.iclaundry.local/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': ip, ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify({ identifier, password: 'correct-password' }),
  }), env)
  const device = response.headers.getSetCookie().find(value => value.startsWith('ic_device='))
  return { status: response.status, device, deviceCookie: device?.split(';')[0], retryAfter: response.headers.get('retry-after') }
}

test('a first sign-in gives the browser a signed, HttpOnly device cookie that it then keeps', async t => {
  mockSignIn(t)
  const { env } = limiter()
  const first = await signIn(env, { ip: '203.0.113.20', identifier: 'staff.user' })
  assert.equal(first.status, 200)
  assert.match(first.device, /^ic_device=[0-9a-f]{32}\.[0-9a-f]{64}; Path=\/api\/auth; HttpOnly; Secure; SameSite=Strict; Max-Age=31536000$/)
  const again = await signIn(env, { ip: '203.0.113.20', cookie: first.deviceCookie, identifier: 'staff.user' })
  assert.equal(again.status, 200)
  assert.equal(again.device, undefined, 'a browser that already has a valid device cookie is not given a new one')
})

test('each device on one network gets its own five sign-in attempts', async t => {
  mockSignIn(t)
  const { env } = limiter()
  const ip = '203.0.113.30'
  const laptop = await signIn(env, { ip, identifier: 'cashier.one' })
  const statuses = [laptop.status]
  for (let attempt = 2; attempt <= 6; attempt++) {
    statuses.push((await signIn(env, { ip, cookie: laptop.deviceCookie, identifier: 'cashier.one' })).status)
  }
  assert.deepEqual(statuses, [200, 200, 200, 200, 200, 429], 'the sixth try within 3 minutes from the same device is refused')

  // Other phones and laptops on the same Wi-Fi are unaffected.
  for (const [index, identifier] of ['cashier.two', 'admin.one', 'staff.three', 'staff.four'].entries()) {
    const other = await signIn(env, { ip, identifier })
    assert.equal(other.status, 200, `device ${index + 2} on the same network signs in`)
  }
})

test('the network address still caps sign-ins at 30 per 3 minutes, even from fresh devices', async t => {
  mockSignIn(t)
  const { env } = limiter()
  const ip = '203.0.113.40'
  for (let attempt = 1; attempt <= 30; attempt++) {
    const result = await signIn(env, { ip, identifier: `person.${attempt}` })
    assert.equal(result.status, 200, `attempt ${attempt}`)
  }
  const refused = await signIn(env, { ip, identifier: 'person.31' })
  assert.equal(refused.status, 429)
  assert.equal(refused.retryAfter, '120')
  assert.ok(refused.device, 'a refused attempt still receives its device cookie')
  assert.equal((await signIn(env, { ip: '203.0.113.41', identifier: 'person.32' })).status, 200, 'another network is unaffected')
})

test('one account still allows only 10 sign-in attempts per 3 minutes, whatever device or network they come from', async t => {
  mockSignIn(t)
  const { env } = limiter()
  for (let attempt = 1; attempt <= 10; attempt++) {
    const result = await signIn(env, { ip: `198.51.100.${attempt}`, identifier: 'Staff.User' })
    assert.equal(result.status, 200, `attempt ${attempt}`)
  }
  const refused = await signIn(env, { ip: '198.51.100.99', identifier: 'staff.user' })
  assert.equal(refused.status, 429)
})

test('a made-up or altered device cookie is not trusted', async t => {
  mockSignIn(t)
  const { env, keys } = limiter()
  const forgedId = 'a'.repeat(32)
  const forged = await signIn(env, { ip: '203.0.113.50', cookie: `ic_device=${forgedId}.${'0'.repeat(64)}`, identifier: 'staff.user' })
  assert.equal(forged.status, 200)
  assert.ok(forged.device, 'the server replaces it with a device ID of its own')
  assert.ok(!forged.device.includes(forgedId))
  assert.ok(!keys.includes(`login-device:${forgedId}`))

  const genuine = await signIn(env, { ip: '203.0.113.50', identifier: 'staff.user' })
  const [id, signature] = genuine.deviceCookie.replace('ic_device=', '').split('.')
  const altered = `ic_device=${id.replace(/^./, id[0] === 'f' ? 'e' : 'f')}.${signature}`
  const tampered = await signIn(env, { ip: '203.0.113.50', cookie: altered, identifier: 'staff.user' })
  assert.ok(tampered.device, 'an ID whose signature no longer matches is replaced')
})
