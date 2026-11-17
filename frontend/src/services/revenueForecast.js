import { format, getDaysInMonth, parseISO } from 'date-fns'
import { generateAiForecast } from './geminiService.js'
import { analyticsDailyHistory, fromFirstRecordedDay } from '../utils/analyticsMetrics.js'
import { analyticsPeriod, forecastLabels, forecastPeriods } from '../utils/chartDates.js'
import { recordedPaymentAmount } from '../utils/businessForecast.js'
import {
  aiCacheKey, aiServiceErrorReason, dataFingerprint, lastGeminiResult,
  readAiCache, reusableAiCache, sharedAiRequest, writeAiCache,
} from '../utils/aiOutputCache.js'

// One revenue-and-demand forecast, shared by Analytics and both dashboards.
// The same records, the same Gemini request and the same browser cache entry
// mean every page shows the same figures for the same branch scope.

// What the forecast learns from: daily totals from the first recorded day
// (the last 365), or yearly totals in the yearly view. Today is still being
// recorded and is one of the forecast dates, so a daily history ends yesterday.
export function forecastHistory(orders, payments, period, grouping, now = new Date()) {
  const daily = fromFirstRecordedDay(analyticsDailyHistory(orders, payments, period.start, period.end))
  const today = format(now, 'yyyy-MM-dd')
  if (grouping !== 'yearly') return daily.filter(day => day.date < today).slice(-365)
  return [...daily.reduce((years, day) => {
    const year = day.date.slice(0, 4)
    const total = years.get(year) || { date: `${year}-01-01`, revenue: 0, orders: 0 }
    total.revenue += day.revenue
    total.orders += day.orders
    years.set(year, total)
    return years
  }, new Map()).values()]
}

// A simple local estimate, shown only when the AI service cannot be reached.
// A monthly point is a whole-month total built from the daily average.
export function localTrendForecast(history, grouping, now = new Date()) {
  const average = key => (history.length ? history.reduce((sum, day) => sum + day[key], 0) / history.length : 0)
  const averageRevenue = average('revenue')
  const averageOrders = average('orders')
  const growthRate = grouping === 'weekly' ? 0.01 : grouping === 'monthly' ? 0.025 : 0.08
  return forecastPeriods(grouping, now).map((period, i) => {
    const daysCovered = grouping === 'monthly' ? getDaysInMonth(parseISO(period.forecastDate)) : 1
    return {
      ...period,
      predicted: Math.round(averageRevenue * daysCovered * (1 + i * growthRate)),
      predictedOrders: Math.max(0, Math.round(averageOrders * daysCovered * (1 + i * growthRate))),
      confidence: 'low',
      isPrediction: true,
    }
  })
}

function toChartForecast(predictions, grouping) {
  return predictions.map(prediction => ({
    ...forecastLabels(grouping, prediction.date),
    forecastDate: prediction.date,
    predicted: prediction.predictedRevenue,
    predictedOrders: prediction.predictedOrders,
    confidence: prediction.confidence,
    isPrediction: true,
  }))
}

/**
 * Returns { data, model, meta, outcome }: the chart points, the method label,
 * where the result came from (for AiSourceNote) and how a Regenerate went.
 * A cached Gemini result for the same scope is reused instead of asking again.
 */
