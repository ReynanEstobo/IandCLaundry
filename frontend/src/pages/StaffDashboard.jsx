import { useState, useEffect, useCallback } from 'react'
import { supabase } from '../lib/supabase'
import { useRealtime } from '../lib/useRealtime'
import { useAuth } from '../context/AuthContext'
import { InlineSkeleton, PageError, PageLoader } from '../components/AsyncState'
import { compareOrdersForList } from '../utils/orderListPriority'
import { rollingDemandForecast } from '../utils/businessForecast'
import { staffDashboardChartData } from '../utils/chartDates'
import { inventoryRunOutLabel, predictInventoryDaysLeft, suggestInventoryReorderQuantity } from '../utils/inventoryForecast'
import DashboardCharts from '../components/DashboardCharts'
import {
  Clock, AlertTriangle, ShoppingBag, CheckCircle2, Timer, User, Radio,
  Brain, Zap, TrendingUp
} from 'lucide-react'

const STATUS_FLOW = ['received', 'on_process', 'ready']
const STATUS_LABELS = {
  received: 'Received',
  on_process: 'On Process',
  ready: 'Ready',
}
const STATUS_ICONS = {
  received: '📥',
  on_process: '⚙️',
  ready: '✅',
}

function buildBranchForecast(orderHistory, paymentHistory, lowStockItems) {
  const baseline = rollingDemandForecast(orderHistory, paymentHistory)

  return {
    ...baseline,
    nextMonthRevenue: baseline.predictedMonthlyRevenue,
    restockItems: lowStockItems,
  }
}

