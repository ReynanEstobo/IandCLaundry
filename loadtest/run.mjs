// I&C Laundry load test. Simulates people using the system at the same time and
// raises the number of simultaneous users stage by stage until it slows down.
//
//   Branch staff  keep the staff dashboard and Orders list open (refreshed every
//                 --poll seconds, as the app does) and take orders from creation
//                 to release.
//   Admins        keep the admin dashboard open and load Analytics now and then.
//   Customers     look up orders on the public tracking page.
//
// It only targets the local test server (loadtest/start-test-server.mjs) or
// another non-production URL; the live website is refused. Each simulated user
// connects from its own loopback address (127.0.x.y), as separate devices
// would, so the per-device rate limit applies per user as in real use.
//
// Usage:
//   node loadtest/run.mjs [--stages 5,10,20,40,80] [--stage-seconds 120] [--poll 30]
//                         [--mix staff:70,admin:15,customer:15] [--max-p95 5000] [--max-errors 2]
//   node loadtest/run.mjs --mock    checks the tool itself against a built-in fake server
import http from 'node:http'
import https from 'node:https'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { ACCOUNTS_FILE, OUT_DIR, assertSafeTarget, loadTestEnv } from './lib/config.mjs'
import { startMockServer } from './lib/mock-server.mjs'

// ---------- options ----------
const args = process.argv.slice(2)
const option = (name, fallback) => {
  const index = args.indexOf(`--${name}`)
  return index >= 0 && args[index + 1] && !args[index + 1].startsWith('--') ? args[index + 1] : fallback
}
const mock = args.includes('--mock')
const stages = option('stages', mock ? '2,4' : '5,10,20,40,80').split(',').map(Number).filter(n => n > 0)
const stageSeconds = Number(option('stage-seconds', mock ? 6 : 120))
const pollSeconds = Number(option('poll', mock ? 1 : 30))
const maxP95 = Number(option('max-p95', 5000))
const maxErrorPercent = Number(option('max-errors', 2))
const mix = Object.fromEntries(option('mix', 'staff:70,admin:15,customer:15').split(',').map(part => {
  const [kind, share] = part.split(':'); return [kind, Number(share) || 0]
}))

let target
let accounts
let mockServer = null
if (mock) {
  mockServer = await startMockServer()
  target = `http://127.0.0.1:${mockServer.port}`
  accounts = [{ role: 'admin', username: 'mock.admin', password: 'x' },
    ...[1, 2, 3].map(n => ({ role: 'staff', username: `mock.staff${n}`, password: 'x', branch: `Branch ${n}` }))]
} else {
  const env = loadTestEnv()
  target = option('target', `http://127.0.0.1:${env.PORT || 3101}`)
  if (!existsSync(ACCOUNTS_FILE)) throw new Error('loadtest/.accounts.json not found. Run node loadtest/seed-accounts.mjs first.')
  accounts = JSON.parse(readFileSync(ACCOUNTS_FILE, 'utf8'))
}
assertSafeTarget({ target })
const targetUrl = new URL(target)
const loopbackTarget = ['127.0.0.1', 'localhost', '::1'].includes(targetUrl.hostname)

// ---------- HTTP with one connection pool and address per simulated user ----------
const transport = targetUrl.protocol === 'https:' ? https : http
let addressSequence = 0
function newDevice() {
  addressSequence += 1
  const localAddress = loopbackTarget ? `127.0.${1 + Math.floor(addressSequence / 250)}.${1 + (addressSequence % 250)}` : undefined
  return { localAddress, agent: new transport.Agent({ keepAlive: true, maxSockets: 8, ...(localAddress ? { localAddress } : {}) }) }
}

