import { GoogleGenerativeAI } from '@google/generative-ai'
import { runtimeValue } from '../config/supabase.js'

// Prefer the stable Flash models. Availability can still vary by Gemini
// project, region, quota, or provider status, so every model is tried before
// the service falls back to a local deterministic baseline.
const models = ['gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-3.6-flash']
// model -> { until, reason }: skip a model only while Google says it will refuse.
const cooldowns = new Map()
const responseCache = new Map()
const CACHE_TTL_MS = 6 * 60 * 60 * 1000
const MAX_CACHE_ENTRIES = 100
const ATTEMPT_TIMEOUT_MS = 25_000
const TOTAL_BUDGET_MS = 50_000
const RETRY_PAUSE_MS = 1_000
// Busy, slow, or malformed replies are usually momentary; try those models once more.
const TRANSIENT_REASONS = new Set(['busy', 'timeout', 'network', 'invalid_response', 'error'])

const MAX_PROMPT_LENGTH = 20_000

const REASON_PRIORITY = ['not_configured', 'key_rejected', 'location_blocked', 'quota', 'busy', 'timeout', 'network', 'invalid_response', 'model_unavailable', 'error']
const SHORT_REASONS = {
  quota: 'limit reached',
  busy: 'busy',
  timeout: 'timed out',
  network: 'unreachable',
  invalid_response: 'gave an unusable reply',
  model_unavailable: 'not available',
  error: 'failed',
}

export function geminiModelLabel(model) {
  return String(model || '').replace(/^gemini-/, 'Gemini ').replace(/-lite$/, '-Lite').replace(/-flash/, ' Flash').replace(/-pro/, ' Pro')
}

function durationLabel(ms) {
  const minutes = Math.max(1, Math.ceil(ms / 60_000))
  return minutes < 60 ? `${minutes} min` : `${Math.round(minutes / 60)} h`
}

function retryDelayMs(error) {
  const info = (Array.isArray(error?.errorDetails) ? error.errorDetails : [])
    .find(detail => String(detail?.['@type'] || '').endsWith('RetryInfo'))
  const seconds = Number.parseFloat(String(info?.retryDelay || ''))
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null
}

export function classifyGeminiError(error) {
  const status = Number(error?.status) || 0
  const message = String(error?.message || '').toLowerCase()
  if (status === 429 || /quota|rate limit|resource exhausted|too many requests/.test(message)) {
    return { reason: 'quota', cooldownMs: retryDelayMs(error) ?? 60_000 }
  }
  if (status === 401 || status === 403 || /api key not valid|api_key_invalid|permission denied|permission_denied/.test(message)) {
    return { reason: 'key_rejected', cooldownMs: 0, stop: true }
  }
  // Every model answers the same from a refused location, so stop there. The
  // next request may run elsewhere, so nothing is put on cooldown.
  if (/location is not supported/.test(message)) return { reason: 'location_blocked', cooldownMs: 0, stop: true }
  if (status === 404 || /not found|unsupported|is not supported/.test(message)) return { reason: 'model_unavailable', cooldownMs: 60 * 60_000 }
  if (error?.name === 'AbortError' || /timed? ?out|deadline|aborted/.test(message)) return { reason: 'timeout', cooldownMs: 0 }
  if (status >= 500 || /overloaded|high demand|unavailable|internal error/.test(message)) return { reason: 'busy', cooldownMs: 0 }
  if (/fetch failed|network|econn|enotfound|socket/.test(message)) return { reason: 'network', cooldownMs: 0 }
  return { reason: 'error', cooldownMs: 0 }
}

