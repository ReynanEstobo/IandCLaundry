import assert from 'node:assert/strict'
import test from 'node:test'
import { configureRuntimeEnv } from '../backend/config/supabase.js'
import { DECISION_AREAS, generateDecisionSupport } from '../backend/services/aiService.js'
import { buildAnalyticsReport } from '../frontend/src/utils/analyticsReport.js'
import { describeForecastPeak, forecastPeak } from '../frontend/src/utils/forecastPeak.js'

let run = 0
// Each test sends different metrics, so the server's reply cache never links two tests.
const metrics = signals => ({ totalRevenue: 1000 + (run += 1), operationalSignals: signals })
const signals = [
  'Forecast peak · Expected busiest day: Saturday, November 21, 2026, about 32 orders (other days average 24).',
  'Service Clothing: 120 requests, ₱26,400 in service sales.',
  'Branch Main - Brgy 7: 140 orders created, ₱31,000 received.',
  'Low stock: Ariel Powder Detergent has 57 sachets left at 3rd Branch - Nasugbu (minimum 58).',
]
const recommendation = (area, title = area) => ({ area, title, description: `Signal for ${area}.`, recommendation: `Option for ${area}.` })

function withGemini(t, reply) {
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

test('decision support gives one recommendation per objective-3 area, in a fixed order', async t => {
  const prompts = withGemini(t, () => ({ insights: [
    recommendation('inventory'), recommendation('Branch Performance'), recommendation('service_demand'), recommendation('staffing'),
  ] }))
  const many = [...Array(16)].map((_, i) => `Staff member ${i}: 3 released, 4 created orders.`)
  const result = await generateDecisionSupport({ metrics: metrics([...many, ...signals]), trendData: [], forecastData: [], range: 'weekly' })
  assert.equal(result.source, 'gemini')
  assert.deepEqual(result.insights.map(item => item.area), DECISION_AREAS)
  assert.deepEqual(DECISION_AREAS, ['service_demand', 'staffing', 'inventory', 'branch_performance'])
  assert.match(prompts[0], /Return exactly 4 insights, one for each area/)
  assert.match(prompts[0], /Ariel Powder Detergent has 57 sachets/, 'a low-stock signal after many staff lines still reaches Gemini')
})

test('a reply that leaves out an area is not used; the local fallback still covers all four', async t => {
  const prompts = withGemini(t, () => ({ insights: [recommendation('service_demand'), recommendation('staffing'), recommendation('staffing'), recommendation('branch_performance')] }))
  const result = await generateDecisionSupport({ metrics: metrics(signals), trendData: [], forecastData: [], range: 'weekly' })
  assert.equal(result.source, 'baseline')
  assert.ok(prompts.length > 1, 'the models were asked again first')
  assert.deepEqual(result.insights.map(item => item.area), DECISION_AREAS)
  const [service, staffing, inventory, branch] = result.insights
  assert.match(service.description, /Clothing/)
  assert.match(staffing.description, /busiest day/)
  assert.match(inventory.description, /Ariel Powder Detergent/)
  assert.match(inventory.recommendation, /restock/i)
  assert.match(branch.description, /Main - Brgy 7/)
})

test('a reply without area names is read in the requested order', async t => {
  withGemini(t, () => ({ insights: DECISION_AREAS.map(area => ({ ...recommendation(area), area: undefined })) }))
  const result = await generateDecisionSupport({ metrics: metrics(signals), trendData: [], forecastData: [], range: 'weekly' })
  assert.equal(result.source, 'gemini')
  assert.deepEqual(result.insights.map(item => [item.area, item.title]), DECISION_AREAS.map(area => [area, area]))
})

test('without Gemini, the local fallback says plainly when no item is low on stock', async t => {
  configureRuntimeEnv({})
  t.after(() => configureRuntimeEnv(null))
  const result = await generateDecisionSupport({ metrics: metrics(['No inventory item is at or below its minimum stock.']), trendData: [], forecastData: [], range: 'weekly' })
  assert.deepEqual(result.insights.map(item => item.area), DECISION_AREAS)
  assert.match(result.insights[2].description, /No item is at or below its minimum stock/)
})

const day = (date, orders) => ({ date, fullDate: date, predictedOrders: orders })

test('the demand forecast names a busiest day only when it stands out', () => {
  const weekly = [day('Mon', 22), day('Tue', 23), day('Wed', 24), day('Thu', 23), day('Fri', 25), day('Sat', 32), day('Sun', 26)]
  const peak = forecastPeak(weekly, 'weekly')
  assert.equal(peak.distinct, true)
  assert.equal(peak.index, 5)
  assert.equal(describeForecastPeak(peak), 'Expected busiest day: Sat, about 32 orders (other days average 24).')

  const flat = forecastPeak(weekly.map(point => ({ ...point, predictedOrders: 24 })), 'weekly')
  assert.equal(flat.distinct, false)
  assert.equal(describeForecastPeak(flat), 'No distinct peak expected: about 24 orders per day across the forecast.')

  // February has fewer days and March more; that alone is not a peak.
  const months = [day('Dec 2026', 880), day('Jan 2027', 880), day('Feb 2027', 795), day('Mar 2027', 880), day('Apr 2027', 852), day('May 2027', 880)]
  assert.equal(forecastPeak(months, 'monthly').distinct, false)
  assert.equal(forecastPeak(months, 'monthly').unit, 'month')
  assert.equal(forecastPeak([day('Mon', 5)], 'weekly'), null)
  assert.equal(forecastPeak(weekly.map(point => ({ ...point, predictedOrders: 0 })), 'weekly'), null)
})

test('reports name each recommendation by its area', () => {
  const report = buildAnalyticsReport({
    generatedAt: new Date('2026-11-16T15:00:00+08:00'),
    aiInsights: [{ area: 'inventory', title: 'Restock detergent', description: 'Ariel is below minimum at Nasugbu.', recommendation: 'Restock.' }],
  })
  assert.match(report.csv, /Inventory usage · Restock detergent/)
  assert.match(report.printHtml, /<h3>Inventory usage · Restock detergent<\/h3>/)
})
