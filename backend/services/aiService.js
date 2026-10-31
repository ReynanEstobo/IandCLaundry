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

const REASON_PRIORITY = ['not_configured', 'key_rejected', 'quota', 'busy', 'timeout', 'network', 'invalid_response', 'model_unavailable', 'error']
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

function localForecast(history, forecastDates) {
  const totals = history.reduce((result, day) => {
    result.revenue += Math.max(0, Number(day?.revenue) || 0)
    result.orders += Math.max(0, Number(day?.orders) || 0)
    return result
  }, { revenue: 0, orders: 0 })
  const days = Math.max(history.length, 1)
  const averageRevenue = Math.round(totals.revenue / days)
  const averageOrders = Math.round(totals.orders / days)

  return forecastDates.map(date => ({
    date,
    predictedRevenue: averageRevenue,
    predictedOrders: averageOrders,
    confidence: 'low',
  }))
}

function localDecisionSupport(metrics, forecastData) {
  const totalRevenue = Number(metrics?.totalRevenue) || 0
  const totalExpenses = Number(metrics?.totalExpenses) || 0
  const profit = Number(metrics?.profit) || 0
  const totalOrders = Number(metrics?.totalOrders) || 0
  const averageForecastRevenue = forecastData.length
    ? Math.round(forecastData.reduce((sum, item) => sum + (Number(item?.predictedRevenue ?? item?.predicted) || 0), 0) / forecastData.length)
    : 0
  const averageForecastOrders = forecastData.length
    ? Math.round(forecastData.reduce((sum, item) => sum + (Number(item?.predictedOrders) || 0), 0) / forecastData.length)
    : 0
  const lowStock = (metrics?.operationalSignals || []).find(signal => /low[- ]stock/i.test(String(signal)))
  const shortDescriptions = [
    `PHP ${totalRevenue.toLocaleString()} collected across ${totalOrders} orders; PHP ${totalExpenses.toLocaleString()} expenses; net ${profit >= 0 ? 'profit' : 'loss'} PHP ${Math.abs(profit).toLocaleString()}.`,
    averageForecastRevenue || averageForecastOrders
      ? `Baseline: ${averageForecastOrders} orders and PHP ${averageForecastRevenue.toLocaleString()} per period.`
      : 'No orders recorded; forecast confidence is low.',
    lowStock ? `Stock alert: ${lowStock}` : 'No low-stock alert in this snapshot.',
  ]

  const insights = [
    {
      title: 'Financial snapshot',
      description: `The selected scope has received ₱${totalRevenue.toLocaleString()} from ${totalOrders} orders, with ₱${totalExpenses.toLocaleString()} in recorded expenses and a net ${profit >= 0 ? 'profit' : 'loss'} of ₱${Math.abs(profit).toLocaleString()}.`,
    },
    {
      title: 'Demand baseline',
      description: averageForecastRevenue || averageForecastOrders
        ? `Local low-confidence baseline: about ${averageForecastOrders} orders and PHP ${averageForecastRevenue.toLocaleString()} received per forecast period.`
        : 'There is not enough recorded demand data for a reliable forecast in this selected period.',
    },
    {
      title: 'Operational follow-up',
      description: lowStock
        ? `Reported inventory signal: ${lowStock}`
        : 'No specific low-stock item was included in the supplied operational signals. The local analysis is conservative while Gemini is unavailable.',
    },
  ]
  const recommendations = [
    'Option: Compare collections with expenses before changing prices or spending.',
    averageForecastRevenue || averageForecastOrders
      ? 'Option: Check the live queue before adjusting staff coverage.'
      : 'Option: Keep the staffing plan and use the live queue.',
    lowStock
      ? 'Option: Verify the shelf count, then consider a restock request.'
      : 'Option: Check inventory before the next busy period.',
  ]
  return insights.map((insight, index) => ({
    title: limitInsightWords(insight.title, 4),
    description: limitInsightWords(shortDescriptions[index] || insight.description, 16),
    recommendation: limitInsightWords(recommendations[index]),
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

function baselineForecast(history, forecastDates, { reason, reasonMessage, retryAfterMs = null }) {
  return {
    predictions: localForecast(history, forecastDates),
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

function decisionSupportInsights(parsed) {
  const insights = (Array.isArray(parsed?.insights) ? parsed.insights : [])
    .filter(item => typeof item?.title === 'string'
      && typeof item?.description === 'string'
      && typeof item?.recommendation === 'string'
      && item.recommendation.trim().length > 0)
    .slice(0, 3)
  if (insights.length !== 3) throw new Error('Incomplete decision support')
  return insights
}

export async function generateForecast({ history, forecastDates, branch, range, refresh = false }) {
  if (!Array.isArray(forecastDates) || !forecastDates.length) {
    throw Object.assign(new Error('Forecast dates are required'), { status: 400 })
  }
  history = Array.isArray(history) ? history : []

  // A newly opened branch or a narrow date filter may legitimately contain no
  // orders. There is nothing for Gemini to learn from, so say so plainly.
  if (!history.length || !history.some(day => (Number(day?.orders) || 0) > 0 || (Number(day?.revenue) || 0) > 0)) {
    return baselineForecast(history, forecastDates, {
      reason: 'no_data',
      reasonMessage: 'No orders or payments were recorded in this period, so there was nothing to send to Gemini.',
    })
  }

  const response = await askGeminiSafely(`You are assisting a laundry business manager with a revenue-and-demand forecast.
Use only the supplied dated historical totals. Weekly and monthly selections use daily observations; yearly selections use yearly observations. Do not invent events, customers, or operational facts.

Branch scope: ${branch || 'All branches'}
Report range: ${range}
Currency: Philippine pesos (PHP / ₱). Every revenue amount is in PHP, never US dollars.
Historical observations: ${JSON.stringify(history)}
Forecast dates: ${JSON.stringify(forecastDates)}

Return ONLY valid JSON in exactly this shape:
{"predictions":[{"date":"YYYY-MM-DD","predictedRevenue":0,"predictedOrders":0,"confidence":"low|medium|high"}],"insights":[{"title":"...","description":"..."}],"method":"short description"}

Rules:
- Include exactly one prediction for every forecast date given.
- predictedRevenue and predictedOrders must be non-negative numbers.
- predictedRevenue is a Philippine-peso (PHP) amount.
- Make conservative forecasts when history is sparse.
- Use low confidence with fewer than 28 historical observations, medium with 28–89, and high only with at least 90 observations and a consistent pattern. The server will enforce this ceiling.
- Provide 2 or 3 practical recommendations covering peak demand, staffing, inventory, service demand, or branch performance when supported by the data.
- Do not use markdown.`, text => forecastPredictions(parseJsonObject(text), forecastDates), refresh)

  if (!response.data) {
    logGeminiFallback('forecasting', response.reasonMessage)
    return baselineForecast(history, forecastDates, response)
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
    const confidenceCeiling = history.length >= 90 && stableOrderPattern ? 'high' : history.length >= 28 ? 'medium' : 'low'
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

export async function generateDecisionSupport({ metrics, trendData, forecastData, branch, range, refresh = false }) {
  const safeMetrics = {
    totalRevenue: Number(metrics?.totalRevenue) || 0,
    totalExpenses: Number(metrics?.totalExpenses) || 0,
    profit: Number(metrics?.profit) || 0,
    totalOrders: Number(metrics?.totalOrders) || 0,
    averageOrderValue: Number(metrics?.averageOrderValue) || 0,
    operationalSignals: Array.isArray(metrics?.operationalSignals) ? metrics.operationalSignals.slice(0, 12) : [],
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
{"insights":[{"title":"short title","description":"brief data signal","recommendation":"brief optional action"}]}

Rules:
- Return exactly 3 insights.
- Cover financial performance, service demand, and operations (staffing, inventory, or branch productivity when supported by signals).
- Keep titles to 2–4 words. Keep descriptions and recommendations to 18 words maximum.
- Recommendations should be practical, optional next steps; include a quick verification when needed.
- In descriptions, state the supplied evidence and uncertainty; never invent causes or facts.
- When data is limited, recommend maintaining the current plan and checking live records rather than acting on a weak forecast.
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
    title: limitInsightWords(item.title, 4),
    description: limitInsightWords(item.description),
    recommendation: limitInsightWords(item.recommendation),
  }))
  return { insights: conciseInsights, model: response.model, source: 'gemini', generatedAt: response.generatedAt, cached: Boolean(response.cached) }
}