export default function StaffDashboard() {
  const { branch } = useAuth()
  const [orders, setOrders] = useState([])
  const [orderHistory, setOrderHistory] = useState([])
  const [paymentHistory, setPaymentHistory] = useState([])
  const [inventory, setInventory] = useState([])
  const [usageLogs, setUsageLogs] = useState([])
  const [serviceRecipes, setServiceRecipes] = useState([])
  const [serviceOrderItems, setServiceOrderItems] = useState([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [chartRange, setChartRange] = useState('weekly')
  const [statusFilter, setStatusFilter] = useState('all')

  const loadData = useCallback(async (background = false) => {
    if (!background) {
      setLoading(true)
      setLoadError('')
    } else setRefreshing(true)
    try {
      const [ordersRes, inventoryRes, historyRes, paymentsRes, usageRes, recipesRes, orderItemsRes] = await Promise.all([
        supabase.from('orders').select('*, customers(name, phone), service_types(name), order_items(service_name_snapshot, weight_kg, status)')
          .not('status', 'in', '("released","cancelled")')
          .order('created_at', { ascending: false }),
        supabase.from('inventory_items').select('*, inventory_categories(name)'),
        // Row-level security restricts this data to the signed-in staff member's branch.
        supabase.from('orders').select('created_at, amount_paid, total_price, payment_status, status')
          .not('status', 'eq', 'cancelled'),
        supabase.from('payments').select('amount, paid_at, payment_date'),
        supabase.from('inventory_usage_log').select('item_id, quantity_used, logged_at, reversed_at')
          .order('logged_at', { ascending: false }).limit(500),
        supabase.from('service_inventory_requirements')
          .select('inventory_item_id, service_type_id, branch_id, quantity_per_load, is_active').eq('is_active', true),
        supabase.from('order_items').select('service_type_id, branch_id, loads, status, created_at')
          .not('status', 'eq', 'cancelled').order('created_at', { ascending: false }).limit(1000)
      ])
      if (ordersRes.error || inventoryRes.error || historyRes.error || paymentsRes.error || usageRes.error || recipesRes.error || orderItemsRes.error) {
        throw ordersRes.error || inventoryRes.error || historyRes.error || paymentsRes.error || usageRes.error || recipesRes.error || orderItemsRes.error
      }
      setOrders([...(ordersRes.data || [])].sort(compareOrdersForList))
      setInventory(inventoryRes.data || [])
      setOrderHistory(historyRes.data || [])
      setPaymentHistory(paymentsRes.data || [])
      setUsageLogs(usageRes.data || [])
      setServiceRecipes(recipesRes.data || [])
      setServiceOrderItems(orderItemsRes.data || [])
    } catch (error) {
      if (!background) setLoadError(error.message || 'Unable to load your branch dashboard.')
      else console.error('Background staff dashboard refresh failed:', error)
    } finally {
      if (!background) setLoading(false)
      else setRefreshing(false)
    }
  }, [])

  useEffect(() => { loadData() }, [loadData])

  // Realtime: refresh when orders or inventory change
  useRealtime([
    'orders',
    'order_items',
    'payments',
    'inventory_items',
    'inventory_usage_log',
    'inventory_restocks',
    'service_inventory_requirements',
  ], () => loadData(true))

  function getTimeRemaining(estimatedCompletion) {
    if (!estimatedCompletion) return null
    const now = new Date()
    const est = new Date(estimatedCompletion)
    const diffMs = est - now
    if (diffMs <= 0) return 'Ready!'
    const mins = Math.floor(diffMs / 60000)
    const hrs = Math.floor(mins / 60)
    const remainMins = mins % 60
    if (hrs > 0) return `${hrs}h ${remainMins}m`
    return `${remainMins}m`
  }

  const activeCount = orders.length
  const readyCount = orders.filter(o => o.status === 'ready').length
  const inProgressCount = orders.filter(o => o.status === 'on_process').length

  // Low stock
  const lowStockItems = inventory.filter(i => Number(i.current_stock) <= Number(i.minimum_stock))
  const forecastedLowStockItems = lowStockItems.map(item => ({
    ...item,
    forecastDaysLeft: predictInventoryDaysLeft(item, usageLogs, serviceRecipes, serviceOrderItems),
    suggestedReorder: suggestInventoryReorderQuantity(item, usageLogs, serviceRecipes, serviceOrderItems),
  }))
  const branchForecast = buildBranchForecast(orderHistory, paymentHistory, forecastedLowStockItems)
  const chartData = staffDashboardChartData(orderHistory, paymentHistory, chartRange)
  const visibleStatuses = statusFilter === 'all' ? STATUS_FLOW : [statusFilter]

  if (loading) return <PageLoader label="Loading branch dashboard…" />
  if (loadError) return <PageError message={loadError} onRetry={loadData} />

  return (
    <section className="staff-dashboard">
      <div className="staff-dashboard-heading">
        <div>
          <p className="staff-dashboard-kicker">Branch operations</p>
          <h2>Today’s work queue</h2>
          <p>Monitor the orders and inventory assigned to {branch || 'your branch'}.</p>
        </div>
        <span className="live-update-indicator" role="status" aria-live="polite">
          {refreshing ? <InlineSkeleton label="Syncing updates…" /> : <><Radio size={14} aria-hidden="true" /> Live updates</>}
        </span>
      </div>

      <div className="staff-dashboard-summary">
        {/* Stats Row */}
        <div className="stats-grid staff-dashboard-stats">
        <div className="stat-card blue">
          <div className="stat-icon"><ShoppingBag size={22} /></div>
          <div className="stat-value">{activeCount}</div>
          <div className="stat-label">Active Orders</div>
        </div>
        <div className="stat-card amber">
          <div className="stat-icon"><Timer size={22} /></div>
          <div className="stat-value">{inProgressCount}</div>
          <div className="stat-label">In Progress</div>
        </div>
        <div className="stat-card green">
          <div className="stat-icon"><CheckCircle2 size={22} /></div>
          <div className="stat-value">{readyCount}</div>
          <div className="stat-label">Ready for Pickup</div>
        </div>
        <div className="stat-card red">
          <div className="stat-icon"><AlertTriangle size={22} /></div>
          <div className="stat-value">{lowStockItems.length}</div>
          <div className="stat-label">Low Stock Items</div>
        </div>
        </div>

        <aside className="staff-dss-overview" aria-label="Branch decision support overview">
          <div className="staff-dss-header">
            <div>
              <span className="staff-dss-eyebrow"><Brain size={15} /> DSS overview</span>
              <h3>Decision Support</h3>
              <p>Read-only forecast for {branch || 'your branch'}.</p>
            </div>
            <span className="staff-dss-badge"><Zap size={12} /> AI-assisted</span>
          </div>

          <div className="staff-dss-metrics">
            <div className="staff-dss-metric workload">
              <span>Expected workload today</span>
              <strong>{branchForecast.workloadLevel}</strong>
              <small>{branchForecast.workloadSummary}</small>
            </div>
            <div className="staff-dss-metric peak">
              <span>Likely peak day</span>
              <strong>{branchForecast.peakDay}</strong>
              <small>Plan your shift ahead</small>
            </div>
          </div>

          <div className="staff-dss-revenue">
            <span className="staff-dss-icon"><TrendingUp size={19} /></span>
            <div>
              <span>Predicted revenue</span>
              <strong>₱{branchForecast.nextMonthRevenue.toLocaleString()}</strong>
              <small>Based on received payments in the last 30 days</small>
            </div>
          </div>

          {branchForecast.restockItems.length ? (
            <div className="staff-dss-alert-group">
              <div className="staff-dss-alert-summary">
                <AlertTriangle size={17} />
                <strong>{branchForecast.restockItems.length} low-stock item{branchForecast.restockItems.length === 1 ? '' : 's'} need attention</strong>
              </div>
              {branchForecast.restockItems.map(item => (
                <div className="staff-dss-alert" key={item.id}>
                  <span className="staff-dss-alert-dot" aria-hidden="true" />
                  <div>
                    <strong>{item.name}</strong>
                    <span>{Number(item.current_stock)} {item.unit} remaining · Minimum: {Number(item.minimum_stock)} {item.unit}</span>
                    <span className="staff-dss-forecast">{inventoryRunOutLabel(item.forecastDaysLeft)}</span>
                    <span className="staff-dss-reorder">Suggested reorder: ~{item.suggestedReorder} {item.unit}</span>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="staff-dss-ok">
              <CheckCircle2 size={17} /> No low-stock items reported for your branch.
            </div>
          )}
        </aside>
      </div>

      <DashboardCharts data={chartData} range={chartRange} onRangeChange={setChartRange} />

      {/* Kanban Board — same as admin Orders page */}

      <div className="staff-kanban-toolbar">
        <div className="staff-kanban-legend" role="group" aria-label="Filter orders by status">
          {['all', ...STATUS_FLOW].map(status => (
            <button
              type="button"
              key={status}
              className={`staff-kanban-filter ${statusFilter === status ? 'active' : ''}`}
              onClick={() => setStatusFilter(status)}
              aria-pressed={statusFilter === status}
            >
              <span aria-hidden="true">{status === 'all' ? '☰' : STATUS_ICONS[status]}</span>
              <span>{status === 'all' ? 'All' : STATUS_LABELS[status]}</span>
              <small>{status === 'all' ? orders.length : orders.filter(order => order.status === status).length}</small>
            </button>
          ))}
        </div>
      </div>

      <div className="kanban-board">
        {visibleStatuses.map(status => {
          const columnOrders = orders.filter(o => o.status === status)
          return (
            <div key={status} className="kanban-column" data-stage={status}>
              <div className="kanban-column-header">
                <div className="kanban-column-title">
                  <span className="kanban-column-icon">{STATUS_ICONS[status]}</span>
                  <span>{STATUS_LABELS[status]}</span>
                  <span className="kanban-count">{columnOrders.length}</span>
                </div>
              </div>
              <div className="kanban-cards">
                {columnOrders.length === 0 ? (
                  <div className="kanban-empty"><span>{STATUS_ICONS[status]}</span><strong>No orders</strong><small>This stage is currently clear.</small></div>
                ) : columnOrders.map(order => (
                  <div key={order.id} className="kanban-card staff-kanban-card">
                    <div className="kanban-card-header">
                      <span className="kanban-order-num">{order.order_number}</span>
                      <span className={`kanban-payment-badge badge-${order.payment_status}`}>{order.payment_status}</span>
                    </div>
                    <div className="kanban-card-customer">
                      <User size={13} />
                      <span>{order.customers?.name || 'Walk-in'}</span>
                    </div>
                    <div className="kanban-card-details">
                      <span className="staff-kanban-service-text">{order.order_items?.length ? order.order_items.map(item => item.service_name_snapshot).join(', ') : order.service_types?.name}</span>
                      <span className="kanban-card-kg">{order.weight_kg} kg</span>
                    </div>
                    <div className="staff-kanban-meta">
                      <span className="kanban-card-price">₱{Number(order.total_price).toLocaleString()}</span>
                      <span className={`staff-kanban-time ${status === 'ready' ? 'ready' : ''}`}>
                        {status !== 'ready' && (
                          <><Clock size={12} /> {getTimeRemaining(order.estimated_ready_at) || 'ETA unavailable'}</>
                        )}
                        {status === 'ready' && <><CheckCircle2 size={12} /> Ready</>}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )
        })}
      </div>
    </section>
  )
}
