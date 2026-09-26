import { database } from '../config/supabase.js'
import { assertEmail, assertPhilippineMobile, assertText } from '../utils/validation.js'

// This is intentionally a whitelist: it preserves existing Supabase query shapes
// while preventing the browser from selecting arbitrary database tables.
export const TABLES = new Set([
  'customers', 'orders', 'inventory_items', 'inventory_categories',
  'inventory_usage_log', 'inventory_restocks', 'expenses', 'staff',
  'settings', 'service_types', 'sms_log', 'branches', 'payments', 'ai_forecasts',
  'order_items', 'service_inventory_requirements',
])

// These reference/operational records can be hidden and later restored.
// Transaction and inventory-ledger records are deliberately excluded.
const SOFT_DELETABLE_TABLES = new Set([
  'customers', 'staff', 'inventory_items', 'inventory_categories',
  'service_types', 'expenses',
])
const PROTECTED_TRANSACTION_TABLES = new Set([
  'orders', 'payments', 'inventory_usage_log', 'inventory_restocks', 'sms_log',
  'order_items',
])

function applyFilters(query, filters = []) {
  return filters.reduce((current, { type, column, value }) => {
    if (!column) return current
    if (type === 'eq') return current.eq(column, value)
    if (type === 'gte') return current.gte(column, value)
    if (type === 'lte') return current.lte(column, value)
    if (type === 'ilike') return current.ilike(column, value)
    if (type === 'in') return current.in(column, value)
    if (type === 'not') return current.not(column, value?.operator, value?.value)
    return current
  }, query)
}

// Keep operational queues focused on today's actionable work, then older open
// work, released history, and finally cancelled history.
function compareOrdersForList(a, b) {
  const rank = order => order?.status === 'cancelled' ? 2 : order?.status === 'released' ? 1 : 0
  const rankDifference = rank(a) - rank(b)
  if (rankDifference !== 0) return rankDifference

  const isToday = value => {
    const date = new Date(value || 0)
    const today = new Date()
    return date.getFullYear() === today.getFullYear()
      && date.getMonth() === today.getMonth()
      && date.getDate() === today.getDate()
  }
  if (rank(a) === 0) {
    const todayDifference = Number(isToday(b?.created_at)) - Number(isToday(a?.created_at))
    if (todayDifference !== 0) return todayDifference
  }

  const priorityDifference = Number(a?.priority_order ?? 0) - Number(b?.priority_order ?? 0)
  if (priorityDifference !== 0) return priorityDifference

  const createdDifference = new Date(a?.created_at || 0).getTime() - new Date(b?.created_at || 0).getTime()
  return isToday(a?.created_at) ? -createdDifference : createdDifference
}

// Operational data must never cross a staff member's assigned branch. Branch
// lookup/assignment is always performed on the server, not trusted from UI data.
const BRANCH_SCOPED_TABLES = new Set([
  'orders', 'customers', 'inventory_items', 'inventory_usage_log',
  'inventory_restocks', 'expenses', 'payments',
  'order_items', 'service_inventory_requirements',
])

function restrictStaffBranchRequest(table, request, identity) {
  if (identity.role === 'admin') return request
  if (identity.role !== 'staff') throw Object.assign(new Error('This account has no staff profile. Contact an administrator to assign a role and branch.'), { status: 403 })
  if (!identity.staffId || !identity.branch) throw Object.assign(new Error(`Your staff account must be assigned to a branch before you can access ${table}.`), { status: 403 })

  const usesBranchId = ['order_items', 'service_inventory_requirements'].includes(table)
  const branchColumn = usesBranchId ? 'branch_id' : 'branch'
  const branchValue = usesBranchId ? identity.branchId : identity.branch
  const scoped = { ...request, filters: [...(request.filters || []), { type: 'eq', column: branchColumn, value: branchValue }] }
  const applyBranch = payload => ({
    ...payload,
    ...(usesBranchId ? {} : { branch: identity.branch }),
    ...(identity.branchId ? { branch_id: identity.branchId } : {}),
  })

  if (request.operation === 'insert') {
    const applyInsert = payload => ({
      ...applyBranch(payload),
      ...(['orders', 'customers'].includes(table) ? { created_by_staff_id: identity.staffId } : {}),
    })
    scoped.payload = Array.isArray(request.payload) ? request.payload.map(applyInsert) : applyInsert(request.payload || {})
  }
  if (request.operation === 'update') {
    const { created_by_staff_id, ...updates } = request.payload || {}
    scoped.payload = table === 'orders'
      ? { ...applyBranch(updates), last_updated_by_staff_id: identity.staffId }
      : applyBranch(updates)
  }
  return scoped
}

