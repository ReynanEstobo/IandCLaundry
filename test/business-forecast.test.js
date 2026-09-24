import assert from 'node:assert/strict'
import test from 'node:test'
import { recordedRevenue, rollingDemandForecast } from '../frontend/src/utils/businessForecast.js'

test('recorded revenue matches Analytics payment handling', () => {
  assert.equal(recordedRevenue({ amount_paid: 125, total_price: 200, payment_status: 'partial' }), 125)
  assert.equal(recordedRevenue({ amount_paid: null, total_price: 200, payment_status: 'paid' }), 200)
  assert.equal(recordedRevenue({ amount_paid: null, total_price: 200, payment_status: 'partial' }), 0)
})

test('rolling dashboard forecast uses received revenue from the same 30-day window', () => {
  const now = new Date('2026-09-16T12:00:00')
  const forecast = rollingDemandForecast([
    { created_at: '2026-09-16T08:00:00', amount_paid: 100, status: 'released' },
    { created_at: '2026-09-03T08:00:00', amount_paid: 75, status: 'received' },
    { created_at: '2026-08-17T08:00:00', amount_paid: 999, status: 'released' },
    { created_at: '2026-09-15T08:00:00', amount_paid: 999, status: 'cancelled' },
  ], now)
  assert.equal(forecast.totalRevenue, 175)
  assert.equal(forecast.predictedMonthlyRevenue, 175)
  assert.equal(forecast.historyDays, 30)
})

test('payment ledger timing overrides the order creation date for revenue forecasts', () => {
  const now = new Date('2026-09-16T12:00:00')
  const forecast = rollingDemandForecast([
    { created_at: '2026-08-10T08:00:00', amount_paid: 500, status: 'released' },
  ], [
    { amount: 250, paid_at: '2026-09-01T09:00:00' },
    { amount: 250, paid_at: '2026-09-05T09:00:00' },
  ], now)
  assert.equal(forecast.totalRevenue, 500)
})

test('workload estimates today using its weekday rather than tomorrow', () => {
  const now = new Date('2026-09-25T12:00:00') // Friday
  const orders = [
    ...Array.from({ length: 8 }, () => ({ created_at: '2026-09-18T09:00:00', status: 'released' })),
    ...Array.from({ length: 12 }, () => ({ created_at: '2026-09-19T09:00:00', status: 'released' })),
  ]
  const forecast = rollingDemandForecast(orders, now)

  // Four Fridays in the completed 30-day window, blended with two average days.
  assert.equal(forecast.averageDailyOrders, 20 / 30)
  assert.ok(Math.abs(forecast.expectedTodayOrders - 14 / 9) < 1e-12)
  assert.equal(Object.hasOwn(forecast, 'expectedTomorrowOrders'), false)
  assert.match(forecast.workloadSummary, /expected today/i)
  assert.doesNotMatch(forecast.workloadSummary, /tomorrow/i)
})

test('demand history includes exactly the previous 30 completed local days', () => {
  const now = new Date('2026-09-25T12:00:00')
  const forecast = rollingDemandForecast([
    { created_at: '2026-08-25T23:59:59', status: 'released' },
    { created_at: '2026-08-26T00:00:00', status: 'released' },
    { created_at: '2026-09-24T23:59:59', status: 'released' },
    { created_at: '2026-09-25T00:00:00', status: 'received' },
  ], now)

  assert.equal(forecast.historyDays, 30)
  assert.equal(forecast.averageDailyOrders, 2 / 30)
  assert.deepEqual(forecast.oldestHistoryDate, new Date('2026-08-26T00:00:00'))
  assert.equal(forecast.todayOrderCount, 1)
})

