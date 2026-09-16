import { addDays, eachDayOfInterval, eachMonthOfInterval, eachYearOfInterval, endOfDay, format, parseISO, startOfDay, subDays } from 'date-fns'
import { recordedRevenue } from './businessForecast.js'

export function analyticsPeriod(range, customRange = {}, now = new Date()) {
  if (customRange.start && customRange.end) return {
    start: startOfDay(parseISO(customRange.start)), end: endOfDay(parseISO(customRange.end)),
  }
  return {
    start: range === 'weekly' ? startOfDay(subDays(now, 6))
      : new Date(now.getFullYear() - (range === 'yearly' ? 4 : 0), 0, 1),
    end: now,
  }
}

export function dailyChartLabel(value) {
  return format(typeof value === 'string' ? parseISO(value) : value, 'EEE, MMM d')
}

export function chartTooltipDate(label, payload) {
  const point = payload?.[0]?.payload
  if (point?.fullDate) return point.fullDate
  if (point?.forecastDate) return format(parseISO(point.forecastDate), 'EEEE, MMMM d, yyyy')
  return label
}

export function descriptiveChartData(orders, expenses, range, customRange, now = new Date()) {
  const period = analyticsPeriod(range, customRange, now)
  if (period.start > period.end) return []
  const pattern = range === 'weekly' ? 'yyyy-MM-dd' : range === 'monthly' ? 'yyyy-MM' : 'yyyy'
  const points = (range === 'weekly' ? eachDayOfInterval(period)
    : range === 'monthly' ? eachMonthOfInterval(period) : eachYearOfInterval(period)).map(date => ({
      key: format(date, pattern),
      date: format(date, range === 'weekly' ? 'EEE, MMM d' : range === 'monthly' ? 'MMM yyyy' : 'yyyy'),
      fullDate: format(date, range === 'weekly' ? 'EEEE, MMMM d, yyyy' : range === 'monthly' ? 'MMMM yyyy' : 'yyyy'),
      revenue: 0, expenses: 0,
    }))
  const byKey = new Map(points.map(point => [point.key, point]))
  for (const order of orders) {
    const date = parseISO(order.created_at)
    if (date < period.start || date > period.end || Number.isNaN(+date)) continue
    const point = byKey.get(format(date, pattern))
    if (point) point.revenue += recordedRevenue(order)
  }
  for (const expense of expenses) {
    const date = parseISO(expense.expense_date)
    if (date < startOfDay(period.start) || date >= addDays(startOfDay(period.end), 1) || Number.isNaN(+date)) continue
    const point = byKey.get(format(date, pattern))
    if (point) point.expenses += Number(expense.amount)
  }
  return points
}