async function attachAdminBranch(table, request, identity) {
  if (!['insert', 'update'].includes(request.operation)) return request

  async function resolveBranch(payload) {
    // Payment/status-only updates retain the order's existing branch.
    if (!payload?.branch) {
      if (request.operation === 'insert') {
        throw Object.assign(new Error(`Administrators must assign a branch when creating ${table.replaceAll('_', ' ')} records.`), { status: 400 })
      }
      return table === 'orders' ? { ...payload, last_updated_by_staff_id: identity.staffId } : payload
    }
    const { data: branch, error } = await database.from('branches').select('id, name').eq('name', payload.branch).maybeSingle()
    if (error || !branch) throw Object.assign(new Error('The selected branch does not exist.'), { status: 400 })
    return { ...payload, branch: branch.name, branch_id: branch.id, ...(table === 'orders' && request.operation === 'update' ? { last_updated_by_staff_id: identity.staffId } : {}) }
  }

  const payload = Array.isArray(request.payload)
    ? await Promise.all(request.payload.map(resolveBranch))
    : await resolveBranch(request.payload || {})
  return { ...request, payload }
}

async function assertInventoryRecordOwnership(table, request, identity) {
  if (!['inventory_usage_log', 'inventory_restocks'].includes(table) || request.operation !== 'insert') return request
  const entries = Array.isArray(request.payload) ? request.payload : [request.payload]
  for (const entry of entries) {
    if (!entry?.item_id) throw Object.assign(new Error('An inventory item is required.'), { status: 400 })
    const { data: item, error } = await database.from('inventory_items').select('branch, branch_id').eq('id', entry.item_id).maybeSingle()
    if (error || !item) throw Object.assign(new Error('Inventory item not found.'), { status: 400 })
    if (identity.role !== 'admin' && item.branch_id !== identity.branchId) {
      throw Object.assign(new Error('You can only use inventory assigned to your branch.'), { status: 403 })
    }
  }
  return request
}

function assertNonNegativeNumber(value, label) {
  const number = Number(value)
  if (!Number.isFinite(number) || number < 0) throw Object.assign(new Error(`${label} must be a valid non-negative number.`), { status: 400 })
  return number
}

