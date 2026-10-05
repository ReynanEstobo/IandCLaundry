import { GoogleGenerativeAI } from '@google/generative-ai'
import { runtimeValue } from '../config/supabase.js'

// Prefer the stable Flash models. Availability can still vary by Gemini
// project, region, quota, or provider status, so the service has a local
// deterministic fallback instead of failing the Analytics page.
const models = ['gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-3.6-flash']
const cooldowns = new Map()
const responseCache = new Map()
const CACHE_TTL_MS = 6 * 60 * 60 * 1000
const MAX_CACHE_ENTRIES = 100

export async function askGemini(prompt) {
  const key = runtimeValue('GEMINI_API_KEY')
  if (!key) throw Object.assign(new Error('Gemini API key is not configured'), { status: 500 })
  const cached = responseCache.get(prompt)
  if (cached && Date.now() - cached.createdAt < CACHE_TTL_MS) return cached.value
  if (cached) responseCache.delete(prompt)

  const client = new GoogleGenerativeAI(key)
  for (const modelName of models) {
    if (Date.now() - (cooldowns.get(modelName) || 0) < 5000) continue
    try {
      const model = client.getGenerativeModel({
        model: modelName,
        generationConfig: { temperature: 0.2, responseMimeType: 'application/json' },
      })
      const result = await model.generateContent(prompt)
      const value = { text: result.response.text(), model: modelName }
      if (responseCache.size >= MAX_CACHE_ENTRIES) responseCache.delete(responseCache.keys().next().value)
      responseCache.set(prompt, { createdAt: Date.now(), value })
      return value
    } catch (error) {
      const message = error?.message?.toLowerCase() || ''
      if (!/quota|429|rate limit|resource exhausted|not found|unsupported/.test(message)) throw error
      cooldowns.set(modelName, Date.now())
    }
  }
  return { text: null, model: 'Unavailable' }
}

function parseJson(text) {
  const match = text?.match(/\{[\s\S]*\}/)
  if (!match) throw Object.assign(new Error('The AI response was not valid JSON'), { status: 502 })
  try { return JSON.parse(match[0]) } catch { throw Object.assign(new Error('The AI response was not valid JSON'), { status: 502 }) }
}

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

function logGeminiFallback(feature, error) {
  // Do not log request prompts, API keys, or customer data.
  console.warn(`Gemini ${feature} unavailable; returning a local fallback.`, error?.message || 'No usable provider response')
}

