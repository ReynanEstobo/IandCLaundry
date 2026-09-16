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

/**
 * A transparent rolling 30-day baseline for dashboard decision support.
 * It deliberately uses the same received-revenue definition as Analytics.
 */
export function rollingDemandForecast(orders = [], now = new Date()) {
  const today = startOfDay(now)
  const windowStart = subDays(today, 29)
  const history = reportableOrders(orders).filter(order => new Date(order.created_at) >= windowStart && new Date(order.created_at) <= now)
  const historyDays = 30
  const totalRevenue = history.reduce((sum, order) => sum + recordedRevenue(order), 0)
  const averageDailyOrders = history.length / historyDays

  const tomorrow = new Date(today)
  tomorrow.setDate(tomorrow.getDate() + 1)
  const tomorrowDay = tomorrow.getDay()
  const matchingDays = Array.from({ length: historyDays }, (_, index) => subDays(today, index))
    .filter(day => day.getDay() === tomorrowDay).length
  const expectedTomorrowOrders = history.filter(order => new Date(order.created_at).getDay() === tomorrowDay).length / Math.max(matchingDays, 1)
  const workloadPct = averageDailyOrders > 0
    ? Math.min(Math.round((expectedTomorrowOrders / averageDailyOrders) * 100), 200)
    : 0
  const workloadLevel = history.length < 7 ? 'Limited data'
    : workloadPct >= 120 ? 'High Demand'
      : workloadPct >= 80 ? 'Moderate'
        : workloadPct >= 50 ? 'Normal'
          : 'Low'

  const byDay = Array(7).fill(0)
  history.forEach(order => { byDay[new Date(order.created_at).getDay()] += 1 })
  const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
  const peakDay = history.length ? dayNames[byDay.indexOf(Math.max(...byDay))] : 'Not enough data'

  const recentStart = subDays(today, 14)
  const previousStart = subDays(today, 29)
  const recentRevenue = history.filter(order => new Date(order.created_at) >= recentStart)
    .reduce((sum, order) => sum + recordedRevenue(order), 0)
  const previousRevenue = history.filter(order => {
    const date = new Date(order.created_at)
    return date >= previousStart && date < recentStart
  }).reduce((sum, order) => sum + recordedRevenue(order), 0)

  return {
    historyDays,
    totalRevenue,
    averageDailyOrders,
    predictedMonthlyRevenue: Math.round(totalRevenue),
    workloadPct,
    workloadLevel,
    peakDay,
    revenueTrend: previousRevenue > 0 ? Number((((recentRevenue - previousRevenue) / previousRevenue) * 100).toFixed(1)) : 0,
    oldestHistoryDate: history.length ? history.reduce((oldest, order) => new Date(order.created_at) < oldest ? new Date(order.created_at) : oldest, new Date(history[0].created_at)) : null,
  }
}
