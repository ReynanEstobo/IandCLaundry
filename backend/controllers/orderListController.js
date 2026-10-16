import { database } from '../config/supabase.js'

const VALID_STATUSES = new Set(['received', 'on_process', 'ready', 'released', 'cancelled'])

function wholeNumber(value, fallback, { min, max }) {
  const number = Number(value)
  if (!Number.isInteger(number)) return fallback
  return Math.min(Math.max(number, min), max)
}

export async function listOrdersPage(query, identity) {
  if (identity.role !== 'admin' && (!identity.branchId || identity.role !== 'staff')) {
    throw Object.assign(new Error('Your staff account must be assigned to a branch before viewing orders.'), { status: 403 })
  }
  const status = String(query?.status || '').trim().toLowerCase()
  if (status && !VALID_STATUSES.has(status)) {
    throw Object.assign(new Error('The selected order status is invalid.'), { status: 400 })
  }
  const search = String(query?.search || '').trim().slice(0, 120)
  const pageSize = wholeNumber(query?.pageSize, 10, { min: 1, max: 50 })
  const page = wholeNumber(query?.page, 0, { min: 0, max: 1000000 })
  const { data, error } = await database.rpc('list_orders_page', {
    p_branch_id: identity.role === 'admin' ? null : identity.branchId,
    p_status: status || null,
    p_search: search || null,
    p_limit: pageSize,
    p_offset: page * pageSize,
  })
  if (error) throw Object.assign(new Error(error.message), { status: 400, details: error })
  return { data: data?.data || [], count: Number(data?.count || 0) }
}