export async function generateForecast({ history, forecastDates, branch, range }) {
  if (!Array.isArray(forecastDates) || !forecastDates.length) {
    throw Object.assign(new Error('Forecast dates are required'), { status: 400 })
  }
  history = Array.isArray(history) ? history : []

  // A newly opened branch or a narrow date filter may legitimately contain no
  // orders. It is not an API error: render a zero, low-confidence baseline.
  if (!history.length || !history.some(day => (Number(day?.orders) || 0) > 0 || (Number(day?.revenue) || 0) > 0)) {
    return {
      predictions: localForecast(history, forecastDates),
      insights: [{ title: 'Limited historical data', description: 'There are no recorded orders or payments in this selected period, so the displayed zero-value baseline is not a reliable demand prediction.' }],
      method: 'Local trend baseline · low confidence',
      model: 'Local fallback',
      isFallback: true,
    }
  }

  let response
  try {
    response = await askGemini(`You are assisting a laundry business manager with a revenue-and-demand forecast.
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
- Do not use markdown.`)
  } catch (error) {
    logGeminiFallback('forecasting', error)
  }

  if (!response?.text) {
    return {
      predictions: localForecast(history, forecastDates),
      insights: [{ title: 'Local trend baseline', description: 'Gemini is temporarily unavailable, so this forecast uses the average of the recorded daily data and should be treated as low confidence.' }],
      method: 'Local trend baseline · low confidence',
      model: 'Local fallback',
      isFallback: true,
    }
  }

  let parsed
  try {
    parsed = parseJson(response.text)
  } catch (error) {
    logGeminiFallback('forecast response parsing', error)
    return {
      predictions: localForecast(history, forecastDates),
      insights: [{ title: 'Local trend baseline', description: 'Gemini returned an unusable response, so this forecast uses the average of the recorded daily data and should be treated as low confidence.' }],
      method: 'Local trend baseline · low confidence',
      model: 'Local fallback',
      isFallback: true,
    }
  }
  const byDate = new Map((parsed.predictions || []).map(item => [item.date, item]))
  const isComplete = forecastDates.every(date => {
    const item = byDate.get(date)
    return item && Number.isFinite(Number(item.predictedRevenue)) && Number.isFinite(Number(item.predictedOrders))
  })
  if (!isComplete) {
    logGeminiFallback('forecast response validation')
    return {
      predictions: localForecast(history, forecastDates),
      insights: [{ title: 'Local trend baseline', description: 'Gemini returned an incomplete forecast, so the displayed values use the recorded daily average and should be treated as low confidence.' }],
      method: 'Local trend baseline · low confidence',
      model: 'Local fallback',
      isFallback: true,
    }
  }
  const historicalOrderCounts = history.map(day => Math.max(0, Number(day?.orders) || 0))
  const meanHistoricalOrders = historicalOrderCounts.length
    ? historicalOrderCounts.reduce((sum, count) => sum + count, 0) / historicalOrderCounts.length
    : 0
  const orderVariance = meanHistoricalOrders > 0
    ? historicalOrderCounts.reduce((sum, count) => sum + ((count - meanHistoricalOrders) ** 2), 0) / historicalOrderCounts.length
    : Number.POSITIVE_INFINITY
  const orderVariation = meanHistoricalOrders > 0 ? Math.sqrt(orderVariance) / meanHistoricalOrders : Number.POSITIVE_INFINITY
  const stableOrderPattern = orderVariation <= 0.75
  const predictions = forecastDates.map(date => {
    const item = byDate.get(date)
    const modelConfidence = ['low', 'medium', 'high'].includes(item.confidence) ? item.confidence : 'low'
    const confidenceCeiling = history.length >= 90 && stableOrderPattern ? 'high' : history.length >= 28 ? 'medium' : 'low'
    const confidenceRank = { low: 0, medium: 1, high: 2 }
    return {
      date,
      predictedRevenue: Math.max(0, Math.round(Number(item.predictedRevenue))),
      predictedOrders: Math.max(0, Math.round(Number(item.predictedOrders))),
      confidence: confidenceRank[modelConfidence] <= confidenceRank[confidenceCeiling] ? modelConfidence : confidenceCeiling,
    }
  })

  return {
    predictions,
    insights: Array.isArray(parsed.insights) ? parsed.insights.slice(0, 3) : [],
    // Do not render free-form model prose in the dashboard header.
    method: `Gemini-assisted forecast (${response.model})`,
    model: response.model,
  }
}

export async function generateDecisionSupport({ metrics, trendData, forecastData, branch, range }) {
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

  let response
  try {
    response = await askGemini(`You are an AI-assisted decision-support system for a multi-branch laundry business.
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
- Avoid generic advice and markdown.`)
  } catch (error) {
    logGeminiFallback('decision support', error)
  }

  if (!response?.text) return { insights: localDecisionSupport(safeMetrics, safeForecastData), model: 'Local fallback', isFallback: true }

  let parsed
  try {
    parsed = parseJson(response.text)
  } catch (error) {
    logGeminiFallback('decision-support response parsing', error)
    return { insights: localDecisionSupport(safeMetrics, safeForecastData), model: 'Local fallback', isFallback: true }
  }
  const insights = (parsed.insights || [])
    .filter(item => typeof item?.title === 'string'
      && typeof item?.description === 'string'
      && typeof item?.recommendation === 'string'
      && item.recommendation.trim().length > 0)
    .slice(0, 3)

  if (insights.length !== 3) {
    logGeminiFallback('decision-support response validation')
    return { insights: localDecisionSupport(safeMetrics, safeForecastData), model: 'Local fallback', isFallback: true }
  }
  const conciseInsights = insights.map(item => ({
    title: limitInsightWords(item.title, 4),
    description: limitInsightWords(item.description),
    recommendation: limitInsightWords(item.recommendation),
  }))
  return { insights: conciseInsights, model: response.model }
}
