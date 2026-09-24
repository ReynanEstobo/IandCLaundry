import { startOfDay, subDays } from 'date-fns'

/**
 * Revenue used everywhere in reporting: cash recorded against an active order.
 * A legacy fully-paid order without amount_paid uses its order total instead.
 */
export function recordedRevenue(order) {
  if (order?.amount_paid !== null && order?.amount_paid !== undefined && order?.amount_paid !== '') {
    const recorded = Number(order.amount_paid)
    if (Number.isFinite(recorded)) return Math.max(0, recorded)
  }
  return order?.payment_status === 'paid' ? Math.max(0, Number(order?.total_price) || 0) : 0
}

export function reportableOrders(orders = []) {
  return orders.filter(order => order?.status !== 'cancelled' && order?.created_at && !Number.isNaN(+new Date(order.created_at)))
}

export function paymentTimestamp(payment) {
  return payment?.paid_at || payment?.payment_date || payment?.created_at || null
}

export function recordedPaymentAmount(payment) {
  const amount = Number(payment?.amount)
  return Number.isFinite(amount) && amount > 0 && !payment?.voided_at ? amount : 0
}

/**
 * Today's demand uses the previous 30 completed days, excluding today's
 * partial activity. Revenue keeps its rolling window through now so it
 * continues to use the same received-revenue definition as Analytics.
 */
export function rollingDemandForecast(orders = [], paymentsOrNow = [], suppliedNow = new Date()) {
  const payments = Array.isArray(paymentsOrNow) ? paymentsOrNow : []
  const now = Array.isArray(paymentsOrNow) ? suppliedNow : paymentsOrNow
  const today = startOfDay(now)
  const validOrders = reportableOrders(orders)
  const windowStart = subDays(today, 29)
  const revenueOrderHistory = validOrders.filter(order => new Date(order.created_at) >= windowStart && new Date(order.created_at) <= now)
  const historyDays = 30
  const demandWindowStart = subDays(today, historyDays)
  const history = validOrders.filter(order => new Date(order.created_at) >= demandWindowStart && new Date(order.created_at) < today)
  const todayOrderCount = validOrders.filter(order => new Date(order.created_at) >= today && new Date(order.created_at) <= now).length
  const paymentHistory = payments.filter(payment => {
    const paidAt = paymentTimestamp(payment)
    return paidAt && new Date(paidAt) >= windowStart && new Date(paidAt) <= now
  })
  const totalRevenue = paymentHistory.length
    ? paymentHistory.reduce((sum, payment) => sum + recordedPaymentAmount(payment), 0)
    : revenueOrderHistory.reduce((sum, order) => sum + recordedRevenue(order), 0)
  const averageDailyOrders = history.length / historyDays

  const todayDay = today.getDay()
  const matchingDays = Array.from({ length: historyDays }, (_, index) => subDays(today, index + 1))
    .filter(day => day.getDay() === todayDay).length
  // Blend the weekday pattern with the overall daily average. This avoids
  // dramatic-looking forecasts when a small data set happens to have one or
  // two orders on the same weekday.
  const weekdayOrders = history.filter(order => new Date(order.created_at).getDay() === todayDay).length
  const smoothingDays = 2
  const expectedTodayOrders = (weekdayOrders + (averageDailyOrders * smoothingDays)) / (matchingDays + smoothingDays)
  const workloadPct = averageDailyOrders > 0
    ? Math.round((expectedTodayOrders / averageDailyOrders) * 100)
    : 0
  const workloadLevel = history.length < 7 ? 'Limited data'
    : workloadPct >= 125 ? 'Busier than usual'
      : workloadPct >= 75 ? 'Usual workload'
        : 'Lighter than usual'
  const expectedOrderCount = Math.max(0, Math.round(expectedTodayOrders))
  const usualOrderCount = Math.max(0, Math.round(averageDailyOrders))
  const expectedOrdersText = expectedTodayOrders > 0 && expectedTodayOrders < 1
    ? 'Less than 1 order'
    : `About ${expectedOrderCount} ${expectedOrderCount === 1 ? 'order' : 'orders'}`
  const usualOrdersText = averageDailyOrders > 0 && averageDailyOrders < 1
    ? 'less than 1 order'
    : `${usualOrderCount} ${usualOrderCount === 1 ? 'order' : 'orders'}`
  const workloadSummary = history.length < 7
    ? `Not enough history to estimate today's workload; ${todayOrderCount} received so far today`
    : `${expectedOrdersText} expected today; ${todayOrderCount} received so far today (usual: ${usualOrdersText} per day)`

  const byDay = Array(7).fill(0)
  history.forEach(order => { byDay[new Date(order.created_at).getDay()] += 1 })
  const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
  const peakDay = history.length ? dayNames[byDay.indexOf(Math.max(...byDay))] : 'Not enough data'

  const recentStart = subDays(today, 14)
  const previousStart = subDays(today, 29)
  const revenueEvents = paymentHistory.length ? paymentHistory.map(payment => ({ date: paymentTimestamp(payment), amount: recordedPaymentAmount(payment) }))
    : revenueOrderHistory.map(order => ({ date: order.created_at, amount: recordedRevenue(order) }))
  const recentRevenue = revenueEvents.filter(event => new Date(event.date) >= recentStart)
    .reduce((sum, event) => sum + event.amount, 0)
  const previousRevenue = revenueEvents.filter(event => {
    const date = new Date(event.date)
    return date >= previousStart && date < recentStart
  }).reduce((sum, event) => sum + event.amount, 0)

  return {
    historyDays,
    totalRevenue,
    averageDailyOrders,
    expectedTodayOrders,
    todayOrderCount,
    workloadSummary,
    predictedMonthlyRevenue: Math.round(totalRevenue),
    workloadPct,
    workloadLevel,
    peakDay,
    revenueTrend: previousRevenue > 0 ? Number((((recentRevenue - previousRevenue) / previousRevenue) * 100).toFixed(1)) : 0,
    oldestHistoryDate: history.length ? history.reduce((oldest, order) => new Date(order.created_at) < oldest ? new Date(order.created_at) : oldest, new Date(history[0].created_at)) : null,
  }
}
