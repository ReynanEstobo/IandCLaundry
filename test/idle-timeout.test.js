import assert from 'node:assert/strict'
import test from 'node:test'

// The browser's localStorage, shared by every "tab" (module instance) in a test.
function memoryStorage() {
  const values = new Map()
  return {
    getItem: key => (values.has(key) ? values.get(key) : null),
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: key => values.delete(key),
  }
}

// Each import with a fresh query string is a separate tab with its own memory.
let tabCount = 0
const openTab = () => import(`../frontend/src/services/api/idleTimeout.js?tab=${++tabCount}`)

const HOUR = 60 * 60 * 1000
const T0 = Date.UTC(2026, 9, 28, 8, 0, 0)

test.beforeEach(() => { globalThis.localStorage = memoryStorage() })
test.after(() => { delete globalThis.localStorage })

test('an account stays signed in for an hour without activity, with a one-minute warning first', async () => {
  const tab = await openTab()
  tab.startIdlePeriod(T0)
  assert.equal(tab.idleStatus(T0 + 30 * 60 * 1000).state, 'active')
  assert.deepEqual(tab.idleStatus(T0 + HOUR - 60 * 1000), { state: 'warning', secondsLeft: 60 })
  assert.deepEqual(tab.idleStatus(T0 + HOUR - 15 * 1000), { state: 'warning', secondsLeft: 15 })
  assert.equal(tab.idleStatus(T0 + HOUR).state, 'expired')
})

test('activity restarts the hour, and activity in one tab keeps every tab signed in', async () => {
  const counter = await openTab()
  const office = await openTab()
  counter.startIdlePeriod(T0)
  counter.recordActivity(T0 + 50 * 60 * 1000)
  assert.equal(office.idleStatus(T0 + HOUR + 5 * 60 * 1000).state, 'active')
  assert.equal(office.idleStatus(T0 + 50 * 60 * 1000 + HOUR).state, 'expired')
})

test('closing the browser for more than an hour opens it signed out', async () => {
  const before = await openTab()
  before.startIdlePeriod(T0)
  before.recordActivity(T0 + 10 * 60 * 1000)
  const reopened = await openTab() // a new browser session reads only what was stored
  assert.equal(reopened.idleStatus(T0 + 10 * 60 * 1000 + HOUR + 1).state, 'expired')
})

test('a session from before this feature, with no activity recorded, starts its hour now', async () => {
  const tab = await openTab()
  assert.equal(tab.idleStatus(T0).state, 'active')
  assert.equal(tab.idleStatus(T0 + HOUR - 1).state, 'warning')
})

test('after an idle sign-out the sign-in page explains it, until the next sign-in', async () => {
  const tab = await openTab()
  tab.startIdlePeriod(T0)
  tab.noteIdleSignOut(T0 + HOUR)
  assert.equal(tab.wasRecentlySignedOutForIdle(T0 + HOUR + 1000), true)
  // Still expired if the browser reopens before a new sign-in (for example
  // when the sign-out could not reach the server while offline).
  const reopened = await openTab()
  assert.equal(reopened.idleStatus(T0 + HOUR + 1000).state, 'expired')
  tab.startIdlePeriod(T0 + 2 * HOUR)
  assert.equal(tab.wasRecentlySignedOutForIdle(T0 + 2 * HOUR), false)
  assert.equal(tab.idleStatus(T0 + 2 * HOUR + 1000).state, 'active')
})

test('a deliberate sign-out shows no idle notice', async () => {
  const tab = await openTab()
  tab.noteIdleSignOut(T0)
  tab.clearIdleNotice()
  assert.equal(tab.wasRecentlySignedOutForIdle(T0 + 1000), false)
})
