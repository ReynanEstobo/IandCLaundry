import assert from 'node:assert/strict'
import test from 'node:test'
import { configureRuntimeEnv } from '../backend/config/supabase.js'
import { generateForecast } from '../backend/services/aiService.js'
import { chartTooltipDate, forecastLabels, forecastPeriods } from '../frontend/src/utils/chartDates.js'
import { buildAnalyticsReport } from '../frontend/src/utils/analyticsReport.js'

const now = new Date('2026-11-16T15:00:00')
// 32 recorded days at 14 orders and PHP 2,100 a day, plus a run counter so
// the server's reply cache never links two tests.
let run = 0
const recordedDays = () => Array.from({ length: 32 }, (_, i) => ({
  date: new Date(Date.UTC(2026, 9, 16 + i)).toISOString().slice(0, 10),
  orders: 14,
  revenue: 2100 + (i === 0 ? (run += 1) : 0),
}))
const monthDates = forecastPeriods('monthly', now).map(period => period.forecastDate)

function withGeminiReply(t, reply) {
  configureRuntimeEnv({ GEMINI_API_KEY: 'test-key' })
  const prompts = []
  const original = globalThis.fetch
  globalThis.fetch = async (_url, options) => {
    prompts.push(JSON.parse(options.body).contents.at(-1).parts.map(part => part.text).join(''))
    return Response.json({ candidates: [{ content: { role: 'model', parts: [{ text: JSON.stringify(reply()) }] }, finishReason: 'STOP' }] })
  }
  t.after(() => { globalThis.fetch = original; configureRuntimeEnv(null) })
  return prompts
}

test('monthly forecast covers the next 6 calendar months, labelled like the trend chart', () => {
  const periods = forecastPeriods('monthly', now)
  assert.deepEqual(periods.map(p => p.forecastDate), ['2026-12-01', '2027-01-01', '2027-02-01', '2027-03-01', '2027-04-01', '2027-05-01'])
  assert.deepEqual(periods.map(p => p.date), ['Dec 2026', 'Jan 2027', 'Feb 2027', 'Mar 2027', 'Apr 2027', 'May 2027'])
  assert.equal(chartTooltipDate('Dec 2026', [{ payload: periods[0] }]), 'December 2026')
  assert.equal(forecastPeriods('monthly', new Date('2026-01-31T10:00:00'))[0].forecastDate, '2026-02-01', 'a month end does not skip February')
})

test('weekly and yearly forecasts keep their 7 days and 5 years', () => {
  const weekly = forecastPeriods('weekly', now)
  assert.equal(weekly.length, 7)
  assert.equal(weekly[0].forecastDate, '2026-11-16')
  assert.equal(weekly[0].date, 'Mon, Nov 16')
  assert.equal(weekly[0].forecastPeriod, undefined, 'reports keep the exact date for a day')
  const yearly = forecastPeriods('yearly', now)
  assert.deepEqual(yearly.map(p => p.date), ['2026', '2027', '2028', '2029', '2030'])
  assert.equal(forecastLabels('yearly', yearly[1].forecastDate).fullDate, '2027')
})

test('reports name a monthly forecast row by its month', () => {
  const periods = forecastPeriods('monthly', now)
  const report = buildAnalyticsReport({
    reportScope: 'All branches', reportPeriod: 'Monthly view', generatedAt: now,
    forecastData: periods.map(p => ({ ...p, predicted: 60000, predictedOrders: 400, confidence: 'low' })),
  })
  assert.match(report.csv, /"Dec 2026","?60000/)
  assert.doesNotMatch(report.csv, /2026-12-01/)
  assert.match(report.printHtml, /<td>Dec 2026<\/td>/)
})

test('the monthly fallback estimate is a whole-month total, not one day', async t => {
  configureRuntimeEnv({})
  t.after(() => configureRuntimeEnv(null))
  const result = await generateForecast({ history: recordedDays(), forecastDates: monthDates, branch: 'all', range: 'monthly' })
  assert.equal(result.source, 'baseline')
  assert.equal(result.predictions[0].date, '2026-12-01')
  assert.equal(result.predictions[0].predictedOrders, 14 * 31, 'December has 31 days')
  assert.equal(result.predictions[2].predictedOrders, 14 * 28, 'February 2027 has 28 days')
})

test('Gemini is asked for month totals and its confidence is capped by the recorded days', async t => {
  const prompts = withGeminiReply(t, () => ({
    predictions: monthDates.map(date => ({ date, predictedRevenue: 65000, predictedOrders: 430, confidence: 'high' })),
    insights: [], method: 'test',
  }))
  const result = await generateForecast({ history: recordedDays(), forecastDates: monthDates, branch: 'all', range: 'monthly' })
  assert.equal(result.source, 'gemini')
  assert.match(prompts[0], /TOTAL revenue and TOTAL orders for that whole month/)
  assert.match(prompts[0], /"2026-12-01":31/)
  assert.deepEqual(result.predictions.map(p => p.predictedOrders), Array(6).fill(430))
  assert.ok(result.predictions.every(p => p.confidence === 'low'), '32 recorded days keep a 6-month forecast at low confidence')
})

test('a reply with daily figures for the monthly view is not used', async t => {
  const prompts = withGeminiReply(t, () => ({
    predictions: monthDates.map(date => ({ date, predictedRevenue: 2100, predictedOrders: 14, confidence: 'low' })),
    insights: [], method: 'test',
  }))
  const result = await generateForecast({ history: recordedDays(), forecastDates: monthDates, branch: 'all', range: 'monthly' })
  assert.equal(result.source, 'baseline')
  assert.equal(result.reason, 'invalid_response')
  assert.equal(result.predictions[0].predictedOrders, 14 * 31)
  assert.ok(prompts.length > 1, 'the models were asked again before falling back')
})

test('an older page that sends 30 daily dates for the monthly view still gets daily figures', async t => {
  configureRuntimeEnv({})
  t.after(() => configureRuntimeEnv(null))
  const dailyDates = Array.from({ length: 30 }, (_, i) => new Date(Date.UTC(2026, 10, 16 + i)).toISOString().slice(0, 10))
  const result = await generateForecast({ history: recordedDays(), forecastDates: dailyDates, branch: 'all', range: 'monthly' })
  assert.equal(result.predictions.length, 30)
  assert.equal(result.predictions[0].predictedOrders, 14)
})