// Turns the per-model outcomes into one plain sentence for the page.
export function unavailableMessage(attempts, retryAfterMs = null) {
  const latest = new Map()
  attempts.forEach(attempt => latest.set(attempt.model || 'gemini', attempt.reason))
  const reasons = [...new Set(latest.values())]
  if (reasons.includes('not_configured')) return 'Gemini is not set up: the GEMINI_API_KEY secret is missing on the server.'
  if (reasons.includes('key_rejected')) return 'Google rejected the Gemini API key. Check the GEMINI_API_KEY secret.'
  if (reasons.includes('location_blocked')) return 'Google does not offer Gemini in the server location that handled this request.'
  if (reasons.length === 1) {
    if (reasons[0] === 'quota') return `Gemini's request limit is used up for now${retryAfterMs ? `; it resets in about ${durationLabel(retryAfterMs)}` : ''}.`
    if (reasons[0] === 'busy') return 'Gemini is overloaded right now (Google reported high demand).'
    if (reasons[0] === 'timeout') return 'Gemini took too long to reply.'
    if (reasons[0] === 'network') return 'The server could not reach Gemini.'
    if (reasons[0] === 'invalid_response') return 'Gemini replied, but not with a usable result.'
  }
  if (!latest.size) return 'Gemini could not be reached.'
  return `Gemini could not answer: ${[...latest].map(([model, reason]) => `${geminiModelLabel(model)} ${SHORT_REASONS[reason] || 'failed'}`).join('; ')}.`
}

function unavailable(attempts) {
  const reason = REASON_PRIORITY.find(code => attempts.some(attempt => attempt.reason === code)) || 'error'
  const quotaWaits = attempts.filter(attempt => attempt.reason === 'quota' && attempt.retryAfterMs).map(attempt => attempt.retryAfterMs)
  const retryAfterMs = quotaWaits.length ? Math.min(...quotaWaits) : null
  return {
    text: null,
    data: null,
    model: 'Unavailable',
    reason,
    reasonMessage: unavailableMessage(attempts, retryAfterMs),
    retryAfterMs,
    attempts: attempts.map(({ model, reason: code }) => ({ model, reason: code })),
  }
}

// Entry point for the free-form `ai/generate` endpoint. Internal callers use
// askGemini directly with their own server-built prompts.
export async function generateFromPrompt(prompt) {
  if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > MAX_PROMPT_LENGTH) {
    throw Object.assign(new Error(`Prompt must contain 1–${MAX_PROMPT_LENGTH.toLocaleString('en-US')} characters.`), { status: 400 })
  }
  return askGemini(prompt)
}

const pause = ms => new Promise(resolve => setTimeout(resolve, ms))

// Asks each Gemini model in turn until one returns a reply that `validate`
// accepts. Only accepted replies are cached, so a bad reply is never reused.
// `fresh` skips the cached reply (the Regenerate button) and caches the new one.
export async function askGemini(prompt, { validate = null, fresh = false } = {}) {
  const key = runtimeValue('GEMINI_API_KEY')
  if (!key) return unavailable([{ model: null, reason: 'not_configured' }])
  // Checked and free-form replies are cached apart so one never stands in for the other.
  const cacheKey = `${validate ? 'checked' : 'raw'}:${prompt}`
  const cached = responseCache.get(cacheKey)
  const cacheIsCurrent = cached && Date.now() - cached.createdAt < CACHE_TTL_MS
  if (!fresh && cacheIsCurrent) return { ...cached.value, cached: true }
  if (cached && !cacheIsCurrent) responseCache.delete(cacheKey)

  const client = new GoogleGenerativeAI(key)
  const startedAt = Date.now()
  const attempts = []
  let pending = models
  for (let round = 0; round < 2 && pending.length; round += 1) {
    if (round) await pause(RETRY_PAUSE_MS)
    const retry = []
    for (const modelName of pending) {
      const cooldown = cooldowns.get(modelName)
      if (cooldown && cooldown.until > Date.now()) {
        attempts.push({ model: modelName, reason: cooldown.reason, retryAfterMs: cooldown.until - Date.now() })
        continue
      }
      const remaining = TOTAL_BUDGET_MS - (Date.now() - startedAt)
      if (remaining < 3_000) break
      try {
        const model = client.getGenerativeModel({
          model: modelName,
          generationConfig: { temperature: 0.2, responseMimeType: 'application/json' },
        })
        // AbortSignal.timeout rather than the SDK's own timer, which is never cleared.
        const result = await model.generateContent(prompt, { signal: AbortSignal.timeout(Math.min(ATTEMPT_TIMEOUT_MS, remaining)) })
        const text = result.response.text()
        let data = text
        try {
          if (validate) data = validate(text)
        } catch {
          attempts.push({ model: modelName, reason: 'invalid_response' })
          retry.push(modelName)
          continue
        }
        const value = { text, data, model: modelName, generatedAt: new Date().toISOString() }
        if (responseCache.size >= MAX_CACHE_ENTRIES) responseCache.delete(responseCache.keys().next().value)
        responseCache.set(cacheKey, { createdAt: Date.now(), value })
        return value
      } catch (error) {
        const outcome = classifyGeminiError(error)
        // The page shows a plain summary; the logs keep Google's own wording.
        console.warn(`Gemini ${modelName} failed (${outcome.reason}):`, String(error?.message || '').slice(0, 300))
        attempts.push({ model: modelName, reason: outcome.reason, retryAfterMs: outcome.cooldownMs || null })
        if (outcome.cooldownMs) cooldowns.set(modelName, { until: Date.now() + outcome.cooldownMs, reason: outcome.reason })
        if (outcome.stop) return unavailable(attempts)
        if (TRANSIENT_REASONS.has(outcome.reason)) retry.push(modelName)
      }
    }
    pending = retry
  }
  return unavailable(attempts)
}

