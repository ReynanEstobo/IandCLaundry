import assert from 'node:assert/strict'
import test from 'node:test'
import { configureRuntimeEnv } from '../backend/config/supabase.js'
import { generateForecast } from '../backend/services/aiService.js'
import { analyticsDailyHistory, fromFirstRecordedDay } from '../frontend/src/utils/analyticsMetrics.js'

const day = (date, orders, revenue = orders * 300) => ({ date, orders, revenue })

test('forecast history starts at the first day with an order or payment; later quiet days still count', () => {
  const history = [day('2026-09-12', 0), day('2026-09-13', 0), day('2026-09-14', 0, 150), day('2026-09-15', 8), day('2026-09-16', 0), day('2026-09-17', 9)]
  assert.deepEqual(fromFirstRecordedDay(history).map(d => d.date), ['2026-09-14', '2026-09-15', '2026-09-16', '2026-09-17'])
  assert.deepEqual(fromFirstRecordedDay([day('2026-09-12', 0), day('2026-09-13', 0)]), [])
  assert.deepEqual(fromFirstRecordedDay([]), [])
})

test('a This-year view of a shop that started in September forecasts from September, not January', () => {
  const orders = Array.from({ length: 20 }, (_, i) => ({ id: `o${i}`, status: 'released', created_at: `2026-09-${String(15 + (i % 10)).padStart(2, '0')}T09:00:00` }))
  const daily = analyticsDailyHistory(orders, [], new Date('2026-01-01T00:00:00'), new Date('2026-09-24T18:00:00'))
  const history = fromFirstRecordedDay(daily)
  assert.equal(daily.length, 267, 'the whole year so far is laid out day by day')
  assert.equal(history.length, 10)
  assert.equal(history[0].date, '2026-09-15')
  assert.equal(history.reduce((sum, d) => sum + d.orders, 0) / history.length, 2)
})

test('the server forecast and its fallback ignore days before the shop started recording', async t => {
  const empty = Array.from({ length: 50 }, (_, i) => day(new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10), 0))
  const recorded = Array.from({ length: 30 }, (_, i) => day(new Date(Date.UTC(2026, 1, 20 + i)).toISOString().slice(0, 10), 20 + (i % 3), 6000 + i))
  const forecastDates = ['2026-03-22', '2026-03-23']

  // Without the AI, the local estimate averages only the recorded days.
  configureRuntimeEnv({})
  t.after(() => configureRuntimeEnv(null))
  const fallback = await generateForecast({ history: [...empty, ...recorded], forecastDates, branch: 'all', range: 'monthly' })
  assert.equal(fallback.source, 'baseline')
  assert.equal(fallback.predictions[0].predictedOrders, 21, 'about 21 orders a day, not 8 from averaging in the empty days')

  // The AI is shown only the recorded days, and confidence follows their number.
  configureRuntimeEnv({ GEMINI_API_KEY: 'test-key' })
  let prompt = ''
  const original = globalThis.fetch
  t.after(() => { globalThis.fetch = original })
  globalThis.fetch = async (_url, options) => {
    prompt = JSON.parse(options.body).contents.at(-1).parts.map(part => part.text).join('')
    const predictions = forecastDates.map(date => ({ date, predictedRevenue: 6200, predictedOrders: 21, confidence: 'high' }))
    return Response.json({ candidates: [{ content: { role: 'model', parts: [{ text: JSON.stringify({ predictions, insights: [], method: 'test' }) }] }, finishReason: 'STOP' }] })
  }
  const ai = await generateForecast({ history: [...empty, ...recorded.map(d => ({ ...d, revenue: d.revenue + 1 }))], forecastDates, branch: 'all', range: 'monthly' })
  const sent = JSON.parse(/Historical observations: (\[.*?\])\n/s.exec(prompt)[1])
  assert.equal(sent.length, 30)
  assert.equal(sent[0].date, '2026-02-20')
  assert.deepEqual(ai.predictions.map(p => p.confidence), ['medium', 'medium'], '30 recorded days allow medium, not high')
})
