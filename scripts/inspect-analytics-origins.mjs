import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'

const url = process.env.SUPABASE_URL
const key = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required')

const database = createClient(url, key, {
  auth: { persistSession: false, autoRefreshToken: false },
})

const reconstructedStart = '2026-07-31T16:00:00.000Z' // Aug 1, Asia/Manila
const liveStart = '2026-11-05T16:00:00.000Z' // Nov 6, Asia/Manila

async function fetchAll(table, columns, configure = query => query) {
  const rows = []
  for (let from = 0; ; from += 1000) {
    const { data, error } = await configure(database.from(table).select(columns)).range(from, from + 999)
    if (error) throw error
    rows.push(...(data || []))
    if (!data || data.length < 1000) return rows
  }
}

function byBranch(rows) {
  return rows.reduce((counts, row) => {
    const branch = row.branch || 'Unassigned'
    counts[branch] = (counts[branch] || 0) + 1
    return counts
  }, {})
}

const reconstructedOrders = await fetchAll(
  'orders',
  'id, branch, created_at, customer_id, status',
  query => query.gte('created_at', reconstructedStart).lt('created_at', liveStart).order('created_at'),
)
const liveOrders = await fetchAll(
  'orders',
  'id, branch, created_at, customer_id, status',
  query => query.gte('created_at', liveStart).order('created_at'),
)
const reconstructedCustomers = await fetchAll(
  'customers',
  'id, created_at, branch',
  query => query.gte('created_at', reconstructedStart).lt('created_at', liveStart),
)
const reconstructedPayments = await fetchAll(
  'payments',
  'id, order_id, paid_at',
  query => query.gte('paid_at', reconstructedStart).lt('paid_at', liveStart),
)
const reconstructedUsage = await fetchAll(
  'inventory_usage_log',
  'id, order_id, logged_at',
  query => query.gte('logged_at', reconstructedStart).lt('logged_at', liveStart),
)

const report = {
  classification: {
    aggregate_reconstruction: '2026-08-01 through 2026-11-05 in Asia/Manila',
    live: '2026-11-06 onward in Asia/Manila',
  },
  orders: {
    reconstructedCount: reconstructedOrders.length,
    reconstructedByBranch: byBranch(reconstructedOrders),
    reconstructedFirst: reconstructedOrders[0]?.created_at || null,
    reconstructedLast: reconstructedOrders.at(-1)?.created_at || null,
    liveCount: liveOrders.length,
    liveByBranch: byBranch(liveOrders),
    liveFirst: liveOrders[0]?.created_at || null,
  },
  linkedRecordCounts: {
    reconstructedCustomersCreatedInPeriod: reconstructedCustomers.length,
    reconstructedPaymentsDatedInPeriod: reconstructedPayments.length,
    reconstructedInventoryUsageRows: reconstructedUsage.length,
  },
}

console.log(JSON.stringify(report, null, 2))
