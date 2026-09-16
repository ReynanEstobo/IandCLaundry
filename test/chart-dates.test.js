import assert from 'node:assert/strict'
import test from 'node:test'
import { analyticsPeriod, descriptiveChartData, paymentChartData, chartTooltipDate } from '../frontend/src/utils/chartDates.js'

test('weekly chart uses seven exact calendar dates across a year boundary', () => {
  const rows = descriptiveChartData([], [], 'weekly', {}, new Date(2027, 0, 3, 12))
  assert.equal(rows.length, 7)
  assert.equal(rows[0].key, '2026-12-28')
  assert.equal(rows[6].key, '2027-01-03')
  assert.match(rows[0].date, /Mon, Dec 28/)
  assert.match(chartTooltipDate('', [{payload:rows[0]}]), /Monday, December 28, 2026/)
})

test('custom dates keep different Mondays separate and include the final day', () => {
  const custom = {start:'2026-09-07',end:'2026-09-14'}
  const orders = [
    {created_at:'2026-09-07T12:00:00',amount_paid:100},
    {created_at:'2026-09-14T23:59:00',amount_paid:200},
    {created_at:'2026-09-15T00:00:00',amount_paid:900},
  ]
  const rows = descriptiveChartData(orders,[{expense_date:'2026-09-14',amount:30}], 'weekly',custom)
  assert.equal(rows.length,8)
  assert.equal(rows[0].revenue,100)
  assert.equal(rows[7].revenue,200)
  assert.equal(rows[7].expenses,30)
  assert.equal(analyticsPeriod('weekly',custom).end.getHours(),23)
})

test('monthly custom range separates months from different years', () => {
  const rows = descriptiveChartData([
    {created_at:'2025-01-10T12:00:00',amount_paid:10},
    {created_at:'2026-01-10T12:00:00',amount_paid:20},
  ], [], 'monthly', {start:'2025-01-01',end:'2026-01-31'})
  assert.equal(rows[0].date,'Jan 2025')
  assert.equal(rows[12].date,'Jan 2026')
  assert.equal(rows[0].revenue,10)
  assert.equal(rows[12].revenue,20)
})

test('payment ledger charts group revenue by payment date, not the order date', () => {
  const rows = paymentChartData([
    { amount: 250, paid_at: '2026-09-01T09:00:00' },
    { amount: 250, paid_at: '2026-09-05T09:00:00' },
  ], [], 'weekly', { start: '2026-09-01', end: '2026-09-07' })
  assert.equal(rows[0].revenue, 250)
  assert.equal(rows[4].revenue, 250)
})