export async function loadRevenueForecast({ orders, payments, period, grouping, branch = 'all', customRange = {}, forceRefresh = false }) {
  const history = forecastHistory(orders, payments, period, grouping)
  const localForecast = localTrendForecast(history, grouping)
  const forecastDates = localForecast.map(item => item.forecastDate)
  const cacheKey = aiCacheKey('forecast', [branch, grouping, customRange?.start, customRange?.end])
  const dataVersion = dataFingerprint(history)
  const cachedEntry = readAiCache(cacheKey)
  // A forecast made on another day covers other dates, so it is not reused.
  const sameDatesEntry = cachedEntry?.forecastDates === forecastDates.join('|') ? cachedEntry : null

  const fromGemini = (entry, { isCached, reason = '' }) => ({
    data: entry.data,
    model: `Gemini-assisted forecast (${entry.model})`,
    meta: { source: 'gemini', model: entry.model, savedAt: entry.savedAt, isCached, staleData: entry.dataVersion !== dataVersion, reason },
    outcome: { source: isCached && reason ? 'earlier' : 'gemini', reason },
  })

  const reusable = !forceRefresh && reusableAiCache(sameDatesEntry, dataVersion)
  if (reusable) return fromGemini(reusable, { isCached: true })

  let aiForecast
  try {
    aiForecast = await sharedAiRequest(
      `${cacheKey}|${dataVersion}|${forecastDates.join('|')}|${forceRefresh}`,
      () => generateAiForecast({ history, forecastDates, branch, range: grouping, refresh: forceRefresh }),
    )
  } catch (aiError) {
    console.warn('Forecast service failed; using the local trend baseline.', aiError.message)
    aiForecast = { source: 'baseline', reasonMessage: aiServiceErrorReason(aiError) }
  }

  if (aiForecast.source === 'gemini' && Array.isArray(aiForecast.predictions)) {
    const entry = {
      data: toChartForecast(aiForecast.predictions, grouping),
      model: aiForecast.model,
      savedAt: Date.parse(aiForecast.generatedAt) || Date.now(),
      dataVersion,
      forecastDates: forecastDates.join('|'),
    }
    writeAiCache(cacheKey, entry)
    return fromGemini(entry, { isCached: Boolean(aiForecast.cached) })
  }

  const reason = aiForecast.reasonMessage || 'Gemini did not return a forecast.'
  const earlier = aiForecast.reason !== 'no_data' && lastGeminiResult(sameDatesEntry)
  if (earlier) return fromGemini(earlier, { isCached: true, reason })

  return {
    data: Array.isArray(aiForecast.predictions) ? toChartForecast(aiForecast.predictions, grouping) : localForecast,
    model: 'Local trend baseline · low confidence',
    meta: { source: 'baseline', model: '', savedAt: null, isCached: false, staleData: false, reason },
    outcome: { source: 'baseline', reason },
  }
}

/**
 * The records a forecast learns from: this year so far, payments by collection
 * date, cancelled orders left out. The Monthly forecast, the dashboards' revenue
 * card and the Weekly forecast all read these, so a Weekly forecast learns from
 * every recorded week, not only the 7 days its chart shows.
 * `branch` is a branch name or 'all'; staff accounts are limited to their own
 * branch by the database, whatever is passed here.
 */
export async function loadForecastRecords(supabase, { branch = 'all' } = {}) {
  const period = analyticsPeriod('monthly')
  const startDate = period.start.toISOString()
  const endDate = period.end.toISOString()
  let orderQuery = supabase.from('orders').select('id, created_at, status, branch')
    .gte('created_at', startDate).lte('created_at', endDate).order('created_at', { ascending: true })
  let paymentQuery = supabase.from('payments').select('amount, paid_at, payment_date, branch, orders!inner(id, status, branch)')
    .gte('paid_at', startDate).lte('paid_at', endDate).order('paid_at', { ascending: true })
  if (branch !== 'all') {
    orderQuery = orderQuery.eq('branch', branch)
    paymentQuery = paymentQuery.eq('branch', branch)
  }
  const [ordersRes, paymentsRes] = await Promise.all([orderQuery, paymentQuery])
  if (ordersRes.error || paymentsRes.error) throw ordersRes.error || paymentsRes.error
  const orders = (ordersRes.data || []).filter(order => order.status !== 'cancelled')
  const payments = (paymentsRes.data || []).filter(payment => payment.orders?.status !== 'cancelled' && recordedPaymentAmount(payment) > 0)
  return { orders, payments, period }
}

/**
 * The dashboards' revenue card: next month's figure from the same Monthly
 * forecast that Analytics shows for this branch scope, from the same records.
 */
export async function loadNextMonthForecast(supabase, { branch = 'all' } = {}) {
  const { orders, payments, period } = await loadForecastRecords(supabase, { branch })
  const result = await loadRevenueForecast({ orders, payments, period, grouping: 'monthly', branch })
  return { ...result, nextMonth: result.data[0] || null }
}
