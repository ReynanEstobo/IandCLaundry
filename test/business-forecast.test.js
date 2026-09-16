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