// Reads the first complete JSON object in a reply. Models sometimes wrap it in
// a code fence or add a stray character after it, which must not discard it.
export function parseJsonObject(text) {
  const source = String(text ?? '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  const asObject = value => (Array.isArray(value) ? value[0] : value)
  try {
    const value = asObject(JSON.parse(source))
    if (value && typeof value === 'object') return value
  } catch { /* fall through to the scan below */ }
  const start = source.indexOf('{')
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = Math.max(start, 0); start >= 0 && index < source.length; index += 1) {
    const char = source[index]
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
    } else if (char === '"') inString = true
    else if (char === '{') depth += 1
    else if (char === '}' && --depth === 0) {
      try { return JSON.parse(source.slice(start, index + 1)) } catch { break }
    }
  }
  throw Object.assign(new Error('The AI response was not valid JSON'), { status: 502 })
}

const toAmount = value => (value === null || value === undefined || value === ''
  ? Number.NaN
  : Number(String(value).replace(/[,\s₱]/g, '')))

function limitInsightWords(text, maxWords = 18) {
  const value = String(text || '').trim()
  const words = value.split(/\s+/)
  if (words.length <= maxWords) return value
  return `${words.slice(0, maxWords).join(' ').replace(/[.,;:!?]+$/, '')}…`
}

// The monthly view asks for whole calendar months, each dated by its first
// day and learned from daily observations. Older pages that still send 30
// daily dates for the monthly view keep getting daily figures.
const MONTH_START = /^\d{4}-\d{2}-01$/
const daysInMonth = date => new Date(Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)), 0)).getUTCDate()
const asksForMonthTotals = (range, forecastDates) => range === 'monthly'
  && forecastDates.every(date => MONTH_START.test(String(date)))

