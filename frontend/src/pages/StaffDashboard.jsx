import { useState, useEffect, useCallback } from 'react'
import { supabase } from '../lib/supabase'
import { useRealtime } from '../lib/useRealtime'
import { useAuth } from '../context/AuthContext'
import { PageError, PageLoader } from '../components/AsyncState'
import { compareOrdersForList } from '../utils/orderListPriority'
import { rollingDemandForecast } from '../utils/businessForecast'
import {
  Clock, AlertTriangle, ShoppingBag, CheckCircle2, Timer, User, RefreshCw,
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
    restockItem: lowStockItems[0] || null,
  }
}

export default function StaffDashboard() {
  const { branch } = useAuth()
  const [orders, setOrders] = useState([])
  const [orderHistory, setOrderHistory] = useState([])
  const [paymentHistory, setPaymentHistory] = useState([])
  const [inventory, setInventory] = useState([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')

  const loadData = useCallback(async (background = false) => {
    if (!background) {
      setLoading(true)
      setLoadError('')
    }
    try {
      const [ordersRes, inventoryRes, historyRes, paymentsRes] = await Promise.all([
        supabase.from('orders').select('*, customers(name, phone), service_types(name)')
          .not('status', 'in', '("released","cancelled")')
          .order('created_at', { ascending: false }),
        supabase.from('inventory_items').select('*, inventory_categories(name)'),
        // Row-level security restricts this data to the signed-in staff member's branch.
        supabase.from('orders').select('created_at, amount_paid, total_price, payment_status, status')
          .not('status', 'eq', 'cancelled'),
        supabase.from('payments').select('amount, paid_at, payment_date')
      ])
      if (ordersRes.error || inventoryRes.error || historyRes.error || paymentsRes.error) {
        throw ordersRes.error || inventoryRes.error || historyRes.error || paymentsRes.error
      }
      setOrders([...(ordersRes.data || [])].sort(compareOrdersForList))
      setInventory(inventoryRes.data || [])
      setOrderHistory(historyRes.data || [])
      setPaymentHistory(paymentsRes.data || [])
    } catch (error) {
      if (!background) setLoadError(error.message || 'Unable to load your branch dashboard.')
      else console.error('Background staff dashboard refresh failed:', error)
    } finally {
      if (!background) setLoading(false)
    }
  }, [])

  useEffect(() => { loadData() }, [loadData])

  // Realtime: refresh when orders or inventory change
  useRealtime(['orders', 'inventory_items'], () => loadData(true))

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
  const inProgressCount = activeCount - readyCount

  // Low stock
  const lowStockItems = inventory.filter(i => Number(i.current_stock) <= Number(i.minimum_stock))
  const branchForecast = buildBranchForecast(orderHistory, paymentHistory, lowStockItems)

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
        <button className="btn btn-sm btn-secondary staff-dashboard-refresh" onClick={() => loadData()}>
          <RefreshCw size={14} /> Refresh data
        </button>
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
              <span>Expected workload</span>
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

          {branchForecast.restockItem ? (
            <div className="staff-dss-alert">
              <AlertTriangle size={18} />
              <div>
                <strong>{branchForecast.restockItem.name} needs attention</strong>
                <span>{Number(branchForecast.restockItem.current_stock)} {branchForecast.restockItem.unit} remaining; at or below the minimum level.</span>
              </div>
            </div>
          ) : (
            <div className="staff-dss-ok">
              <CheckCircle2 size={17} /> No low-stock items reported for your branch.
            </div>
          )}
        </aside>
      </div>

      {/* Kanban Board — same as admin Garment page */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          {STATUS_FLOW.map(s => (
            <span key={s} style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12, color: 'var(--text-muted)' }}>
              <span>{STATUS_ICONS[s]}</span> {STATUS_LABELS[s]}
            </span>
          ))}
        </div>
        <button className="btn btn-sm btn-secondary" onClick={loadData} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <RefreshCw size={14} /> Refresh
        </button>
      </div>

      <div className="kanban-board">
        {STATUS_FLOW.map(status => {
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
                  <div className="kanban-empty">No orders</div>
                ) : columnOrders.map(order => (
                  <div key={order.id} className="kanban-card" style={{ cursor: 'default' }}>
                    <div className="kanban-card-header">
                      <span className="kanban-order-num">{order.order_number}</span>
                      <span className={`badge badge-${order.payment_status}`} style={{ fontSize: 10, padding: '2px 6px' }}>{order.payment_status}</span>
                    </div>
                    <div className="kanban-card-customer">
                      <User size={13} />
                      <span>{order.customers?.name || 'Walk-in'}</span>
                    </div>
                    <div className="kanban-card-details">
                      <span>{order.service_types?.name}</span>
                      <span>{order.weight_kg} kg</span>
                    </div>
                    <div className="kanban-card-footer">
                      <span className="kanban-card-price">₱{Number(order.total_price).toLocaleString()}</span>
                      <span className="kanban-card-time">
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
