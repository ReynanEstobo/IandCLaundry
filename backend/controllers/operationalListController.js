import { database } from '../config/supabase.js'

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
  return readPage('list_customers_page', {
    p_branch_id: identity.role === 'admin' ? null : identity.branchId,
    p_search: String(query?.search || '').trim().slice(0, 120) || null,
    p_limit: pageSize,
    p_offset: page * pageSize,
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