function validateResourcePayload(table, payload, operation) {
  const validateOne = entry => {
    const value = { ...(entry || {}) }
    const has = field => Object.hasOwn(value, field)
    const needs = field => operation === 'insert' || has(field)
    if (table === 'customers') {
      if (needs('name')) value.name = assertText(value.name, { label: 'Customer name', min: 2, max: 120 })
      if (needs('phone')) value.phone = assertPhilippineMobile(value.phone)
      if (has('email')) value.email = assertEmail(value.email, { label: 'Customer email' }) || null
      if (has('notes')) value.notes = assertText(value.notes, { label: 'Customer notes', max: 1_000, required: false }) || null
    }
    if (table === 'inventory_items') {
      if (needs('name')) value.name = assertText(value.name, { label: 'Item name', min: 2, max: 120 })
      if (needs('unit')) value.unit = assertText(value.unit, { label: 'Unit', min: 1, max: 20 })
      for (const field of ['current_stock', 'minimum_stock', 'cost_per_unit', 'usage_per_load']) if (has(field)) value[field] = assertNonNegativeNumber(value[field], field.replaceAll('_', ' '))
    }
    if (table === 'inventory_categories' && needs('name')) value.name = assertText(value.name, { label: 'Category name', min: 2, max: 80 })
    if (table === 'service_types') {
      if (needs('name')) value.name = assertText(value.name, { label: 'Service name', min: 2, max: 120 })
      if (has('price_per_kg')) value.price_per_kg = assertNonNegativeNumber(value.price_per_kg, 'Price per kilogram')
      if (has('unit_price')) value.unit_price = assertNonNegativeNumber(value.unit_price, 'Unit price')
      if (has('pricing_type') && !['bundle', 'per_kg', 'per_piece', 'fixed'].includes(value.pricing_type)) throw Object.assign(new Error('Select a valid pricing type.'), { status: 400 })
      if (has('processing_type') && !['full_service', 'air_dry_only'].includes(value.processing_type)) throw Object.assign(new Error('Select a valid processing type.'), { status: 400 })
      if (has('estimated_minutes')) {
        const minutes = assertNonNegativeNumber(value.estimated_minutes, 'Estimated minutes')
        if (!Number.isInteger(minutes) || minutes > 10_080) throw Object.assign(new Error('Estimated minutes must be a whole number up to 10,080.'), { status: 400 })
        value.estimated_minutes = minutes
      }
      if (has('description')) value.description = assertText(value.description, { label: 'Service description', max: 500, required: false }) || null
    }
    if (table === 'service_inventory_requirements') {
      if (!value.service_type_id || !value.inventory_item_id || !value.branch_id) throw Object.assign(new Error('Branch, service, and inventory item are required.'), { status: 400 })
      if (!['per_kg', 'per_piece', 'per_order'].includes(value.usage_basis)) throw Object.assign(new Error('Select a valid inventory usage basis.'), { status: 400 })
      value.quantity_per_unit = assertNonNegativeNumber(value.quantity_per_unit, 'Quantity per unit')
      if (value.quantity_per_unit <= 0) throw Object.assign(new Error('Quantity per unit must be greater than zero.'), { status: 400 })
    }
    if (table === 'expenses') {
      if (needs('category')) value.category = assertText(value.category, { label: 'Expense category', min: 2, max: 80 })
      if (needs('amount')) value.amount = assertNonNegativeNumber(value.amount, 'Expense amount')
      if (has('description')) value.description = assertText(value.description, { label: 'Expense description', max: 500, required: false }) || null
    }
    if (table === 'branches') {
      if (needs('name')) value.name = assertText(value.name, { label: 'Branch name', min: 2, max: 120 })
      if (has('phone') && value.phone) value.phone = assertPhilippineMobile(value.phone)
      if (has('address')) value.address = assertText(value.address, { label: 'Address', max: 240, required: false }) || null
    }
    if (table === 'orders') {
      if (has('weight_kg')) {
        const weight = Number(value.weight_kg)
        if (!Number.isFinite(weight) || weight <= 0) throw Object.assign(new Error('Order weight must be greater than zero.'), { status: 400 })
        value.weight_kg = weight
      }
      if (has('notes')) value.notes = assertText(value.notes, { label: 'Order notes', max: 1_000, required: false }) || null
    }
    return value
  }
  return Array.isArray(payload) ? payload.map(validateOne) : validateOne(payload)
}

