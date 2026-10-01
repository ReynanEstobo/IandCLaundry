import {
  Area, AreaChart, Bar, BarChart, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts'
import { LoadingVisual } from './AsyncState'

const PERIODS = ['weekly', 'monthly', 'yearly']

export default function DashboardCharts({ data, range, onRangeChange, loading = false }) {
  const chartData = data.map(point => ({ ...point, label: point.label || point.date }))
  const periodName = range.charAt(0).toUpperCase() + range.slice(1)

  return (
    <section className="dashboard-performance-charts" aria-label="Orders and revenue charts">
      <div className="dashboard-chart-filters" aria-label="Chart period">
        {PERIODS.map(period => (
          <button
            type="button"
            key={period}
            className={`btn btn-sm ${range === period ? 'btn-primary' : ''}`}
            onClick={() => onRangeChange(period)}
            disabled={loading}
            aria-pressed={range === period}
          >
            {period}
          </button>
        ))}
      </div>

      <div className="charts-grid">
        {loading ? (
          ['orders', 'revenue'].map(chart => (
            <div className="card dashboard-chart-loading" key={chart}>
              <LoadingVisual label={`Updating ${range} ${chart}…`} compact />
            </div>
          ))
        ) : (
          <>
            <div className="card">
              <div className="card-header"><h3>{periodName} Orders</h3></div>
              <ResponsiveContainer width="100%" height={240}>
                <BarChart data={chartData} margin={{ top: 12, right: 4, left: 0, bottom: 0 }}>
                  <XAxis dataKey="label" stroke="var(--chart-axis, #64748b)" fontSize={12} tickLine={false} axisLine={false} />
                  <YAxis
                    stroke="var(--chart-axis, #64748b)"
                    fontSize={12}
                    tickLine={false}
                    axisLine={false}
                    allowDecimals={false}
                    domain={[0, dataMax => Math.max(1, Math.ceil(Number(dataMax || 0) * 1.15))]}
                  />
                  <Tooltip
                    labelFormatter={(label, payload) => payload?.[0]?.payload?.fullDate || label}
                    contentStyle={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 10, color: 'var(--text-primary)', boxShadow: 'var(--shadow-lg)', fontSize: 13 }}
                    labelStyle={{ color: 'var(--text-primary)' }}
                    itemStyle={{ color: 'var(--text-secondary)' }}
                  />
                  <Bar dataKey="orders" fill="#3b82f6" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>

            <div className="card">
              <div className="card-header"><h3>{periodName} Revenue Trend</h3></div>
              <ResponsiveContainer width="100%" height={240}>
                <AreaChart data={chartData} margin={{ top: 12, right: 4, left: 0, bottom: 0 }}>
                  <defs>
                    <linearGradient id="dashboardRevenueGradient" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#10b981" stopOpacity={0.3} />
                      <stop offset="100%" stopColor="#10b981" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <XAxis dataKey="label" stroke="var(--chart-axis, #9ca3af)" fontSize={12} tickLine={false} axisLine={false} />
                  <YAxis
                    stroke="var(--chart-axis, #9ca3af)"
                    fontSize={12}
                    tickLine={false}
                    axisLine={false}
                    domain={[0, dataMax => Math.max(1, Math.ceil(Number(dataMax || 0) * 1.15))]}
                  />
                  <Tooltip
                    labelFormatter={(label, payload) => payload?.[0]?.payload?.fullDate || label}
                    contentStyle={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 10, color: 'var(--text-primary)', boxShadow: 'var(--shadow-lg)', fontSize: 13 }}
                    labelStyle={{ color: 'var(--text-primary)' }}
                    itemStyle={{ color: 'var(--text-secondary)' }}
                    formatter={value => [`₱${Number(value).toLocaleString()}`, 'Revenue']}
                  />
                  <Area type="monotone" dataKey="revenue" stroke="#10b981" fill="url(#dashboardRevenueGradient)" strokeWidth={2} />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </>
        )}
      </div>
    </section>
  )
}
