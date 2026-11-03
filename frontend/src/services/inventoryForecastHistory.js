import { supabase } from '../lib/supabase'

// Recent history each branch contributes to item run-out forecasts.
const USAGE_ROWS_PER_BRANCH = 500
const ORDER_ITEM_ROWS_PER_BRANCH = 1000
// The service-link fallback in utils/inventoryForecast.js looks back 30 days.
const SERVICE_USAGE_DAYS = 30

/**
 * Loads what item run-out forecasts need, read separately for each branch the
 * given items belong to. A busy branch's recent activity therefore never
 * pushes a quieter branch's history out of the window.
 */
export async function loadInventoryForecastHistory(items = []) {
  const branchIds = [...new Set(items.map(item => item?.branch_id).filter(Boolean))]
  const since = new Date()
  since.setDate(since.getDate() - SERVICE_USAGE_DAYS)

  const [recipesRes, ...branchResults] = await Promise.all([
    supabase
      .from('service_inventory_requirements')
      .select('inventory_item_id, service_type_id, branch_id, quantity_per_load, is_active')
      .eq('is_active', true),
    ...branchIds.map(branchId => Promise.all([
      supabase
        .from('inventory_usage_log')
        .select('item_id, quantity_used, logged_at, reversed_at, branch_id')
        .eq('branch_id', branchId)
        .order('logged_at', { ascending: false })
        .limit(USAGE_ROWS_PER_BRANCH),
      supabase
        .from('order_items')
        .select('service_type_id, branch_id, loads, status, created_at')
        .eq('branch_id', branchId)
        .not('status', 'eq', 'cancelled')
        .gte('created_at', since.toISOString())
        .order('created_at', { ascending: false })
        .limit(ORDER_ITEM_ROWS_PER_BRANCH),
    ])),
  ])

  const error = recipesRes.error || branchResults.flat().find(result => result.error)?.error
  if (error) throw error
  return {
    usageLogs: branchResults.flatMap(([usageRes]) => usageRes.data || []),
    serviceRecipes: recipesRes.data || [],
    serviceOrderItems: branchResults.flatMap(([, orderItemsRes]) => orderItemsRes.data || []),
  }
}
