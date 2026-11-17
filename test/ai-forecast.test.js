import assert from 'node:assert/strict'
import test from 'node:test'
import { configureRuntimeEnv } from '../backend/config/supabase.js'
import { generateDecisionSupport, generateForecast, parseJsonObject } from '../backend/services/aiService.js'
import { dataFingerprint, describeAiSource, lastGeminiResult, reusableAiCache } from '../frontend/src/utils/aiOutputCache.js'

const forecastDates = ['2026-11-01', '2026-11-02']
const prediction = (date, revenue = 500, orders = 3) => ({ date, predictedRevenue: revenue, predictedOrders: orders, confidence: 'low' })
const forecastReply = JSON.stringify({ predictions: forecastDates.map(date => prediction(date)), insights: [], method: 'test' })
let historyCounter = 0
// Each test sends different history, so the server's reply cache never links two tests.
const freshHistory = () => [{ date: '2026-10-30', revenue: 1000 + (historyCounter += 1), orders: 4 }]

function geminiReply(text) {
  return Response.json({ candidates: [{ content: { role: 'model', parts: [{ text }] }, finishReason: 'STOP' }] })
}

function geminiError(status, statusText, message, details) {
  return new Response(JSON.stringify({ error: { code: status, message, ...(details ? { details } : {}) } }), { status, statusText, headers: { 'Content-Type': 'application/json' } })
}

function withGemini(t, handler) {
  configureRuntimeEnv({ GEMINI_API_KEY: 'test-key' })
  const calls = []
  const original = globalThis.fetch
  globalThis.fetch = async (url, options) => {
    const model = String(url).match(/models\/([^:]+):/)?.[1]
    calls.push(model)
    return handler(model, calls.length, options)
  }
  t.after(() => { globalThis.fetch = original; configureRuntimeEnv(null) })
  return calls
}

// Three weeks of daily totals from Sunday 25 October 2026 to Saturday 14
// November, each call with its own revenue so the reply cache never links tests.
const threeWeeks = () => {
  const offset = (historyCounter += 1)
  return Array.from({ length: 21 }, (_, i) => ({
    date: new Date(Date.UTC(2026, 9, 25 + i)).toISOString().slice(0, 10),
    revenue: 5000 + i * 37 + offset,
    orders: 20 + (i % 7),
  }))
}
const nextWeek = ['2026-11-15', '2026-11-16', '2026-11-17', '2026-11-18', '2026-11-19', '2026-11-20', '2026-11-21']
const promptOf = options => JSON.parse(options.body).contents[0].parts[0].text

