import assert from 'node:assert/strict'
import test from 'node:test'
import worker, { RateLimiter } from '../cloudflare/worker.js'
import { database } from '../backend/config/supabase.js'
import { createOrder, restockInventory, transitionOrder } from '../backend/controllers/operationController.js'
import { provisionStaff } from '../backend/controllers/staffProvisionController.js'

function testEnv({ allowed = true } = {}) {
  return {
    RATE_LIMITER: {
      idFromName: name => name,
      get: () => ({
        fetch: async () => Response.json({ allowed, retryAfterSeconds: 60 }),
      }),
    },
    ASSETS: { fetch: async () => new Response('not used') },
  }
}

async function api(path, { method = 'GET', body, headers = {} } = {}) {
  const response = await worker.fetch(new Request(`https://test.iclaundry.local/api/${path}`, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), testEnv())
  return { response, body: await response.json() }
}

function queryResult(data, error = null) {
  return {
    select() { return this },
    eq() { return this },
    maybeSingle: async () => ({ data, error }),
  }
}

function withDatabaseMocks(t, { from, rpc }) {
  const originalFrom = database.from
  const originalRpc = database.rpc
  database.from = from || originalFrom
  database.rpc = rpc || originalRpc
  t.after(() => {
    database.from = originalFrom
    database.rpc = originalRpc
  })
}

function withAuthAdminMock(t, admin) {
  const original = Object.getOwnPropertyDescriptor(database, 'auth')
  Object.defineProperty(database, 'auth', { value: { admin }, configurable: true })
  t.after(() => Object.defineProperty(database, 'auth', original))
}

test('visitor journey: public pages and health endpoint are available with security headers', async () => {
  const { response, body } = await api('health')
  assert.equal(response.status, 200)
  assert.deepEqual(body, { status: 'ok' })
  assert.match(response.headers.get('content-security-policy'), /default-src 'self'/)
  assert.equal(response.headers.get('cache-control'), 'no-store, max-age=0')
})

test('visitor journey: malformed, oversized, and unknown API requests fail safely', async () => {
  const unknown = await api('not-a-real-endpoint')
  assert.equal(unknown.response.status, 404)
  assert.equal(unknown.body.error, 'Endpoint not found')

  const blankTracking = await api('public/orders/track')
  assert.equal(blankTracking.response.status, 400)
  assert.equal(blankTracking.body.error, 'Tracking number is required')

  const oversizedRequest = new Request('https://test.iclaundry.local/api/public/contact', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': '65537' },
    body: '{}',
  })
  const oversized = await worker.fetch(oversizedRequest, testEnv())
  assert.equal(oversized.status, 413)
  assert.equal((await oversized.json()).error, 'Request body is too large.')
})

test('visitor journey: contact form validation rejects incomplete input before email delivery', async () => {
  const result = await api('public/contact', { method: 'POST', body: { name: 'Customer', email: '', message: '' } })
  assert.equal(result.response.status, 400)
  assert.equal(result.body.error, 'Name, email, and message are required.')
})

test('security journey: protected staff endpoints reject a visitor without a session', async () => {
  const cases = [
    ['auth/me', 'GET'],
    ['auth/email/otp', 'POST'],
    ['auth/email', 'PATCH'],
    ['staff/provision', 'POST'],
    ['notifications/email', 'POST'],
    ['orders/create', 'POST'],
    ['orders/transition', 'POST'],
    ['inventory/restock', 'POST'],
    ['recycle-bin', 'GET'],
  ]
  for (const [path, method] of cases) {
    const result = await api(path, { method, body: method === 'POST' ? {} : undefined })
    assert.equal(result.response.status, 401, `${method} ${path} must require a session`)
    assert.equal(result.body.error, 'Authentication required')
  }
})

test('security journey: an empty OTP request is valid JSON transport and reaches authentication', async () => {
  const result = await api('auth/password/otp', { method: 'POST' })
  assert.equal(result.response.status, 401)
  assert.equal(result.body.error, 'Authentication required')
})

test('security journey: rate limiter blocks requests after the configured limit', async () => {
  const storage = new Map()
  const limiter = new RateLimiter({
    storage: {
      get: async key => storage.get(key),
      put: async (key, value) => storage.set(key, value),
    },
  })
  const policy = { limit: 2, windowMs: 60_000 }
  const first = await (await limiter.fetch(new Request('https://rate-limiter/check', { method: 'POST', body: JSON.stringify(policy) }))).json()
  const second = await (await limiter.fetch(new Request('https://rate-limiter/check', { method: 'POST', body: JSON.stringify(policy) }))).json()
  const third = await (await limiter.fetch(new Request('https://rate-limiter/check', { method: 'POST', body: JSON.stringify(policy) }))).json()
  assert.equal(first.allowed, true)
  assert.equal(second.allowed, true)
  assert.equal(third.allowed, false)
})

test('security journey: the general API limiter protects every non-health endpoint', async () => {
  const response = await worker.fetch(new Request('https://test.iclaundry.local/api/not-a-real-endpoint'), testEnv({ allowed: false }))
  assert.equal(response.status, 429)
  assert.match((await response.json()).error, /Too many requests/)
})