const samples = []
let currentStage = 0
function request(device, method, pathname, { body, token, kind } = {}) {
  const started = performance.now()
  const payload = body === undefined ? undefined : JSON.stringify(body)
  return new Promise(resolve => {
    const req = transport.request({
      hostname: targetUrl.hostname, port: targetUrl.port, path: pathname, method, agent: device.agent,
      headers: {
        Accept: 'application/json',
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    }, response => {
      const chunks = []
      response.on('data', chunk => chunks.push(chunk))
      response.on('end', () => {
        const ms = performance.now() - started
        let data = null
        try { data = JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null') } catch { /* non-JSON */ }
        const ok = response.statusCode >= 200 && response.statusCode < 300
        if (kind) samples.push({ stage: currentStage, kind, ms, ok, status: response.statusCode, error: ok ? null : data?.error || data?.message || null })
        resolve({ ok, status: response.statusCode, data, headers: response.headers, ms })
      })
    })
    req.setTimeout(60_000, () => req.destroy(new Error('timeout')))
    req.on('error', error => {
      const ms = performance.now() - started
      if (kind) samples.push({ stage: currentStage, kind, ms, ok: false, status: 0, error: error.message })
      resolve({ ok: false, status: 0, data: null, headers: {}, ms })
    })
    if (payload) req.write(payload)
    req.end()
  })
}

// A screen refresh sends its queries together, as the page does; the user waits for all of them.
async function screen(device, token, kind, queries) {
  const started = performance.now()
  const results = await Promise.all(queries.map(([table, body]) => request(device, 'POST', table, { body, token, kind: `${kind} · query` })))
  samples.push({ stage: currentStage, kind, ms: performance.now() - started, ok: results.every(r => r.ok), status: results.every(r => r.ok) ? 200 : 500 })
  return results
}

// ---------- the app's own queries ----------
const daysAgo = days => new Date(Date.now() - days * 86_400_000).toISOString()
const select = (selection, filters = [], extra = {}) => ({ operation: 'select', selection, filters, orders: [], ...extra })
const not = (column, operator, value) => ({ type: 'not', column, value: { operator, value } })
const staffDashboard = () => [
  ['/api/orders', select('id, order_number, status, payment_status, weight_kg, total_price, estimated_ready_at, created_at, customers(name, phone), service_types(name), order_items(service_name_snapshot, weight_kg, status)',
    [not('status', 'in', '("released","cancelled")')], { orders: [{ column: 'created_at', options: { ascending: false } }] })],
  ['/api/inventory/items', select('id, name, unit, current_stock, minimum_stock, branch_id, inventory_categories(name)')],
  ['/api/orders', select('created_at, amount_paid, total_price, payment_status, status', [not('status', 'eq', 'cancelled'), { type: 'gte', column: 'created_at', value: daysAgo(30) }])],
  ['/api/payments', select('id, amount, paid_at, payment_date, orders!inner(status)', [{ type: 'gte', column: 'paid_at', value: daysAgo(30) }])],
  ['/api/payments', select('id, amount, paid_at, payment_date, orders!inner(status)', [{ type: 'gte', column: 'payment_date', value: daysAgo(30) }])],
  ['/api/inventory/usage', select('item_id, quantity_used, logged_at, reversed_at', [], { orders: [{ column: 'logged_at', options: { ascending: false } }], limit: 500 })],
  ['/api/service-inventory-requirements', select('inventory_item_id, service_type_id, branch_id, quantity_per_load, is_active', [{ type: 'eq', column: 'is_active', value: true }])],
  ['/api/order-items', select('service_type_id, branch_id, loads, status, created_at', [not('status', 'eq', 'cancelled')], { orders: [{ column: 'created_at', options: { ascending: false } }], limit: 1000 })],
]
const adminDashboard = () => [
  ['/api/orders', select('id, created_at, status, payment_status, total_price, amount_paid', [{ type: 'gte', column: 'created_at', value: daysAgo(30) }])],
  ['/api/orders', select('id, created_at, status, payment_status, total_price, amount_paid', [not('status', 'in', '("released","cancelled")')])],
  ['/api/orders', select('id, created_at, status, payment_status, total_price, amount_paid', [{ type: 'eq', column: 'payment_status', value: 'unpaid' }, not('status', 'eq', 'cancelled')])],
  ['/api/customers', select('id', [], { count: 'exact', head: true })],
  ['/api/inventory/items', select('id, name, current_stock, minimum_stock, unit, branch, branch_id')],
  ['/api/orders', select('id, order_number, status, estimated_ready_at, total_price, created_at, customers(name, phone), service_types(name)', [], { count: 'exact', range: { from: 0, to: 9 } })],
  ['/api/payments', select('id, amount, paid_at, payment_date, orders!inner(status)', [{ type: 'gte', column: 'paid_at', value: daysAgo(30) }])],
  ['/api/payments', select('id, amount, paid_at, payment_date, orders!inner(status)', [{ type: 'gte', column: 'payment_date', value: daysAgo(30) }])],
  ['/api/expenses', select('amount, expense_date', [{ type: 'gte', column: 'expense_date', value: daysAgo(30).slice(0, 10) }])],
  ['/api/settings', select('*', [], { single: 'single' })],
]
const analytics = () => [
  ['/api/orders', select('id, order_number, created_at, updated_at, ready_at, status, customer_id, completed_by_staff_id, created_by_staff_id, branch, branch_id, total_price, amount_paid, payment_status, customers(name, phone), service_types(name)',
    [{ type: 'gte', column: 'created_at', value: daysAgo(30) }])],
  ['/api/expenses', select('amount, expense_date', [{ type: 'gte', column: 'expense_date', value: daysAgo(30).slice(0, 10) }])],
  ['/api/staff', select('id, full_name')],
  ['/api/inventory/items', select('id, name, current_stock, minimum_stock, unit, branch')],
  ['/api/payments', select('amount, paid_at, payment_date, order_id, branch, branch_id, orders!inner(id, status, branch, branch_id, service_types(name))', [{ type: 'gte', column: 'paid_at', value: daysAgo(30) }])],
  ['/api/order-items', select('id, order_id, service_name_snapshot, pricing_type_snapshot, weight_kg, quantity, subtotal, created_at, orders!inner(id, status, branch, branch_id)', [{ type: 'gte', column: 'created_at', value: daysAgo(30) }])],
  ['/api/customers', select('id, created_at, branch', [{ type: 'gte', column: 'created_at', value: daysAgo(30) }])],
]

// ---------- sign in every test account once, from its own address ----------
const sessions = new Map()
const services = []
const trackingNumbers = []
console.log(`Target: ${target}${mock ? ' (built-in mock server)' : ''}`)
for (const account of accounts) {
  const response = await request(newDevice(), 'POST', '/api/auth/login', { body: { identifier: account.username, password: account.password, remember: false } })
  const cookie = [response.headers['set-cookie']].flat().find(value => String(value).startsWith('ic_access='))
  const token = cookie ? decodeURIComponent(cookie.split(';')[0].slice('ic_access='.length)) : null
  if (!response.ok || !token) throw new Error(`Sign-in failed for ${account.username} (HTTP ${response.status}): ${response.data?.error || 'no session cookie'}`)
  sessions.set(account.username, { ...account, token })
}
const admins = [...sessions.values()].filter(account => account.role === 'admin')
const staffAccounts = [...sessions.values()].filter(account => account.role === 'staff')
if (!admins.length || !staffAccounts.length) throw new Error('At least one admin and one staff test account are required.')
console.log(`Signed in ${admins.length} admin and ${staffAccounts.length} staff test account(s).`)
{
  const device = newDevice()
  const serviceRows = await request(device, 'POST', '/api/service-types', { token: admins[0].token, body: select('id, name, is_active', [{ type: 'eq', column: 'is_active', value: true }]) })
  services.push(...(serviceRows.data?.data || []))
  const recent = await request(device, 'POST', '/api/orders', { token: admins[0].token, body: select('order_number', [], { limit: 200 }) })
  trackingNumbers.push(...(recent.data?.data || []).map(order => order.order_number).filter(Boolean))
  if (!services.length) throw new Error('No active services found. Run the seed scripts in the test project first.')
}

// ---------- simulated people ----------
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const jitter = base => base * (0.75 + Math.random() * 0.5)
let phoneSequence = Math.floor(Math.random() * 9_000_000)

async function staffMember(account, stopAt) {
  const device = newDevice()
  const myOrders = []
  await sleep(Math.random() * pollSeconds * 1000)
  while (Date.now() < stopAt) {
    await screen(device, account.token, 'Staff dashboard refresh', staffDashboard())
    await request(device, 'GET', '/api/orders/page?page=1&pageSize=10', { token: account.token, kind: 'Orders list' })
    // Move one of this person's orders a step forward, or take a new one.
    const next = myOrders.find(order => order.step < 3)
    if (next) {
      const step = next.step
      const response = step === 0
        ? await request(device, 'POST', '/api/orders/transition', { token: account.token, kind: 'Start processing', body: { orderId: next.id, status: 'on_process' } })
        : step === 1
          ? await request(device, 'POST', '/api/orders/transition', { token: account.token, kind: 'Mark ready', body: { orderId: next.id, status: 'ready' } })
          : await request(device, 'POST', '/api/orders/settle-and-release', { token: account.token, kind: 'Collect & release', body: { orderId: next.id, releaseConfirmed: true } })
      next.step = response.ok ? step + 1 : 3
    }
    if (!next || Math.random() < 0.3) {
      const service = services[Math.floor(Math.random() * services.length)]
      const response = await request(device, 'POST', '/api/orders/create', {
        token: account.token, kind: 'Create order',
        body: {
          customer: { name: `Load Test Customer ${phoneSequence % 1000}`, phone: `0999${String(phoneSequence++ % 10_000_000).padStart(7, '0')}`, email: '' },
          order: { items: [{ service_type_id: service.id, weight_kg: Math.round((3 + Math.random() * 9) * 10) / 10 }], amount_paid: 0, payment_method: 'cash', client_request_id: randomUUID() },
          addons: {},
        },
      })
      if (response.ok && response.data?.data?.id) {
        myOrders.push({ id: response.data.data.id, step: 0 })
        if (response.data.data.order_number) trackingNumbers.push(response.data.data.order_number)
      }
    }
    await sleep(jitter(pollSeconds * 1000))
  }
}

async function administrator(account, stopAt) {
  const device = newDevice()
  let cycle = 0
  await sleep(Math.random() * pollSeconds * 1000)
  while (Date.now() < stopAt) {
    await screen(device, account.token, 'Admin dashboard refresh', adminDashboard())
    if (cycle % 4 === 0) await screen(device, account.token, 'Analytics load (30 days)', analytics())
    cycle += 1
    await sleep(jitter(pollSeconds * 1000))
  }
}

async function customer(stopAt) {
  const device = newDevice()
  await sleep(Math.random() * pollSeconds * 1000)
  while (Date.now() < stopAt) {
    const number = trackingNumbers[Math.floor(Math.random() * trackingNumbers.length)] || 'IC-00000000-00000000'
    await request(device, 'GET', `/api/public/orders/track?q=${encodeURIComponent(number)}`, { kind: 'Customer order tracking' })
    await sleep(jitter(pollSeconds * 1000 / 2))
  }
}

// ---------- stages ----------
const percentile = (values, p) => {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]
}
const weights = Object.entries(mix).filter(([, share]) => share > 0)
const totalWeight = weights.reduce((sum, [, share]) => sum + share, 0)
function peopleFor(count) {
  const plan = Object.fromEntries(weights.map(([kind, share]) => [kind, Math.floor((share / totalWeight) * count)]))
  let assigned = Object.values(plan).reduce((sum, value) => sum + value, 0)
  for (let i = 0; assigned < count; i += 1, assigned += 1) plan[weights[i % weights.length][0]] += 1
  return plan
}

const report = { target, mock, startedAt: new Date().toISOString(), pollSeconds, stageSeconds, maxP95, maxErrorPercent, stages: [] }
let capacity = 0
for (const [index, users] of stages.entries()) {
  currentStage = index + 1
  const plan = peopleFor(users)
  const stopAt = Date.now() + stageSeconds * 1000
  console.log(`\nStage ${currentStage}: ${users} simultaneous users (${Object.entries(plan).map(([kind, n]) => `${n} ${kind}`).join(', ')}) for ${stageSeconds}s`)
  const people = []
  for (let i = 0; i < (plan.staff || 0); i += 1) people.push(staffMember(staffAccounts[i % staffAccounts.length], stopAt))
  for (let i = 0; i < (plan.admin || 0); i += 1) people.push(administrator(admins[i % admins.length], stopAt))
  for (let i = 0; i < (plan.customer || 0); i += 1) people.push(customer(stopAt))
  const stageStarted = Date.now()
  await Promise.all(people)
  const elapsed = (Date.now() - stageStarted) / 1000

  const stageSamples = samples.filter(sample => sample.stage === currentStage)
  const requests = stageSamples.filter(sample => sample.kind.endsWith('· query') || !sample.kind.endsWith('refresh') && !sample.kind.startsWith('Analytics load'))
  const kinds = [...new Set(stageSamples.map(sample => sample.kind))].filter(kind => !kind.endsWith('· query'))
  const userActions = stageSamples.filter(sample => !sample.kind.endsWith('· query'))
  const errors = requests.filter(sample => !sample.ok)
  const summary = {
    stage: currentStage, users, plan, seconds: Math.round(elapsed),
    requests: requests.length, requestsPerSecond: +(requests.length / elapsed).toFixed(1),
    errorPercent: requests.length ? +((errors.length / requests.length) * 100).toFixed(2) : 0,
    userActionP95Ms: Math.round(percentile(userActions.map(sample => sample.ms), 95)),
    actions: kinds.map(kind => {
      const rows = stageSamples.filter(sample => sample.kind === kind)
      return { kind, count: rows.length, p50Ms: Math.round(percentile(rows.map(r => r.ms), 50)), p95Ms: Math.round(percentile(rows.map(r => r.ms), 95)), failed: rows.filter(r => !r.ok).length }
    }),
    topErrors: Object.entries(errors.reduce((map, sample) => { const key = `${sample.status} ${sample.error || ''}`.trim(); map[key] = (map[key] || 0) + 1; return map }, {}))
      .sort((a, b) => b[1] - a[1]).slice(0, 5),
  }
  report.stages.push(summary)
  console.log(`  ${summary.requests} requests (${summary.requestsPerSecond}/s), errors ${summary.errorPercent}%, slowest 5% of user actions above ${(summary.userActionP95Ms / 1000).toFixed(2)} s`)
  for (const action of summary.actions) {
    console.log(`  ${action.kind.padEnd(28)} ${String(action.count).padStart(5)}×  typical ${(action.p50Ms / 1000).toFixed(2)} s  slowest-5% ${(action.p95Ms / 1000).toFixed(2)} s${action.failed ? `  failed ${action.failed}` : ''}`)
  }
  for (const [error, count] of summary.topErrors) console.log(`  error ×${count}: ${error}`)
  const passed = summary.errorPercent <= maxErrorPercent && summary.userActionP95Ms <= maxP95
  summary.passed = passed
  if (!passed) {
    console.log(`  Stopped: above the limits (errors ≤ ${maxErrorPercent}%, slowest-5% ≤ ${(maxP95 / 1000).toFixed(1)} s).`)
    break
  }
  capacity = users
}

report.finishedAt = new Date().toISOString()
report.capacityUsers = capacity
mkdirSync(OUT_DIR, { recursive: true })
const stamp = report.startedAt.replace(/[:.]/g, '-')
const reportFile = path.join(OUT_DIR, `report-${mock ? 'mock-' : ''}${stamp}.json`)
writeFileSync(reportFile, JSON.stringify(report, null, 2))
console.log(`\nResult: the system stayed within the limits up to ${capacity || 'none of the'} simultaneous users tested.`)
console.log(`Full results: ${path.relative(process.cwd(), reportFile)}`)
if (mockServer) {
  console.log(`Mock server saw ${mockServer.addresses.size} distinct client addresses.`)
  await mockServer.close()
}
process.exit(0)
