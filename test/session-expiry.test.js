import assert from 'node:assert/strict'
import test from 'node:test'
import { apiFetch, clearSession, getStoredSession, onSessionChange, refreshRememberedSession, sessionExpiry, storeSession } from '../frontend/src/services/api/client.js'

test('expiry clears sessions; rejected older requests cannot log out a new session', async t => {
  const savedStorage = globalThis.localStorage
  const savedFetch = globalThis.fetch
  const values = new Map()
  globalThis.localStorage = {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: key => values.delete(key),
  }
  const events = []
  const unsubscribe = onSessionChange(session => events.push(session))
  t.after(() => {
    clearSession()
    unsubscribe()
    globalThis.localStorage = savedStorage
    globalThis.fetch = savedFetch
  })
  const session = token => ({access_token: token, expires_at: Math.floor(Date.now() / 1000) + 3600})
  for (const role of ['admin', 'staff']) {
    values.set('hc-laundry-session', JSON.stringify({...session('expired'), role, expires_at: 1}))
    assert.equal(getStoredSession(), null)
    assert.equal(values.size, 0)
    assert.equal(events.at(-1), null)
  }
  // Automatic expiry works even if the user does not make another request.
  storeSession({access_token:'short-session', expires_at:(Date.now() + 25) / 1000})
  await new Promise(resolve => setTimeout(resolve, 60))
  assert.equal(values.size, 0)
  assert.equal(events.at(-1), null)

  storeSession(session('valid'))
  globalThis.fetch = async () => new Response('{"error":"Forbidden"}', {status:403})
  await assert.rejects(apiFetch('/api/staff'), /Forbidden/)
  assert.equal(getStoredSession().access_token, 'valid')
  globalThis.fetch = async () => { throw new Error('Offline') }
  await assert.rejects(apiFetch('/api/staff'), /Offline/)
  assert.equal(getStoredSession().access_token, 'valid')

  let finish
  globalThis.fetch = () => new Promise(resolve => { finish = resolve })
  const pending = apiFetch('/api/staff')
  storeSession(session('replacement'))
  finish(new Response('{"error":"Expired"}', {status:401}))
  await assert.rejects(pending, /Expired/)
  assert.equal(getStoredSession().access_token, 'replacement')
  globalThis.fetch = async () => new Response('{"error":"Expired"}', {status:401})
  await assert.rejects(apiFetch('/api/staff'), /Expired/)
  assert.equal(getStoredSession(), null)

  storeSession(session('signed-in'))
  await assert.rejects(apiFetch('/api/auth/login'), /Expired/)
  assert.equal(getStoredSession().access_token, 'signed-in')
  globalThis.fetch = async (_path, options) => {
    assert.equal(options.headers.Authorization, 'Bearer signed-in')
    return Response.json({success:true})
  }
  await apiFetch('/api/auth/signup', {method:'POST'})
  assert.equal(sessionExpiry({access_token: 'x.' + btoa('{"exp":1234}') + '.x'}), 1234000)
})

test('Remember me renews an expired persistent session through its refresh token', async t => {
  const savedStorage = globalThis.localStorage
  const savedFetch = globalThis.fetch
  const values = new Map()
  globalThis.localStorage = {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: key => values.delete(key),
  }
  t.after(() => {
    clearSession()
    globalThis.localStorage = savedStorage
    globalThis.fetch = savedFetch
  })
  values.set('ic-laundry-session', JSON.stringify({ access_token: 'old-token', refresh_token: 'refresh-token', expires_at: 1 }))
  globalThis.fetch = async (path, options) => {
    assert.equal(path, '/api/auth/refresh')
    assert.deepEqual(JSON.parse(options.body), { refreshToken: 'refresh-token' })
    return Response.json({ session: { access_token: 'new-token', refresh_token: 'new-refresh-token', expires_at: Math.floor(Date.now() / 1000) + 3600 } })
  }
  assert.equal(getStoredSession(), null)
  const refreshed = await refreshRememberedSession()
  assert.equal(refreshed.access_token, 'new-token')
  assert.equal(getStoredSession().access_token, 'new-token')
})
