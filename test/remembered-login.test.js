import assert from 'node:assert/strict'
import test from 'node:test'
import { getRememberedLogin, setRememberedLogin } from '../frontend/src/utils/rememberedLogin.js'

function fakeStorage() {
  const values = new Map()
  return {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: key => values.delete(key),
  }
}

test('remembered login stores only the trimmed account identifier', () => {
  const original = globalThis.localStorage
  globalThis.localStorage = fakeStorage()
  try {
    setRememberedLogin('  IC-STAFF-1234  ')
    assert.equal(getRememberedLogin(), 'IC-STAFF-1234')
    assert.equal(globalThis.localStorage.getItem('ic-laundry-remembered-login'), 'IC-STAFF-1234')
    assert.equal([...Object.values(globalThis.localStorage)].includes('password'), false)
  } finally {
    globalThis.localStorage = original
  }
})

test('clearing remembered login removes the saved account', () => {
  const original = globalThis.localStorage
  globalThis.localStorage = fakeStorage()
  try {
    setRememberedLogin('staff.user')
    setRememberedLogin('')
    assert.equal(getRememberedLogin(), '')
  } finally {
    globalThis.localStorage = original
  }
})
