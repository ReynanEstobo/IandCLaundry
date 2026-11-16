import { formatPeso } from '../utils/money'

// The revenue card on both dashboards: next month's figure from the same
// forecast Analytics shows under Monthly, for the same branch scope.
// `forecast` is { status: 'loading' | 'ready' | 'error', result } where
// result comes from loadNextMonthForecast.
export default function RevenueForecastFigure({ forecast, scopeNote }) {
  const next = forecast?.result?.nextMonth
  if (!next) {
    const failed = forecast?.status === 'error'
    return (
      <>
        <span>Revenue forecast · next month</span>
        <strong>{failed ? 'Unavailable' : '…'}</strong>
        <small className="staff-dss-next">{failed ? 'The forecast could not be loaded · try again later' : 'Preparing the AI forecast…'}</small>
      </>
    )
  }
  const meta = forecast.result.meta || {}
  const source = meta.source === 'gemini'
    ? `Gemini AI${meta.reason ? ' (last result)' : ''}`
    : 'Local estimate (AI unavailable)'
  return (
    <>
      <span>Revenue forecast · {next.fullDate}</span>
      <strong>{formatPeso(next.predicted)}</strong>
      <small className="staff-dss-next">{source} · {next.confidence || 'low'} confidence · {scopeNote}</small>
      <small>About {Number(next.predictedOrders) || 0} orders expected. An estimate, not guaranteed income.</small>
    </>
  )
}
