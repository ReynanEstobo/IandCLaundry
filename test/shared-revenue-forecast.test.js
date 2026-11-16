import assert from 'node:assert/strict'
import test from 'node:test'
import { configureRuntimeEnv } from '../backend/config/supabase.js'
import { generateForecastForAccount } from '../backend/services/aiService.js'
import { analyticsPeriod } from '../frontend/src/utils/chartDates.js'
import { loadNextMonthForecast, loadRevenueForecast } from '../frontend/src/services/revenueForecast.js'

// A browser-like localStorage, so the shared cache entry can be observed.
const store = new Map()
globalThis.localStorage = {
  getItem: key => (store.has(key) ? store.get(key) : null),
  setItem: (key, value) => store.set(key, String(value)),
  removeItem: key => store.delete(key),
  key: index => [...store.keys()][index] ?? null,
  get length() { return store.size },
}

// Records the way Analytics holds them: orders and payments of one branch.
const period = analyticsPeriod('monthly')
const day = offset => new Date(period.end.getTime() - offset * 86_400_000).toISOString()
const records = branch => ({
  orders: Array.from({ length: 40 }, (_, i) => ({ id: `${branch}-o${i}`, created_at: day(1 + (i % 20)), status: 'released', branch })),
  payments: Array.from({ length: 40 }, (_, i) => ({ amount: 250, paid_at: day(1 + (i % 20)), payment_date: null, branch, orders: { id: `${branch}-o${i}`, status: 'released', branch } })),
})

// A stand-in for the page's database client: returns the given rows for
// orders and payments, honouring the branch filter the page adds.
function fakeSupabase(rowsByTable, seenFilters) {
  return {
    from(table) {
      const filters = []
      const query = {
        select: () => query, gte: () => query, lte: () => query, order: () => query,
        eq(column, value) { filters.push([column, value]); seenFilters.push([table, column, value]); return query },
        then(resolve) {
          const rows = rowsByTable[table].filter(row => filters.every(([column, value]) => row[column] === value))
          return Promise.resolve({ data: rows, error: null }).then(resolve)
        },
      }
      return query
    },
  }
}

// The forecast endpoint, answered with fixed month totals.
function stubForecastEndpoint(t, revenue) {
  const requests = []
  const original = globalThis.fetch
  globalThis.fetch = async (path, options) => {
    const body = JSON.parse(options.body)
    requests.push({ path, body })
    return Response.json({
      source: 'gemini', model: 'gemini-2.5-flash', generatedAt: new Date().toISOString(),
      predictions: body.forecastDates.map(date => ({ date, predictedRevenue: revenue, predictedOrders: 300, confidence: 'low' })),
    })
  }
  t.after(() => { globalThis.fetch = original })
  return requests
}

test('the admin dashboard card shows the same forecast as Analytics → Monthly', async t => {
  store.clear()
  const requests = stubForecastEndpoint(t, 61234)
  const { orders, payments } = records('Main - Brgy 7')
  const analytics = await loadRevenueForecast({ orders, payments, period, grouping: 'monthly', branch: 'all' })
  assert.equal(analytics.meta.source, 'gemini')
  assert.equal(analytics.data.length, 6)
  assert.equal(requests.length, 1)

  const seen = []
  const dashboard = await loadNextMonthForecast(fakeSupabase({ orders, payments }, seen))
  assert.equal(requests.length, 1, 'the dashboard reuses the forecast instead of asking again')
  assert.deepEqual(dashboard.nextMonth, analytics.data[0])
  assert.equal(dashboard.nextMonth.predicted, 61234)
  assert.equal(dashboard.meta.isCached, true)
  assert.deepEqual(seen, [], 'all branches: no branch filter')
})

test('the staff card reads and forecasts only its own branch', async t => {
  store.clear()
  const requests = stubForecastEndpoint(t, 20500)
  const main = records('Main - Brgy 7')
  const calzada = records('2nd Branch - Brgy Calzada')
  const seen = []
  const staff = await loadNextMonthForecast(fakeSupabase({
    orders: [...main.orders, ...calzada.orders],
    payments: [...main.payments, ...calzada.payments],
  }, seen), { branch: '2nd Branch - Brgy Calzada' })
  assert.deepEqual(seen, [['orders', 'branch', '2nd Branch - Brgy Calzada'], ['payments', 'branch', '2nd Branch - Brgy Calzada']])
  assert.equal(requests[0].body.branch, '2nd Branch - Brgy Calzada')
  assert.equal(requests[0].body.range, 'monthly')
  const sentOrders = requests[0].body.history.reduce((sum, d) => sum + d.orders, 0)
  assert.equal(sentOrders, 40, 'only the branch\'s 40 orders reach the forecast')
  assert.equal(staff.nextMonth.predicted, 20500)

  // Analytics filtered to the same branch then shows the same figure.
  const analytics = await loadRevenueForecast({ ...calzada, period, grouping: 'monthly', branch: '2nd Branch - Brgy Calzada' })
  assert.deepEqual(analytics.data[0], staff.nextMonth)
  assert.equal(requests.length, 1)
})

test('forecast endpoint: staff get their own branch, others are refused', async t => {
  configureRuntimeEnv({ GEMINI_API_KEY: 'test-key' })
  const prompts = []
  const original = globalThis.fetch
  globalThis.fetch = async (_url, options) => {
    const prompt = JSON.parse(options.body).contents.at(-1).parts.map(part => part.text).join('')
    prompts.push(prompt)
    const dates = JSON.parse(/Forecast dates: (\[.*?\])/.exec(prompt)[1])
    const text = JSON.stringify({ predictions: dates.map(date => ({ date, predictedRevenue: 500, predictedOrders: 3, confidence: 'low' })), insights: [], method: 'test' })
    return Response.json({ candidates: [{ content: { role: 'model', parts: [{ text }] }, finishReason: 'STOP' }] })
  }
  t.after(() => { globalThis.fetch = original; configureRuntimeEnv(null) })
  const input = { history: [{ date: '2026-11-10', revenue: 1777, orders: 4 }], forecastDates: ['2026-11-17'], branch: '3rd Branch - Nasugbu', range: 'weekly' }

  await generateForecastForAccount(input, { role: 'staff', branch: 'Main - Brgy 7' })
  assert.match(prompts.at(-1), /Branch scope: Main - Brgy 7\n/, 'a staff forecast is labelled with the staff member\'s branch')
  await generateForecastForAccount({ ...input, history: [{ date: '2026-11-10', revenue: 1778, orders: 4 }] }, { role: 'admin' })
  assert.match(prompts.at(-1), /Branch scope: 3rd Branch - Nasugbu\n/)
  assert.throws(() => generateForecastForAccount(input, { role: 'unassigned' }), error => error.status === 403)
  assert.throws(() => generateForecastForAccount(input, { role: 'staff', branch: null }), error => error.status === 403)
})
