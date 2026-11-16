// The busiest period in a demand forecast (specific objective 3: "predicted
// peak laundry demand"). A peak is named only when it stands clearly above the
// other forecast periods, so a flat forecast, rounding, or one month simply
// having more days than another is never presented as a peak.
const PEAK_MARGIN = 1.1 // at least 10% above the average of the other periods

export function forecastPeak(points = [], grouping = 'weekly') {
  const orders = points.map(point => Math.max(0, Number(point?.predictedOrders) || 0))
  if (orders.length < 2 || !orders.some(value => value > 0)) return null
  const highest = Math.max(...orders)
  const index = orders.indexOf(highest)
  const others = orders.filter((_, i) => i !== index)
  const othersAverage = others.reduce((sum, value) => sum + value, 0) / others.length
  const distinct = orders.filter(value => value === highest).length === 1 && highest >= othersAverage * PEAK_MARGIN
  const unit = grouping === 'monthly' ? 'month' : grouping === 'yearly' ? 'year' : 'day'
  return {
    distinct,
    unit,
    index,
    label: points[index]?.fullDate || points[index]?.date || '',
    orders: highest,
    othersAverage: Math.round(othersAverage),
    average: Math.round(orders.reduce((sum, value) => sum + value, 0) / orders.length),
  }
}

export function describeForecastPeak(peak) {
  if (!peak) return ''
  return peak.distinct
    ? `Expected busiest ${peak.unit}: ${peak.label}, about ${peak.orders.toLocaleString('en-PH')} orders (other ${peak.unit}s average ${peak.othersAverage.toLocaleString('en-PH')}).`
    : `No distinct peak expected: about ${peak.average.toLocaleString('en-PH')} orders per ${peak.unit} across the forecast.`
}
