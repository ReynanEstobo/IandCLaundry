import assert from 'node:assert/strict'
import test from 'node:test'
import { apiFetch, clearSession, getStoredSession, onSessionChange, restoreSession, startSessionMonitor, storeSession } from '../frontend/src/services/api/client.js'

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
const tick = () => new Promise(resolve => setTimeout(resolve, 20))

function mockFetch(t, handler) {
  const saved = globalThis.fetch
  const calls = []
  globalThis.fetch = async (path, options = {}) => { calls.push({ path, options }); return handler(path, options, calls) }
  t.after(() => { globalThis.fetch = saved; clearSession({ broadcast: false }) })
  return calls
}

test('requests carry the session cookie, renew it once on expiry, and only sign out the session they started with', async t => {
  const events = []
  const unsubscribe = onSessionChange(session => events.push(session))
  t.after(unsubscribe)
  storeSession({ user: { id: 'u1' } })

  // An expired access cookie is renewed once, then the request is retried.
  let calls = mockFetch(t, (path, _options, seen) => {
    if (path === '/api/auth/refresh') return json({ session: { user: { id: 'u1' }, expires_at: 2 } })
    return seen.filter(call => call.path === '/api/staff').length === 1 ? json({ error: 'Expired' }, 401) : json({ ok: true })
  })
  assert.deepEqual(await apiFetch('/api/staff', { method: 'POST' }), { ok: true })
  assert.deepEqual(calls.map(call => call.path), ['/api/staff', '/api/auth/refresh', '/api/staff'])
  for (const call of calls) {
    assert.equal(call.options.credentials, 'same-origin')
    assert.equal(call.options.headers.Authorization, undefined, 'tokens never travel in script-visible headers')
  }
  assert.equal(getStoredSession().user.id, 'u1')

  // Permission errors and network failures are not expiry.
  mockFetch(t, () => json({ error: 'Forbidden' }, 403))
  await assert.rejects(apiFetch('/api/staff'), /Forbidden/)
  assert.equal(getStoredSession().user.id, 'u1')
  mockFetch(t, () => { throw new Error('Offline') })
  await assert.rejects(apiFetch('/api/staff'), /Offline/)
  assert.equal(getStoredSession().user.id, 'u1')

  // An older request cannot sign out a session that replaced it meanwhile.
  let finish
  mockFetch(t, path => path === '/api/auth/refresh' ? json({ error: 'Expired' }, 401) : new Promise(resolve => { finish = resolve }))
  const pending = apiFetch('/api/staff')
  await tick()
  storeSession({ user: { id: 'replacement' } })
  finish(json({ error: 'Expired' }, 401))
  await assert.rejects(pending, /Expired/)
  assert.equal(getStoredSession().user.id, 'replacement')

  // When the session cannot be renewed, the browser is signed out.
  calls = mockFetch(t, () => json({ error: 'Expired' }, 401))
  await assert.rejects(apiFetch('/api/staff'), /Expired/)
  assert.equal(getStoredSession(), null)
  assert.equal(events.at(-1), null)

  // Sign-in and public endpoints never trigger a renewal or a sign-out.
  storeSession({ user: { id: 'signed-in' } })
  calls = mockFetch(t, () => json({ error: 'Invalid login credentials' }, 401))
  await assert.rejects(apiFetch('/api/auth/login', { method: 'POST' }), /Invalid login/)
  assert.deepEqual(calls.map(call => call.path), ['/api/auth/login'])
  assert.equal(getStoredSession().user.id, 'signed-in')
})

test('a session saved by the previous version moves into cookies once and its stored tokens are removed', async t => {
  const savedStorage = globalThis.localStorage
  const values = new Map([['ic-laundry-session', JSON.stringify({ access_token: 'old-token', refresh_token: 'refresh-token', expires_at: 1 })]])
  globalThis.localStorage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) }
  t.after(() => { globalThis.localStorage = savedStorage })
  const calls = mockFetch(t, path => path === '/api/auth/refresh'
    ? json({ session: { user: { id: 'u1' }, remember: true } })
    : json({ session: { user: { id: 'u1' }, remember: true } }))

  assert.equal((await restoreSession()).user.id, 'u1')
  assert.equal(calls[0].path, '/api/auth/refresh')
  assert.deepEqual(JSON.parse(calls[0].options.body), { refreshToken: 'refresh-token', remember: true })
  assert.equal(values.size, 0, 'no token stays in browser storage')

  await restoreSession()
  assert.equal(calls[1].path, '/api/auth/session')
})

test('a server that cannot be reached keeps the current session instead of signing out', async t => {
  storeSession({ user: { id: 'u1' } })
  mockFetch(t, () => json({ error: 'Internal server error' }, 503))
  assert.equal((await restoreSession()).user.id, 'u1')
  mockFetch(t, () => json({ session: null }))
  assert.equal(await restoreSession(), null)
})

test('every tab follows sign-in and sign-out from any other tab of the browser', async t => {
  const savedDocument = globalThis.document
  const savedWindow = globalThis.window
  let reloads = 0
  globalThis.document = { hidden: false, addEventListener() {}, removeEventListener() {} }
  globalThis.window = { location: { reload: () => { reloads++ } } }
  const otherTab = new BroadcastChannel('ic-laundry-auth')
  const announced = []
  otherTab.onmessage = ({ data }) => announced.push(data)
  const stop = startSessionMonitor()
  t.after(() => { stop(); otherTab.close(); globalThis.document = savedDocument; globalThis.window = savedWindow })
  const calls = mockFetch(t, () => json({ session: { user: { id: 'u1' } } }))

  // This tab tells the others when it signs in or out.
  storeSession({ user: { id: 'u1' } })
  await tick()
  assert.deepEqual(announced.at(-1), { type: 'signed-in', userId: 'u1' })

  // Signing out in another tab signs this one out.
  otherTab.postMessage({ type: 'signed-out' })
  await tick()
  assert.equal(getStoredSession(), null)

  // Signing in from another tab signs this one in to the same account.
  otherTab.postMessage({ type: 'signed-in', userId: 'u1' })
  await tick()
  assert.equal(calls.at(-1).path, '/api/auth/session')
  assert.equal(getStoredSession().user.id, 'u1')

  // Signing in as a different account replaces this tab's account.
  otherTab.postMessage({ type: 'signed-in', userId: 'u2' })
  await tick()
  assert.equal(reloads, 1)
})
