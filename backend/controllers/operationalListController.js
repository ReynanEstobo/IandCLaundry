import { database } from '../config/supabase.js'

const CUSTOMER_SORT_COLUMNS = new Set(['name', 'phone', 'email', 'branch', 'rewards', 'added'])

function pageNumber(value, fallback, maximum) {
  const number = Number(value)
  if (!Number.isInteger(number)) return fallback
  return Math.min(Math.max(number, 0), maximum)
}

function boundedPageSize(value, fallback, maximum) {
  const number = Number(value)
  if (!Number.isInteger(number)) return fallback
  return Math.min(Math.max(number, 1), maximum)
}

function requireOperationalIdentity(identity) {
  if (identity?.role === 'admin') return
  if (identity?.role === 'staff' && identity.branchId && identity.branch) return
  throw Object.assign(new Error('Your staff account must be assigned to a branch before viewing operational records.'), { status: 403 })
}

async function readPage(functionName, args) {
  const { data, error } = await database.rpc(functionName, args)
  if (error) throw Object.assign(new Error(error.message), { status: 400, details: error })
  return { data: data?.data || [], count: Number(data?.count || 0) }
}

export async function listCustomersPage(query, identity) {
  requireOperationalIdentity(identity)
  const pageSize = boundedPageSize(query?.pageSize, 10, 50)
  const page = pageNumber(query?.page, 0, 1_000_000)
  // Sorting happens in the database so it covers every page, not only the
  // rows on screen. Without a sort column the most recently served come first.
  const sort = CUSTOMER_SORT_COLUMNS.has(query?.sort) ? query.sort : null
  return readPage('list_customers_page', {
    p_branch_id: identity.role === 'admin' ? null : identity.branchId,
    p_search: String(query?.search || '').trim().slice(0, 120) || null,
    p_limit: pageSize,
    p_offset: page * pageSize,
    p_sort: sort,
    p_direction: sort && query?.direction === 'desc' ? 'desc' : 'asc',
  })
}

export async function listInventoryPage(query, identity) {
  requireOperationalIdentity(identity)
  const pageSize = boundedPageSize(query?.pageSize, 25, 100)
  const page = pageNumber(query?.page, 0, 1_000_000)
  const requestedBranch = String(query?.branch || '').trim()
  return readPage('list_inventory_page', {
    p_branch: identity.role === 'admin' ? (requestedBranch && requestedBranch !== 'all' ? requestedBranch : null) : identity.branch,
    p_search: String(query?.search || '').trim().slice(0, 120) || null,
    p_limit: pageSize,
    p_offset: page * pageSize,
  })
}