function historyAverages(history) {
  const totals = history.reduce((result, day) => {
    result.revenue += Math.max(0, Number(day?.revenue) || 0)
    result.orders += Math.max(0, Number(day?.orders) || 0)
    return result
  }, { revenue: 0, orders: 0 })
  const days = Math.max(history.length, 1)
  return { revenue: totals.revenue / days, orders: totals.orders / days }
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const DAILY_DATE = /^\d{4}-\d{2}-\d{2}$/
const weekdayOf = date => WEEKDAYS[new Date(`${String(date).slice(0, 10)}T00:00:00Z`).getUTCDay()]
const oneDecimal = value => Math.round(value * 10) / 10

// What a daily or monthly forecast is built from: each weekday's average over
// every recorded week, and how the last two weeks compare with the days
// before. Gemini forecasts from these; left to work them out from a long list
// of days, it tends to repeat the latest week instead.
function weekdayProfile(history) {
  const days = history.filter(day => DAILY_DATE.test(String(day?.date || '')))
  if (days.length < 7) return null
  const sums = Object.fromEntries(WEEKDAYS.map(name => [name, { days: 0, orders: 0, revenue: 0 }]))
  for (const day of days) {
    const entry = sums[weekdayOf(day.date)]
    entry.days += 1
    entry.orders += Math.max(0, Number(day.orders) || 0)
    entry.revenue += Math.max(0, Number(day.revenue) || 0)
  }
  const weekdays = Object.fromEntries(WEEKDAYS.filter(name => sums[name].days).map(name => [name, {
    recordedDays: sums[name].days,
    averageOrders: oneDecimal(sums[name].orders / sums[name].days),
    averageRevenue: Math.round(sums[name].revenue / sums[name].days),
  }]))
  let trend = null
  if (days.length >= 21) {
    const recent = historyAverages(days.slice(-14))
    const earlier = historyAverages(days.slice(0, -14))
    const change = (now, before) => (before > 0 ? Math.round((now / before - 1) * 100) : null)
    trend = {
      recentDays: 14,
      earlierDays: days.length - 14,
      recentAverageOrders: oneDecimal(recent.orders),
      recentAverageRevenue: Math.round(recent.revenue),
      ordersChangePercent: change(recent.orders, earlier.orders),
      revenueChangePercent: change(recent.revenue, earlier.revenue),
    }
  }
  return { weekdays, trend }
}

// How many of each weekday a calendar month (dated by its first day) holds.
function weekdaysInMonth(monthStart) {
  const counts = Object.fromEntries(WEEKDAYS.map(name => [name, 0]))
  for (let day = 1; day <= daysInMonth(monthStart); day += 1) {
    counts[weekdayOf(`${monthStart.slice(0, 8)}${String(day).padStart(2, '0')}`)] += 1
  }
  return counts
}

// A reply that repeats recorded days (the latest week moved forward) is not a
// forecast. Revenue matching recent days to the peso gives it away.
function repeatsRecordedDays(items, history) {
  const recent = new Set(history.slice(-14).map(day => Math.round(Number(day?.revenue) || 0)).filter(value => value > 0))
  const repeated = items.filter(item => recent.has(Math.round(toAmount(item?.predictedRevenue)))).length
  return items.length >= 3 && repeated >= Math.max(3, Math.ceil(items.length / 2))
}

function localForecast(history, forecastDates, monthTotals = false) {
  const average = historyAverages(history)
  return forecastDates.map(date => {
    const daysCovered = monthTotals ? daysInMonth(date) : 1
    return {
      date,
      predictedRevenue: Math.round(average.revenue * daysCovered),
      predictedOrders: Math.round(average.orders * daysCovered),
      confidence: 'low',
    }
  })
}

// Objective 3 asks for recommendations on these areas, so every decision-
// support result has exactly one recommendation for each, in this order.
export const DECISION_AREAS = ['service_demand', 'staffing', 'inventory', 'branch_performance']
const AREA_ALIASES = {
  service: 'service_demand', services: 'service_demand', service_demand: 'service_demand', high_performing_service: 'service_demand',
  staff: 'staffing', staffing: 'staffing', staff_coverage: 'staffing',
  inventory: 'inventory', inventory_usage: 'inventory', stock: 'inventory',
  branch: 'branch_performance', branches: 'branch_performance', branch_performance: 'branch_performance',
}
const decisionArea = value => AREA_ALIASES[String(value || '').trim().toLowerCase().replace(/[\s-]+/g, '_')] || null

function localDecisionSupport(metrics, forecastData) {
  const signals = (metrics?.operationalSignals || []).map(String)
  const averageForecastOrders = forecastData.length
    ? Math.round(forecastData.reduce((sum, item) => sum + (Number(item?.predictedOrders) || 0), 0) / forecastData.length)
    : 0
  const topService = signals.find(signal => /^Service /.test(signal))
  const peak = signals.find(signal => /^Forecast peak|^No distinct peak/i.test(signal))
  const lowStock = signals.find(signal => /^Low stock:/i.test(signal))
  const topBranch = signals.find(signal => /^Branch /.test(signal))
  const insights = [
    {
      title: 'Service demand',
      description: topService ? `Top service by sales: ${topService.replace(/^Service /, '')}` : 'No service sales were recorded in this scope.',
      recommendation: topService ? 'Option: Keep supplies and machines ready for this service on busy days.' : 'Option: Review service demand again after more orders.',
    },
    {
      title: 'Staff coverage',
      description: peak || (averageForecastOrders ? `Local estimate: about ${averageForecastOrders} orders per forecast period.` : 'Not enough recorded orders to estimate workload.'),
      recommendation: 'Option: Check the live queue before adjusting staff coverage.',
    },
    {
      title: 'Inventory usage',
      description: lowStock ? `Stock alert: ${lowStock.replace(/^Low stock:\s*/i, '')}` : 'No item is at or below its minimum stock.',
      recommendation: lowStock ? 'Option: Verify the shelf count, then consider a restock.' : 'Option: Keep routine stock checks before busy periods.',
    },
    {
      title: 'Branch performance',
      description: topBranch ? `Highest collections: ${topBranch.replace(/^Branch /, '')}` : 'No branch comparison is available for this scope.',
      recommendation: topBranch ? 'Option: Compare branch results before moving staff or supplies.' : 'Option: Review branch results after more records.',
    },
  ]
  return insights.map((insight, index) => ({
    area: DECISION_AREAS[index],
    title: limitInsightWords(insight.title, 4),
    description: limitInsightWords(insight.description, 18),
    recommendation: limitInsightWords(insight.recommendation),
  }))
}

function logGeminiFallback(feature, reasonMessage) {
  // Do not log request prompts, API keys, or customer data.
  console.warn(`Gemini ${feature} unavailable; returning a local fallback.`, reasonMessage || 'No usable provider response')
}

async function askGeminiSafely(prompt, validate, fresh = false) {
  try {
    return await askGemini(prompt, { validate, fresh: Boolean(fresh) })
  } catch {
    return unavailable([{ model: null, reason: 'error' }])
  }
}

function baselineForecast(history, forecastDates, { reason, reasonMessage, retryAfterMs = null }, monthTotals = false) {
  return {
    predictions: localForecast(history, forecastDates, monthTotals),
    insights: [{ title: 'Local trend baseline', description: `${reasonMessage} This forecast uses the average of the recorded data and should be treated as low confidence.` }],
    method: 'Local trend baseline · low confidence',
    model: 'Local fallback',
    source: 'baseline',
    isFallback: true,
    reason,
    reasonMessage,
    retryAfterMs,
  }
}

// Accepts a reply only when it has a numeric prediction for every forecast
// date. Dates are matched by value, or by position when the model rewrote them.
function forecastPredictions(parsed, forecastDates) {
  const items = Array.isArray(parsed?.predictions) ? parsed.predictions : []
  const byDate = new Map(items.map(item => [String(item?.date || '').slice(0, 10), item]))
  const aligned = forecastDates.every(date => byDate.has(date))
    ? forecastDates.map(date => byDate.get(date))
    : items.length === forecastDates.length ? items : null
  const usable = aligned?.every(item => Number.isFinite(toAmount(item?.predictedRevenue)) && Number.isFinite(toAmount(item?.predictedOrders)))
  if (!usable) throw new Error('Incomplete forecast')
  return { parsed, items: aligned }
}

// Accepts a reply only when it holds one complete recommendation for every
// decision area. A reply that names its areas is matched by area; one that
// names none is read in the requested order.
function decisionSupportInsights(parsed) {
  const usable = (Array.isArray(parsed?.insights) ? parsed.insights : [])
    .filter(item => ['title', 'description', 'recommendation'].every(field => typeof item?.[field] === 'string' && item[field].trim()))
  const named = usable.some(item => item.area)
  const byArea = new Map(usable.map(item => [decisionArea(item.area), item]))
  const insights = named
    ? (DECISION_AREAS.every(area => byArea.has(area)) ? DECISION_AREAS.map(area => byArea.get(area)) : null)
    : (usable.length === DECISION_AREAS.length ? usable : null)
  if (!insights) throw new Error('Incomplete decision support')
  return insights.map((item, index) => ({ ...item, area: DECISION_AREAS[index] }))
}

export async function generateForecast({ history, forecastDates, branch, range, refresh = false }) {
  if (!Array.isArray(forecastDates) || !forecastDates.length) {
    throw Object.assign(new Error('Forecast dates are required'), { status: 400 })
  }
  history = Array.isArray(history) ? history : []
  // Days before the first order or payment are not part of the shop's record:
  // counting them as zero-order days would drag every average down.
  const firstRecorded = history.findIndex(day => (Number(day?.orders) || 0) > 0 || (Number(day?.revenue) || 0) > 0)
  if (firstRecorded > 0) history = history.slice(firstRecorded)
  const monthTotals = asksForMonthTotals(range, forecastDates)
  // A month forecast reaches further ahead than a day forecast, so it needs
  // more recorded days before its confidence may rise.
  const [mediumAt, highAt] = monthTotals ? [90, 365] : [28, 90]

  // A newly opened branch or a narrow date filter may legitimately contain no
  // orders. There is nothing for Gemini to learn from, so say so plainly.
  if (!history.length || !history.some(day => (Number(day?.orders) || 0) > 0 || (Number(day?.revenue) || 0) > 0)) {
    return baselineForecast(history, forecastDates, {
      reason: 'no_data',
      reasonMessage: 'No orders or payments were recorded in this period, so there was nothing to send to Gemini.',
    }, monthTotals)
  }

  const dailyAverage = historyAverages(history)
  const monthInstructions = monthTotals
    ? `
Each forecast date is the first day of a calendar month. Predict the TOTAL revenue and TOTAL orders for that whole month (about the daily level times the days in the month), not a single day.
Recorded daily averages: ${JSON.stringify({ revenue: Math.round(dailyAverage.revenue), orders: Math.round(dailyAverage.orders * 10) / 10 })}
Days in each forecast month: ${JSON.stringify(Object.fromEntries(forecastDates.map(date => [date, daysInMonth(date)])))}`
    : ''
  // A month total far below the recorded daily pace means the model answered
  // per day; such a reply is retried like any other unusable one.
  const validMonthTotals = items => !monthTotals || items.every((item, index) =>
    toAmount(item.predictedOrders) >= (dailyAverage.orders * daysInMonth(forecastDates[index])) / 4)

  // Daily and monthly forecasts learn from daily observations: the system
  // summarises them by weekday and trend, and Gemini forecasts from that.
  const profile = range !== 'yearly' ? weekdayProfile(history) : null
  const patternInstructions = profile
    ? `
Weekday averages over all recorded weeks (per day): ${JSON.stringify(profile.weekdays)}
Recent trend: ${profile.trend ? JSON.stringify(profile.trend) : 'fewer than 21 recorded days, so no trend is given'}
${monthTotals
    ? `Weekdays in each forecast month: ${JSON.stringify(Object.fromEntries(forecastDates.map(date => [date, weekdaysInMonth(date)])))}`
    : `Weekday of each forecast date: ${JSON.stringify(Object.fromEntries(forecastDates.map(date => [date, weekdayOf(date)])))}`}`
    : ''
  const patternRules = profile
    ? `
- Forecast from the whole history: ${monthTotals
    ? 'for each month, add up the weekday averages for every day of that month'
    : 'start each date from the average of its weekday'}, then apply the recent trend, giving recent weeks somewhat more weight than older ones.
- Never copy a single past day's revenue or orders; every figure is an estimate from the whole history.`
    : ''

  const response = await askGeminiSafely(`You are assisting a laundry business manager with a revenue-and-demand forecast.
Use only the supplied dated historical totals and the summaries computed from them. Weekly and monthly selections use daily observations; yearly selections use yearly observations. Do not invent events, customers, or operational facts.

Branch scope: ${branch || 'All branches'}
Report range: ${range}
Currency: Philippine pesos (PHP / ₱). Every revenue amount is in PHP, never US dollars.
Historical observations: ${JSON.stringify(history)}${patternInstructions}
Forecast dates: ${JSON.stringify(forecastDates)}${monthInstructions}

Return ONLY valid JSON in exactly this shape:
{"predictions":[{"date":"YYYY-MM-DD","predictedRevenue":0,"predictedOrders":0,"confidence":"low|medium|high"}],"insights":[{"title":"...","description":"..."}],"method":"short description"}

Rules:
- Include exactly one prediction for every forecast date given.
- predictedRevenue and predictedOrders must be non-negative numbers.
- predictedRevenue is a Philippine-peso (PHP) amount.
- Make conservative forecasts when history is sparse.${patternRules}
- Use low confidence with fewer than ${mediumAt} historical observations, medium with ${mediumAt}–${highAt - 1}, and high only with at least ${highAt} observations and a consistent pattern. The server will enforce this ceiling.
- Provide 2 or 3 practical recommendations covering peak demand, staffing, inventory, service demand, or branch performance when supported by the data.
- Do not use markdown.`, text => {
    const result = forecastPredictions(parseJsonObject(text), forecastDates)
    if (!validMonthTotals(result.items)) throw new Error('Daily figures were returned for a monthly forecast')
    if (!monthTotals && profile && repeatsRecordedDays(result.items, history)) throw new Error('The forecast repeats recorded days')
    return result
  }, refresh)

  if (!response.data) {
    logGeminiFallback('forecasting', response.reasonMessage)
    return baselineForecast(history, forecastDates, response, monthTotals)
  }
  const { parsed, items } = response.data
  const historicalOrderCounts = history.map(day => Math.max(0, Number(day?.orders) || 0))
  const meanHistoricalOrders = historicalOrderCounts.length
    ? historicalOrderCounts.reduce((sum, count) => sum + count, 0) / historicalOrderCounts.length
    : 0
  const orderVariance = meanHistoricalOrders > 0
    ? historicalOrderCounts.reduce((sum, count) => sum + ((count - meanHistoricalOrders) ** 2), 0) / historicalOrderCounts.length
    : Number.POSITIVE_INFINITY
  const orderVariation = meanHistoricalOrders > 0 ? Math.sqrt(orderVariance) / meanHistoricalOrders : Number.POSITIVE_INFINITY
  const stableOrderPattern = orderVariation <= 0.75
  const predictions = forecastDates.map((date, index) => {
    const item = items[index]
    const modelConfidence = ['low', 'medium', 'high'].includes(item.confidence) ? item.confidence : 'low'
    const confidenceCeiling = history.length >= highAt && stableOrderPattern ? 'high' : history.length >= mediumAt ? 'medium' : 'low'
    const confidenceRank = { low: 0, medium: 1, high: 2 }
    return {
      date,
      predictedRevenue: Math.max(0, Math.round(toAmount(item.predictedRevenue))),
      predictedOrders: Math.max(0, Math.round(toAmount(item.predictedOrders))),
      confidence: confidenceRank[modelConfidence] <= confidenceRank[confidenceCeiling] ? modelConfidence : confidenceCeiling,
    }
  })

  return {
    predictions,
    insights: Array.isArray(parsed.insights) ? parsed.insights.slice(0, 3) : [],
    // Do not render free-form model prose in the dashboard header.
    method: `Gemini-assisted forecast (${response.model})`,
    model: response.model,
    source: 'gemini',
    generatedAt: response.generatedAt,
    cached: Boolean(response.cached),
  }
}

// Administrators forecast any scope. A staff account may forecast only its
// own branch: the records it can read are already limited to that branch,
// and the forecast is always labelled with it, whatever the page sent.
export function generateForecastForAccount(input, identity) {
  if (identity?.role === 'admin') return generateForecast(input || {})
  if (identity?.role === 'staff' && identity.branch) return generateForecast({ ...(input || {}), branch: identity.branch })
  throw Object.assign(new Error('Only administrators and branch staff can use forecasts.'), { status: 403 })
}

export async function generateDecisionSupport({ metrics, trendData, forecastData, branch, range, refresh = false }) {
  const safeMetrics = {
    totalRevenue: Number(metrics?.totalRevenue) || 0,
    totalExpenses: Number(metrics?.totalExpenses) || 0,
    profit: Number(metrics?.profit) || 0,
    totalOrders: Number(metrics?.totalOrders) || 0,
    averageOrderValue: Number(metrics?.averageOrderValue) || 0,
    operationalSignals: Array.isArray(metrics?.operationalSignals) ? metrics.operationalSignals.slice(0, 30).map(signal => String(signal).slice(0, 240)) : [],
  }
  const safeTrendData = Array.isArray(trendData) ? trendData.slice(-60) : []
  const safeForecastData = Array.isArray(forecastData) ? forecastData.slice(0, 30) : []

  const response = await askGeminiSafely(`You are an AI-assisted decision-support system for a multi-branch laundry business.
Analyze only the supplied metrics, trend data, and forecast. Do not invent facts.

Branch scope: ${branch || 'All branches'}
Report range: ${range}
Currency: Philippine pesos (PHP / ₱). Every monetary metric and recommendation must use PHP, never US dollars.
Metrics: ${JSON.stringify(safeMetrics)}
Trend data: ${JSON.stringify(safeTrendData)}
Forecast: ${JSON.stringify(safeForecastData)}

Return ONLY valid JSON in this exact format:
{"insights":[{"area":"service_demand","title":"short title","description":"brief data signal","recommendation":"brief optional action"}]}

Rules:
- Return exactly 4 insights, one for each area, in this order: "service_demand", "staffing", "inventory", "branch_performance". Set "area" to that name.
- service_demand: name the high-performing service from the service signals and what its demand suggests.
- staffing: use the workload, staff, turnaround and forecast signals, including any forecast peak, to suggest staff coverage.
- inventory: use the low-stock signals to suggest restocking or careful use of supplies.
- branch_performance: compare the branch signals (for one branch, its own results) and suggest an improvement.
- When the signals hold no evidence for an area, say so in the description and recommend keeping the current practice with a quick check of live records.
- Keep titles to 2–4 words. Keep descriptions and recommendations to 18 words maximum.
- Recommendations should be practical, optional next steps; include a quick verification when needed.
- In descriptions, state the supplied evidence and uncertainty; never invent causes or facts.
- Avoid generic advice and markdown.`, text => decisionSupportInsights(parseJsonObject(text)), refresh)

  if (!response.data) {
    logGeminiFallback('decision support', response.reasonMessage)
    return {
      insights: localDecisionSupport(safeMetrics, safeForecastData),
      model: 'Local fallback',
      source: 'baseline',
      isFallback: true,
      reason: response.reason,
      reasonMessage: response.reasonMessage,
      retryAfterMs: response.retryAfterMs,
    }
  }
  const insights = response.data
  const conciseInsights = insights.map(item => ({
    area: item.area,
    title: limitInsightWords(item.title, 4),
    description: limitInsightWords(item.description),
    recommendation: limitInsightWords(item.recommendation),
  }))
  return { insights: conciseInsights, model: response.model, source: 'gemini', generatedAt: response.generatedAt, cached: Boolean(response.cached) }
}