test('today, future, cancelled, and invalid orders do not change the historical workload baseline', () => {
  const now = new Date('2026-09-25T12:00:00')
  const history = Array.from({ length: 8 }, () => ({ created_at: '2026-09-18T09:00:00', status: 'released' }))
  const baseline = rollingDemandForecast(history, now)
  const forecast = rollingDemandForecast([
    ...history,
    ...Array.from({ length: 25 }, () => ({ created_at: '2026-09-25T09:00:00', status: 'received' })),
    { created_at: '2026-09-25T13:00:00', status: 'received' },
    { created_at: '2026-09-26T09:00:00', status: 'received' },
    { created_at: '2026-09-18T09:00:00', status: 'cancelled' },
    { created_at: 'not-a-date', status: 'received' },
    { created_at: null, status: 'received' },
  ], now)

  for (const field of ['averageDailyOrders', 'expectedTodayOrders', 'workloadPct', 'workloadLevel', 'peakDay', 'oldestHistoryDate']) {
    assert.deepEqual(forecast[field], baseline[field], field)
  }
  assert.equal(forecast.todayOrderCount, 25)
})

test('today count includes valid noncancelled orders from midnight through now', () => {
  const now = new Date('2026-09-25T12:00:00')
  const forecast = rollingDemandForecast([
    { created_at: '2026-09-24T23:59:59', status: 'released' },
    { created_at: '2026-09-25T00:00:00', status: 'received' },
    { created_at: '2026-09-25T08:00:00', status: 'released' },
    { created_at: '2026-09-25T12:00:00', status: 'ready' },
    { created_at: '2026-09-25T12:00:01', status: 'received' },
    { created_at: '2026-09-25T08:00:00', status: 'cancelled' },
    { created_at: 'not-a-date', status: 'received' },
    { status: 'received' },
  ], now)

  assert.equal(forecast.todayOrderCount, 3)
  assert.match(forecast.workloadSummary, /today/i)
  assert.match(forecast.workloadSummary, /\b3\b/)
  assert.match(forecast.workloadSummary, /received|so far/i)
})

test('empty or fewer than seven historical orders retain the limited-data guard', () => {
  const now = new Date('2026-09-25T12:00:00')
  const empty = rollingDemandForecast([], now)
  assert.equal(empty.workloadLevel, 'Limited data')
  assert.equal(empty.expectedTodayOrders, 0)
  assert.equal(empty.todayOrderCount, 0)
  assert.equal(empty.oldestHistoryDate, null)
  assert.match(empty.workloadSummary, /today/i)

  const limited = rollingDemandForecast([
    ...Array.from({ length: 6 }, () => ({ created_at: '2026-09-18T09:00:00', status: 'released' })),
    ...Array.from({ length: 20 }, () => ({ created_at: '2026-09-25T09:00:00', status: 'received' })),
  ], now)
  assert.equal(limited.workloadLevel, 'Limited data')
  assert.equal(limited.averageDailyOrders, 6 / 30)
  assert.equal(limited.todayOrderCount, 20)
  assert.match(limited.workloadSummary, /today/i)
  assert.match(limited.workloadSummary, /\b20\b/)
})

test('a positive forecast below one order is not displayed as zero expected today', () => {
  const now = new Date('2026-09-25T12:00:00')
  const forecast = rollingDemandForecast(
    Array.from({ length: 8 }, () => ({ created_at: '2026-09-19T09:00:00', status: 'released' })),
    now,
  )

  assert.ok(forecast.expectedTodayOrders > 0 && forecast.expectedTodayOrders < 1)
  assert.equal(forecast.workloadLevel, 'Lighter than usual')
  assert.match(forecast.workloadSummary, /Less than 1 order expected today/)
  assert.doesNotMatch(forecast.workloadSummary, /\b0 orders expected today/)
})

test('the payment revenue window still includes today and starts 29 days before today', () => {
  const now = new Date('2026-09-25T12:00:00')
  const forecast = rollingDemandForecast([], [
    { amount: 999, paid_at: '2026-08-26T23:59:59' },
    { amount: 125, paid_at: '2026-08-27T00:00:00' },
    { amount: 300, paid_at: '2026-09-25T12:00:00' },
    { amount: 999, paid_at: '2026-09-25T12:00:01' },
  ], now)

  assert.equal(forecast.totalRevenue, 425)
  assert.equal(forecast.predictedMonthlyRevenue, 425)
  assert.equal(forecast.averageDailyOrders, 0)
})