test('staff journey: a staff member cannot transition an order from another branch', async t => {
  let rpcCalled = false
  withDatabaseMocks(t, {
    from: () => queryResult({ id: 'order-1', branch_id: 'main-branch', status: 'received' }),
    rpc: async () => { rpcCalled = true; return { data: null, error: null } },
  })
  await assert.rejects(
    transitionOrder({ orderId: 'order-1', status: 'on_process' }, {
      staffId: 'staff-1', role: 'staff', branchId: 'second-branch', branch: 'Second Branch',
    }),
    /assigned to your branch/,
  )
  assert.equal(rpcCalled, false)
})

test('staff journey: an adjacent stage move calls the audited database workflow', async t => {
  let rpcName
  let rpcArgs
  withDatabaseMocks(t, {
    from: () => queryResult({ id: 'order-1', branch_id: 'main-branch', status: 'received' }),
    rpc: async (name, args) => {
      rpcName = name
      rpcArgs = args
      return { data: { id: 'order-1', status: 'on_process' }, error: null }
    },
  })
  const result = await transitionOrder({ orderId: 'order-1', status: 'on_process' }, {
    staffId: 'staff-1', role: 'staff', branchId: 'main-branch', branch: 'Main Branch',
  })
  assert.equal(rpcName, 'transition_branch_order')
  assert.deepEqual(rpcArgs, {
    p_order_id: 'order-1', p_staff_id: 'staff-1', p_new_status: 'on_process', p_correction_reason: null,
  })
  assert.equal(result.data.status, 'on_process')
})

test('staff journey: invalid orders never reach the database', async t => {
  let rpcCalled = false
  withDatabaseMocks(t, { rpc: async () => { rpcCalled = true; return { data: null, error: null } } })
  await assert.rejects(
    createOrder({ customer: {}, order: { weight_kg: 0, total_price: 100 } }, {
      staffId: 'staff-1', role: 'staff', branchId: 'main-branch', branch: 'Main Branch',
    }),
    /valid order weight/,
  )
  assert.equal(rpcCalled, false)
})

test('staff journey: valid order creation derives loads and uses the secure order RPC', async t => {
  let rpcName
  let rpcArgs
  withDatabaseMocks(t, {
    rpc: async (name, args) => {
      rpcName = name
      rpcArgs = args
      return { data: { id: 'order-1', status: 'received' }, error: null }
    },
  })
  const result = await createOrder({
    customer: { name: 'Customer', phone: '09123456789' },
    order: { weight_kg: 17, total_price: 300, amount_paid: 150 },
    addons: { soap: 1 },
    bundleKg: 8,
  }, {
    staffId: 'staff-1', role: 'staff', branchId: 'main-branch', branch: 'Main Branch',
  })
  assert.equal(rpcName, 'create_branch_order')
  assert.equal(rpcArgs.p_branch_id, 'main-branch')
  assert.equal(rpcArgs.p_staff_id, 'staff-1')
  assert.equal(rpcArgs.p_loads, 3)
  assert.equal(rpcArgs.p_order.payment_status, 'partial')
  assert.equal(result.data.status, 'received')
})

test('inventory journey: staff cannot restock an item from another branch', async t => {
  let rpcCalled = false
  withDatabaseMocks(t, {
    from: () => queryResult({ id: 'soap-1', branch_id: 'other-branch', name: 'Soap', current_stock: 2, unit: 'pcs' }),
    rpc: async () => { rpcCalled = true; return { data: null, error: null } },
  })
  await assert.rejects(
    restockInventory({ itemId: 'soap-1', quantity: 2 }, {
      staffId: 'staff-1', role: 'staff', branchId: 'main-branch', branch: 'Main Branch',
    }),
    /assigned to your branch/,
  )
  assert.equal(rpcCalled, false)
})

test('administrator journey: a new administrator has no branch scope and must have a recovery email', async t => {
  let inserted
  withDatabaseMocks(t, {
    from: table => {
      if (table === 'branches') throw new Error('Administrators must not require a branch lookup')
      if (table === 'staff') {
        return {
          select() { return { ilike() { return { maybeSingle: async () => ({ data: null, error: null }) } } } },
          insert(payload) {
            inserted = payload
            return { select() { return { single: async () => ({ data: { id: 'admin-2', ...payload }, error: null }) } } }
          },
        }
      }
      if (table === 'audit_logs') return { insert: async () => ({ error: null }) }
      throw new Error(`Unexpected table: ${table}`)
    },
  })
  withAuthAdminMock(t, {
    createUser: async () => ({ data: { user: { id: 'auth-admin-2' } }, error: null }),
    deleteUser: async () => ({ error: null }),
  })
  const identity = { staffId: 'owner-1', role: 'admin', branchId: 'main-branch', branch: 'Main Branch' }
  await assert.rejects(
    provisionStaff({ full_name: 'New Admin', role: 'admin', branch: 'Main Branch' }, identity),
    /contact email is required/,
  )
  const result = await provisionStaff({
    full_name: 'New Admin', role: 'admin', contact_email: 'new.admin@example.com',
  }, identity)
  assert.equal(inserted.role, 'admin')
  assert.equal(inserted.contact_email, 'new.admin@example.com')
  assert.equal(inserted.branch, null)
  assert.equal(inserted.branch_id, null)
  assert.match(result.credentials.staffCode, /^IC-ADMIN-[A-F0-9]{8}$/)
  assert.equal(result.credentials.role, 'admin')
  assert.equal(result.credentials.branch, null)
})
