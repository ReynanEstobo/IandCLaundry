import assert from 'node:assert/strict'
import test from 'node:test'
import worker from '../cloudflare/worker.js'
import { configureRuntimeEnv, database } from '../backend/config/supabase.js'
import { sendCustomerSms } from '../backend/controllers/notificationController.js'
import { generateFromPrompt } from '../backend/services/aiService.js'

const staff = { staffId: 'staff-1', role: 'staff', branchId: 'main-branch', branch: 'Main Branch' }

function withRpcMock(t, rpc) {
  const original = database.rpc
  database.rpc = rpc
  t.after(() => { database.rpc = original })
}

function withFetchMock(t, fetch) {
  const original = globalThis.fetch
  globalThis.fetch = fetch
  t.after(() => { globalThis.fetch = original })
}

test('sms journey: only an active staff account can send SMS', async () => {
  await assert.rejects(
    sendCustomerSms({ phone: '09171234567', message: 'Ready' }, { staffId: null, role: 'unassigned' }),
    /active staff account is required/,
  )
})

test('sms journey: invalid numbers and oversized messages never reach the database or provider', async t => {
  let rpcCalled = false
  withRpcMock(t, async () => { rpcCalled = true; return { data: [], error: null } })
  await assert.rejects(sendCustomerSms({ phone: '+15551234567', message: 'Ready' }, staff), /must start with 09/)
  await assert.rejects(sendCustomerSms({ phone: '09171234567', message: '' }, staff), /1–918 characters/)
  await assert.rejects(sendCustomerSms({ phone: '09171234567', message: 'x'.repeat(919) }, staff), /1–918 characters/)
  assert.equal(rpcCalled, false)
})

test('sms journey: a number that is not a registered customer is rejected before the provider', async t => {
  let providerCalled = false
  withRpcMock(t, async () => ({ data: [], error: null }))
  withFetchMock(t, async () => { providerCalled = true; return Response.json({}) })
  await assert.rejects(
    sendCustomerSms({ phone: '09171234567', message: 'Your laundry is ready.' }, staff),
    error => error.status === 403 && /registered customer/.test(error.message),
  )
  assert.equal(providerCalled, false)
})

test('sms journey: a registered customer receives the message in international format', async t => {
  let rpcArgs
  let providerBody
  configureRuntimeEnv({ SEMAPHORE_API_KEY: 'test-key' })
  t.after(() => configureRuntimeEnv(null))
  withRpcMock(t, async (name, args) => { rpcArgs = { name, args }; return { data: [{ id: 'customer-1' }], error: null } })
  withFetchMock(t, async (_url, options) => { providerBody = new URLSearchParams(options.body); return Response.json([{ message_id: 1 }]) })
  const result = await sendCustomerSms({ phone: '0917-123-4567', message: '  Your laundry is ready.  ' }, staff)
  assert.equal(result.success, true)
  assert.deepEqual(rpcArgs, { name: 'find_customer_by_phone', args: { p_phone: '09171234567' } })
  assert.equal(providerBody.get('number'), '639171234567')
  assert.equal(providerBody.get('message'), 'Your laundry is ready.')
})

test('ai journey: free-form prompts must be non-empty strings within the size limit', async () => {
  for (const prompt of [undefined, '', '   ', 42, 'x'.repeat(20_001)]) {
    await assert.rejects(generateFromPrompt(prompt), error => error.status === 400 && /Prompt must contain/.test(error.message))
  }
})

test('security journey: SMS and free-form AI requests have their own rate limits', async () => {
  const policies = new Map()
  let lastKey
  const env = {
    RATE_LIMITER: {
      idFromName: key => { lastKey = key; return key },
      get: () => ({ fetch: async (_url, options) => {
        policies.set(lastKey, JSON.parse(options.body))
        return Response.json({ allowed: true, retryAfterSeconds: 60 })
      } }),
    },
    ASSETS: { fetch: async () => new Response('not used') },
  }
  for (const path of ['notifications/sms', 'ai/generate']) {
    const response = await worker.fetch(new Request(`https://test.iclaundry.local/api/${path}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.9' }, body: '{}',
    }), env)
    assert.equal(response.status, 401, `${path} must still require a session`)
  }
  const policyFor = path => [...policies].find(([key]) => key.startsWith(`route:POST:${path}:`))?.[1]
  assert.deepEqual(policyFor('notifications/sms'), { limit: 30, windowMs: 15 * 60 * 1000 })
  assert.deepEqual(policyFor('ai/generate'), { limit: 20, windowMs: 15 * 60 * 1000 })
})