test('ai forecast: Gemini forecasts from weekday averages and the recent trend', async t => {
  let prompt = ''
  withGemini(t, (model, n, options) => {
    prompt = promptOf(options)
    return geminiReply(JSON.stringify({ predictions: nextWeek.map((date, i) => prediction(date, 6101 + i, 24)), insights: [], method: 'weekday averages' }))
  })
  const result = await generateForecast({ history: threeWeeks(), forecastDates: nextWeek, branch: 'all', range: 'weekly' })
  assert.equal(result.source, 'gemini')
  assert.match(prompt, /Weekday averages over all recorded weeks \(per day\): \{"Sun":\{"recordedDays":3,"averageOrders":20,/)
  assert.match(prompt, /Recent trend: \{"recentDays":14,"earlierDays":7,/)
  assert.match(prompt, /Weekday of each forecast date: \{"2026-11-15":"Sun","2026-11-16":"Mon",/)
  assert.match(prompt, /start each date from the average of its weekday, then apply the recent trend/)
  assert.match(prompt, /Never copy a single past day's revenue or orders/)
})

test('ai forecast: a reply that repeats the latest week is not used; the next model is asked', async t => {
  const history = threeWeeks()
  const lastWeek = history.slice(-7)
  const copied = JSON.stringify({ predictions: nextWeek.map((date, i) => prediction(date, lastWeek[i].revenue, lastWeek[i].orders)), insights: [], method: 'same day last week' })
  const forecast = JSON.stringify({ predictions: nextWeek.map((date, i) => prediction(date, 6150 + i * 11, 23)), insights: [], method: 'weekday averages' })
  const calls = withGemini(t, model => geminiReply(model === 'gemini-2.5-flash' ? copied : forecast))
  const result = await generateForecast({ history, forecastDates: nextWeek, branch: 'all', range: 'weekly' })
  assert.equal(result.source, 'gemini')
  assert.equal(result.model, 'gemini-2.5-flash-lite')
  assert.deepEqual(calls, ['gemini-2.5-flash', 'gemini-2.5-flash-lite'])
  assert.deepEqual(result.predictions.map(item => item.predictedRevenue), nextWeek.map((date, i) => 6150 + i * 11))
})

test('ai forecast: a month forecast is told how many of each weekday every month holds', async t => {
  let prompt = ''
  const months = ['2026-12-01', '2027-01-01']
  withGemini(t, (model, n, options) => {
    prompt = promptOf(options)
    return geminiReply(JSON.stringify({ predictions: months.map(date => prediction(date, 170000, 700)), insights: [], method: 'weekday averages' }))
  })
  const result = await generateForecast({ history: threeWeeks(), forecastDates: months, branch: 'all', range: 'monthly' })
  assert.equal(result.source, 'gemini')
  assert.match(prompt, /Weekdays in each forecast month: \{"2026-12-01":\{"Sun":4,"Mon":4,"Tue":5,"Wed":5,"Thu":5,"Fri":4,"Sat":4\}/)
  assert.match(prompt, /for each month, add up the weekday averages for every day of that month/)
})

test('ai forecast: a reply with a stray character after the JSON is still used', async t => {
  withGemini(t, () => geminiReply(`${forecastReply}\n}`))
  const result = await generateForecast({ history: freshHistory(), forecastDates, branch: 'all', range: 'weekly' })
  assert.equal(result.source, 'gemini')
  assert.equal(result.model, 'gemini-2.5-flash')
  assert.deepEqual(result.predictions.map(item => item.predictedRevenue), [500, 500])
})

test('ai forecast: a busy model hands over to the next model', async t => {
  const calls = withGemini(t, model => model === 'gemini-2.5-flash'
    ? geminiError(503, 'Service Unavailable', 'This model is currently experiencing high demand.')
    : geminiReply(forecastReply))
  const result = await generateForecast({ history: freshHistory(), forecastDates, branch: 'all', range: 'monthly' })
  assert.equal(result.source, 'gemini')
  assert.equal(result.model, 'gemini-2.5-flash-lite')
  assert.deepEqual(calls, ['gemini-2.5-flash', 'gemini-2.5-flash-lite'])
})

test('ai forecast: a refused server location stops at once and says so', async t => {
  const calls = withGemini(t, () => geminiError(400, 'Bad Request', 'User location is not supported for the API use.'))
  const result = await generateForecast({ history: freshHistory(), forecastDates, branch: 'all', range: 'weekly' })
  assert.equal(result.source, 'baseline')
  assert.equal(result.reason, 'location_blocked')
  assert.match(result.reasonMessage, /server location/)
  assert.deepEqual(calls, ['gemini-2.5-flash'], 'the other models would refuse in the same way')
})

test('ai forecast: predictions with rewritten dates are matched by position', async t => {
  const rewritten = JSON.stringify({ predictions: [prediction('Nov 1', '1,200', 5), prediction('Nov 2', 900, 4)] })
  withGemini(t, () => geminiReply(rewritten))
  const result = await generateForecast({ history: freshHistory(), forecastDates, branch: 'all', range: 'yearly' })
  assert.equal(result.source, 'gemini')
  assert.deepEqual(result.predictions.map(item => [item.date, item.predictedRevenue]), [['2026-11-01', 1200], ['2026-11-02', 900]])
})

test('ai forecast: unusable replies are retried, then the baseline says why', async t => {
  const calls = withGemini(t, () => geminiReply('{"predictions": []}'))
  const result = await generateForecast({ history: freshHistory(), forecastDates, branch: 'all', range: 'weekly' })
  assert.equal(result.source, 'baseline')
  assert.equal(result.reason, 'invalid_response')
  assert.match(result.reasonMessage, /not with a usable result/)
  assert.equal(calls.length, 6, 'each model is asked twice')
})

test('ai forecast: an unusable reply is not cached, so the next request asks Gemini again', async t => {
  const history = freshHistory()
  let good = false
  const calls = withGemini(t, () => geminiReply(good ? forecastReply : 'not json'))
  assert.equal((await generateForecast({ history, forecastDates, branch: 'all', range: 'weekly' })).source, 'baseline')
  good = true
  const before = calls.length
  const retried = await generateForecast({ history, forecastDates, branch: 'all', range: 'weekly' })
  assert.equal(retried.source, 'gemini')
  assert.equal(calls.length, before + 1)
  const cached = await generateForecast({ history, forecastDates, branch: 'all', range: 'weekly' })
  assert.equal(cached.cached, true)
  assert.equal(calls.length, before + 1, 'a good reply is reused instead of asking again')
  const regenerated = await generateForecast({ history, forecastDates, branch: 'all', range: 'weekly', refresh: true })
  assert.equal(regenerated.cached, false)
  assert.equal(calls.length, before + 2, 'Regenerate asks Gemini again')
})

test('ai forecast: no recorded orders is reported as the reason, without asking Gemini', async t => {
  const calls = withGemini(t, () => geminiReply(forecastReply))
  const result = await generateForecast({ history: [{ date: '2026-10-30', revenue: 0, orders: 0 }], forecastDates, branch: 'all', range: 'weekly' })
  assert.equal(result.source, 'baseline')
  assert.equal(result.reason, 'no_data')
  assert.equal(calls.length, 0)
})

test('ai forecast: a missing API key is named as the reason', async () => {
  configureRuntimeEnv({ GEMINI_API_KEY: '' })
  const result = await generateForecast({ history: freshHistory(), forecastDates, branch: 'all', range: 'weekly' })
  configureRuntimeEnv(null)
  assert.equal(result.source, 'baseline')
  assert.equal(result.reason, 'not_configured')
})

test('ai decision support: Gemini insights are labelled with their source', async t => {
  const insights = ['service_demand', 'staffing', 'inventory', 'branch_performance'].map(area => ({ area, title: area, description: 'Signal.', recommendation: 'Option: check.' }))
  withGemini(t, () => geminiReply(`\`\`\`json\n${JSON.stringify({ insights })}\n\`\`\``))
  const result = await generateDecisionSupport({ metrics: { totalRevenue: historyCounter += 1 }, trendData: [], forecastData: [], range: 'weekly' })
  assert.equal(result.source, 'gemini')
  assert.equal(result.insights.length, 4)
})

// Runs last: the daily-limit pause it sets stays in place for the rest of this process.
test('ai forecast: a used-up daily limit is skipped until it resets, and the reason says when', async t => {
  const quota = model => geminiError(429, 'Too Many Requests', `Quota exceeded for ${model}.`, [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '7087s' }])
  const calls = withGemini(t, quota)
  const first = await generateForecast({ history: freshHistory(), forecastDates, branch: 'all', range: 'weekly' })
  assert.equal(first.reason, 'quota')
  assert.match(first.reasonMessage, /resets in about 2 h/)
  assert.equal(calls.length, 3)
  const second = await generateForecast({ history: freshHistory(), forecastDates, branch: 'all', range: 'weekly' })
  assert.equal(second.reason, 'quota')
  assert.equal(calls.length, 3, 'models known to be out of quota are not asked again')
})

test('ai json reader keeps the first complete object', () => {
  assert.deepEqual(parseJsonObject('{"a":"x}"}\n}'), { a: 'x}' })
  assert.deepEqual(parseJsonObject('[{"a":1}]'), { a: 1 })
  assert.throws(() => parseJsonObject('no json here'), /not valid JSON/)
})

test('ai browser cache: reuse rules and source wording', () => {
  const now = 10 * 60 * 60 * 1000
  const entry = { data: [1], model: 'gemini-2.5-flash', savedAt: now - 2 * 60 * 60 * 1000, dataVersion: dataFingerprint([1, 2]) }
  assert.equal(reusableAiCache(entry, dataFingerprint([1, 2]), now), entry, 'same data is reused for up to 6 hours')
  assert.equal(reusableAiCache(entry, dataFingerprint([1, 3]), now), null, 'changed data is reused for 1 hour only')
  assert.equal(lastGeminiResult(entry, now), entry, 'kept to show while Gemini cannot answer')
  assert.equal(lastGeminiResult(entry, now + 24 * 60 * 60 * 1000), null)
  assert.equal(describeAiSource({ source: 'gemini', model: 'gemini-2.5-flash-lite', isCached: false }), 'Generated by Gemini AI (Gemini 2.5 Flash-Lite)')
  assert.equal(describeAiSource({ source: 'baseline', reason: 'Gemini is busy.' }), 'Local baseline, not Gemini AI. Reason: Gemini is busy.')
})