export async function execute(table, request, identity) {
  if (!TABLES.has(table)) throw Object.assign(new Error('Unknown resource'), { status: 404 })
  if (table === 'staff' && request.operation === 'delete' && identity.role !== 'admin') {
    throw Object.assign(new Error('Only administrators can delete accounts.'), { status: 403 })
  }
  if (table === 'settings' && request.operation !== 'select' && identity.role !== 'admin') {
    throw Object.assign(new Error('Only administrators can change business settings.'), { status: 403 })
  }
  if (['service_types', 'service_inventory_requirements'].includes(table) && request.operation !== 'select' && identity.role !== 'admin') {
    throw Object.assign(new Error('Only administrators can change service configuration.'), { status: 403 })
  }
  if (table === 'order_items' && request.operation !== 'select') {
    throw Object.assign(new Error('Order service items can only be changed through the secure order workflow.'), { status: 403 })
  }
  if (table === 'staff' && ['insert', 'update'].includes(request.operation)) {
    throw Object.assign(new Error('Staff accounts can only be created or changed through the secure staff-provisioning workflow.'), { status: 403 })
  }
  if (SOFT_DELETABLE_TABLES.has(table) && ['insert', 'update'].includes(request.operation)) {
    const entries = Array.isArray(request.payload) ? request.payload : [request.payload || {}]
    if (entries.some(entry => Object.hasOwn(entry, 'deleted_at') || Object.hasOwn(entry, 'deleted_by_staff_id'))) {
      throw Object.assign(new Error('Deletion fields can only be changed through the secure Recycle Bin workflow.'), { status: 403 })
    }
  }
  if (table === 'orders' && request.operation === 'update' && Object.hasOwn(request.payload || {}, 'status')) {
    throw Object.assign(new Error('Order stages can only be changed through the secure workflow.'), { status: 403 })
  }
  if (table === 'orders' && request.operation === 'update') {
    const protectedPaymentFields = ['amount_paid', 'payment_status', 'payment_method', 'loyalty_reward_id', 'loyalty_original_total', 'loyalty_discount_amount']
    if (protectedPaymentFields.some(field => Object.hasOwn(request.payload || {}, field))) {
      throw Object.assign(new Error('Payment details cannot be edited after an order is placed. Use the secure payment-and-release workflow.'), { status: 403 })
    }
  }
  if (table === 'payments' && request.operation !== 'select') {
    throw Object.assign(new Error('Payments can only be recorded through the secure collection workflow.'), { status: 403 })
  }
  if (BRANCH_SCOPED_TABLES.has(table)) {
    request = identity.role === 'admin'
      ? await attachAdminBranch(table, request, identity)
      : restrictStaffBranchRequest(table, request, identity)
    request = await assertInventoryRecordOwnership(table, request, identity)
  }
  if (['insert', 'update'].includes(request.operation)) {
    request = { ...request, payload: validateResourcePayload(table, request.payload, request.operation) }
  }
  const { operation, selection = '*', filters, orders = [], range, limit, payload, count, single, returning } = request
  if (operation === 'delete' && PROTECTED_TRANSACTION_TABLES.has(table)) {
    throw Object.assign(new Error('This transaction record cannot be deleted. Use the appropriate cancellation or correction workflow so the audit trail and inventory history remain accurate.'), { status: 400 })
  }
  if (operation === 'delete' && SOFT_DELETABLE_TABLES.has(table)) {
    const existing = await applyFilters(database.from(table).select('*'), filters)
    if (existing.error) return { data: null, error: existing.error, count: null }
    if (!existing.data?.length) return { data: [], error: null, count: 0 }

    let archiveQuery = database.from(table).update({
      deleted_at: new Date().toISOString(),
      deleted_by_staff_id: identity.staffId || null,
    }).select('*')
    archiveQuery = applyFilters(archiveQuery, filters)
    const archived = await archiveQuery
    if (archived.error) return { data: null, error: archived.error, count: null }

    const audit = await database.from('audit_logs').insert(existing.data.map((before, index) => ({
      action: 'delete', table_name: table, record_id: before.id,
      actor_staff_id: identity.staffId || null, branch_id: before.branch_id || null,
      before_data: before, after_data: archived.data?.[index] || null,
    })))
    if (audit.error) return { data: null, error: audit.error, count: null }
    return { data: archived.data || [], error: null, count: archived.data?.length || 0 }
  }
  let query = database.from(table)
  // Supabase's order() cannot express a portable CASE status priority. Fetch
  // the filtered order set, sort it once here, then apply pagination below.
  const sortOrderListInMemory = table === 'orders' && operation === 'select' && !single

  if (operation === 'select') {
    query = query.select(selection, count ? { count } : undefined)
    if (SOFT_DELETABLE_TABLES.has(table)) query = query.is('deleted_at', null)
  }
  if (operation === 'insert') query = query.insert(payload)
  if (operation === 'update') query = query.update(payload)
  if (operation === 'delete') query = query.delete()
  query = applyFilters(query, filters)
  if (operation !== 'select' && returning) query = query.select(selection)
  if (!sortOrderListInMemory) orders.forEach(({ column, options }) => { query = query.order(column, options) })
  if (range && !sortOrderListInMemory) query = query.range(range.from, range.to)
  if (limit && !sortOrderListInMemory) query = query.limit(limit)
  if (single === 'single') query = query.single()
  if (single === 'maybeSingle') query = query.maybeSingle()

  const result = await query
  if (sortOrderListInMemory && !result.error && Array.isArray(result.data)) {
    const sorted = [...result.data].sort(compareOrdersForList)
    if (range) result.data = sorted.slice(range.from, range.to + 1)
    else if (limit) result.data = sorted.slice(0, limit)
    else result.data = sorted
  }
  return { data: result.data, error: result.error, count: result.count }
}

export async function getStaffProfile(authId, email) {
  const selection = 'id, role, full_name, branch, branch_id, must_change_password'
  const profile = await database.from('staff').select(selection).eq('auth_id', authId).is('deleted_at', null).maybeSingle()
  if (profile.data || profile.error || !email) return profile

  // Repair legacy staff rows created before auth_id was stored.
  const legacy = await database.from('staff').select(selection).eq('email', email).is('auth_id', null).is('deleted_at', null).maybeSingle()
  if (!legacy.data || legacy.error) return profile
  return database.from('staff').update({ auth_id: authId }).eq('id', legacy.data.id).is('auth_id', null).select(selection).maybeSingle()
}
