import { database } from '../config/supabase.js'
import { assertEmail, assertPhilippineMobile, assertText } from '../utils/validation.js'

// This is intentionally a whitelist: it preserves existing Supabase query shapes
// while preventing the browser from selecting arbitrary database tables.
export const TABLES = new Set([
  'customers', 'orders', 'inventory_items', 'inventory_categories',
  'inventory_usage_log', 'inventory_restocks', 'expenses', 'staff',
  'settings', 'service_types', 'sms_log', 'branches', 'payments', 'ai_forecasts',
  'order_items', 'order_item_addons', 'service_inventory_requirements', 'service_addon_items',
])

// These reference/operational records can be hidden and later restored.
// Transaction and inventory-ledger records are deliberately excluded.
const SOFT_DELETABLE_TABLES = new Set([
  'customers', 'staff', 'inventory_items', 'inventory_categories',
  'service_types', 'expenses',
])
const PROTECTED_TRANSACTION_TABLES = new Set([
  'orders', 'payments', 'inventory_usage_log', 'inventory_restocks', 'sms_log',
  'order_items', 'order_item_addons',
])
const WORKFLOW_CREATED_TABLES = new Set([
  'orders', 'inventory_items', 'inventory_restocks', 'inventory_usage_log',
])

// Cross-branch reference and reporting data. Staff screens never use these
// tables directly; inventory category names reach staff only through an
// embedded `inventory_categories(name)` on their branch-scoped inventory.
const ADMIN_ONLY_TABLES = new Set(['inventory_categories', 'ai_forecasts', 'sms_log'])
// Staff profiles and admin-only tables must not be reachable by embedding them
// in another table's selection, e.g. `orders` with `*, creator:staff(*)`.
const RESTRICTED_EMBED_PATTERN = /(?:^|[\s,(:])(?:staff|sms_log|ai_forecasts)\s*[(!]/
// The only related records the app's screens embed. Each reaches a parent or
// child of a row already limited to the staff member's branch. Any other embed
// could reach another branch's records through a shared parent such as
// `branches`, or staff profiles through a spread (`...staff!fk(...)`) or a
// foreign-key column (`created_by_staff_id(...)`), so staff selections are
// limited to these.
const STAFF_EMBEDS = {
  orders: new Set(['customers', 'service_types', 'order_items']),
  order_items: new Set(['orders']),
  payments: new Set(['orders']),
  inventory_items: new Set(['inventory_categories']),
  service_addon_items: new Set(['inventory_items']),
}

// Splits one level of a PostgREST select list into its items, keeping each
// embedded resource's own select list intact.
function selectionItems(selection) {
  const items = []
  let depth = 0
  let current = ''
  for (const character of selection) {
    if (character === '(') depth += 1
    if (character === ')') depth -= 1
    if (depth < 0) return null
    if (character === ',' && depth === 0) {
      items.push(current.trim())
      current = ''
    } else {
      current += character
    }
  }
  if (depth !== 0) return null
  if (current.trim()) items.push(current.trim())
  return items
}

function isAllowedStaffSelection(table, selection) {
  const items = selectionItems(selection)
  if (!items) return false
  return items.every(item => {
    const open = item.indexOf('(')
    if (open === -1) return true
    if (!item.endsWith(')')) return false
    const head = item.slice(0, open).trim()
    // An optional `alias:` prefix, the related table's plain name, and an
    // optional `!inner`; foreign-key hints and spreads never match.
    const name = head.includes('::') ? head : head.slice(head.lastIndexOf(':') + 1).trim()
    const target = name.replace(/!inner$/, '')
    if (!STAFF_EMBEDS[table]?.has(target)) return false
    return isAllowedStaffSelection(target, item.slice(open + 1, -1))
  })
}

// Supabase returns at most "Max rows" per request (1000 by default, in the
// project's API settings) and silently drops the rest. Reads that ask for
// every matching row are fetched page by page so a growing history is never
// cut short. READ_PAGE_SIZE must not exceed the project's Max rows setting.
const READ_PAGE_SIZE = 1000
const READ_CONCURRENCY = 6

// `buildQuery({ from, to, count, head, stableOrder })` must return a fresh
// select query. A result smaller than one page is returned exactly as before,
// at the same cost. A full first page means more rows may follow: they are
// counted, then every page is re-read with `id` as the final sort key (so
// pages neither overlap nor skip rows) and joined back together.
// `rowOrderIsFree` marks a read whose rows are re-sorted afterwards, so its
// first page can already use the stable order and does not need re-reading.
async function selectEveryRow(buildQuery, requestedCount, { rowOrderIsFree = false } = {}) {
  const first = await buildQuery({ from: 0, to: READ_PAGE_SIZE - 1, count: requestedCount, stableOrder: rowOrderIsFree })
  if (first.error || (first.data || []).length < READ_PAGE_SIZE) {
    return { data: first.data, error: first.error, count: first.count ?? null }
  }

  const readPage = index => buildQuery({ from: index * READ_PAGE_SIZE, to: (index + 1) * READ_PAGE_SIZE - 1, stableOrder: true })
  // Start the opening stable pages while the rows are being counted.
  const [counted, ...openingPages] = await Promise.all([
    requestedCount ? first : buildQuery({ count: 'exact', head: true }),
    rowOrderIsFree ? first : readPage(0),
    readPage(1),
  ])
  if (counted.error) return { data: null, error: counted.error, count: null }
  const total = Number(counted.count)

  const pageCount = Number.isFinite(total) ? Math.max(Math.ceil(total / READ_PAGE_SIZE), openingPages.length) : openingPages.length
  const pages = [...openingPages, ...new Array(pageCount - openingPages.length)]
  let nextPage = openingPages.length
  async function readPages() {
    while (nextPage < pageCount) {
      const index = nextPage++
      pages[index] = await readPage(index)
    }
  }
  await Promise.all(Array.from({ length: Math.min(READ_CONCURRENCY, pageCount - openingPages.length) }, readPages))
  // Rows saved after the count can extend the set past the last planned page.
  while (!pages.at(-1).error && (pages.at(-1).data || []).length === READ_PAGE_SIZE) {
    pages.push(await readPage(pages.length))
  }
  const failed = pages.find(page => page.error)
  if (failed) return { data: null, error: failed.error, count: null }

  // A row saved while the pages were being read can shift into the next page.
  const seen = new Set()
  const data = pages.flatMap(page => page.data || []).filter(row => {
    if (row?.id === undefined || row?.id === null) return true
    if (seen.has(row.id)) return false
    seen.add(row.id)
    return true
  })
  return { data, error: null, count: requestedCount ? total : null }
}

function hasRecordIdFilter(filters = []) {
  return filters.some(({ type, column, value }) => type === 'eq' && column === 'id' && value !== undefined && value !== null && value !== '')
}

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
  'order_items', 'order_item_addons', 'service_inventory_requirements', 'service_addon_items',
])

function restrictStaffBranchRequest(table, request, identity) {
  if (identity.role === 'admin') return request
  if (identity.role !== 'staff') throw Object.assign(new Error('This account has no staff profile. Contact an administrator to assign a role and branch.'), { status: 403 })
  if (!identity.staffId || !identity.branch) throw Object.assign(new Error(`Your staff account must be assigned to a branch before you can access ${table}.`), { status: 403 })

  const usesBranchId = ['order_items', 'order_item_addons', 'service_inventory_requirements', 'service_addon_items'].includes(table)
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
    const branchIdOnly = ['order_items', 'order_item_addons', 'service_inventory_requirements', 'service_addon_items'].includes(table)
    if (branchIdOnly && payload?.branch_id) {
      const { data: branch, error } = await database.from('branches').select('id').eq('id', payload.branch_id).maybeSingle()
      if (error || !branch) throw Object.assign(new Error('The selected branch does not exist.'), { status: 400 })
      return payload
    }
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
      if (needs('email')) value.email = assertEmail(value.email, { label: 'Customer email' }) || null
    }
    if (table === 'inventory_items') {
      if (needs('name')) value.name = assertText(value.name, { label: 'Item name', min: 2, max: 120 })
      if (needs('unit')) value.unit = assertText(value.unit, { label: 'Unit', min: 1, max: 20 })
      for (const field of ['current_stock', 'minimum_stock', 'cost_per_unit']) if (has(field)) value[field] = assertNonNegativeNumber(value[field], field.replaceAll('_', ' '))
    }
    if (table === 'inventory_categories' && needs('name')) value.name = assertText(value.name, { label: 'Category name', min: 2, max: 80 })
    if (table === 'service_types') {
      if (needs('name')) value.name = assertText(value.name, { label: 'Service name', min: 2, max: 120 })
      if (has('price_per_kg')) value.price_per_kg = assertNonNegativeNumber(value.price_per_kg, 'Price per kilogram')
      if (has('bundle_kg')) {
        value.bundle_kg = assertNonNegativeNumber(value.bundle_kg, 'Kilograms per load')
        if (value.bundle_kg <= 0) throw Object.assign(new Error('Kilograms per load must be greater than zero.'), { status: 400 })
      }
      if (has('bundle_price')) value.bundle_price = assertNonNegativeNumber(value.bundle_price, 'Price per load')
      if (has('excess_kg_price')) value.excess_kg_price = assertNonNegativeNumber(value.excess_kg_price, 'Excess kilogram price')
      if (has('processing_type') && !['full_service', 'air_dry_only'].includes(value.processing_type)) throw Object.assign(new Error('Select a valid processing type.'), { status: 400 })
      if (has('estimated_minutes')) {
        const minutes = assertNonNegativeNumber(value.estimated_minutes, 'Estimated minutes')
        if (!Number.isInteger(minutes) || minutes > 10_080) throw Object.assign(new Error('Estimated minutes must be a whole number up to 10,080.'), { status: 400 })
        value.estimated_minutes = minutes
      }
      if (has('description')) value.description = assertText(value.description, { label: 'Service description', max: 500, required: false }) || null
    }
    if (table === 'service_inventory_requirements') {
      if (operation === 'insert' && (!value.service_type_id || !value.inventory_item_id || !value.branch_id)) throw Object.assign(new Error('Branch, service, and inventory item are required.'), { status: 400 })
      if (has('quantity_per_load')) {
        value.quantity_per_load = assertNonNegativeNumber(value.quantity_per_load, 'Quantity per load')
        if (value.quantity_per_load <= 0) throw Object.assign(new Error('Quantity per load must be greater than zero.'), { status: 400 })
      }
    }
    if (table === 'service_addon_items') {
      if (operation === 'insert' && (!value.service_type_id || !value.inventory_item_id || !value.branch_id)) throw Object.assign(new Error('Branch, service, and inventory item are required.'), { status: 400 })
      if (has('unit_price')) value.unit_price = assertNonNegativeNumber(value.unit_price, 'Add-on unit price')
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
    }
    return value
  }
  return Array.isArray(payload) ? payload.map(validateOne) : validateOne(payload)
}

export async function execute(table, request, identity) {
  if (!TABLES.has(table)) throw Object.assign(new Error('Unknown resource'), { status: 404 })
  // An update or delete without a record id would apply to every matching row
  // in the table (or the whole branch for staff). The app always edits one record.
  if (['update', 'delete'].includes(request.operation) && !hasRecordIdFilter(request.filters)) {
    throw Object.assign(new Error('Updates and deletions must target a specific record.'), { status: 400 })
  }
  if (identity.role !== 'admin') {
    if (ADMIN_ONLY_TABLES.has(table)) throw Object.assign(new Error('Administrator access required'), { status: 403 })
    if (table === 'branches' && request.operation !== 'select') {
      throw Object.assign(new Error('Only administrators can change branches.'), { status: 403 })
    }
    if (RESTRICTED_EMBED_PATTERN.test(String(request.selection || ''))) {
      throw Object.assign(new Error('Staff profiles can only be read by administrators.'), { status: 403 })
    }
    if (!isAllowedStaffSelection(table, String(request.selection || '*'))) {
      throw Object.assign(new Error('This selection is not available to staff accounts.'), { status: 403 })
    }
    // Staff may read only their own profile; the full directory is administrative.
    if (table === 'staff' && request.operation === 'select') {
      if (!identity.staffId) throw Object.assign(new Error('An active staff account is required.'), { status: 403 })
      request = { ...request, filters: [...(request.filters || []), { type: 'eq', column: 'id', value: identity.staffId }] }
    }
  }
  if (table === 'staff' && request.operation === 'delete' && identity.role !== 'admin') {
    throw Object.assign(new Error('Only administrators can delete accounts.'), { status: 403 })
  }
  if (table === 'settings' && request.operation !== 'select' && identity.role !== 'admin') {
    throw Object.assign(new Error('Only administrators can change business settings.'), { status: 403 })
  }
  if (['service_types', 'service_inventory_requirements', 'service_addon_items'].includes(table) && request.operation !== 'select' && identity.role !== 'admin') {
    throw Object.assign(new Error('Only administrators can change service configuration.'), { status: 403 })
  }
  if (['order_items', 'order_item_addons'].includes(table) && request.operation !== 'select') {
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
    throw Object.assign(new Error('Placed order details are locked; use the secure payment, stage, or cancellation workflow.'), { status: 403 })
  }
  if (table === 'customers' && request.operation === 'update' && identity.role !== 'admin') {
    const updates = Array.isArray(request.payload) ? request.payload : [request.payload || {}]
    if (updates.some(entry => Object.hasOwn(entry, 'phone') || Object.hasOwn(entry, 'email'))) {
      throw Object.assign(new Error('Only administrators can change a customer phone number or email address.'), { status: 403 })
    }
  }
  if (table === 'inventory_items' && request.operation === 'update') {
    const updates = request.payload || {}
    if (Object.hasOwn(updates, 'current_stock')) {
      throw Object.assign(new Error('Current stock cannot be edited directly. Use the Restock workflow or an audited inventory operation.'), { status: 403 })
    }
    if (['branch', 'branch_id', 'unit'].some(field => Object.hasOwn(updates, field))) {
      throw Object.assign(new Error('An inventory item\'s branch and unit are locked after creation so its usage history remains consistent.'), { status: 403 })
    }
  }
  if (table === 'payments' && request.operation !== 'select') {
    throw Object.assign(new Error('Payments can only be recorded through the secure collection workflow.'), { status: 403 })
  }
  // Orders and inventory records are created only by their secure workflows
  // (order creation, inventory creation, restocking and order processing),
  // which keep pricing, stock levels and history consistent. The app never
  // inserts them through this endpoint.
  if (WORKFLOW_CREATED_TABLES.has(table) && request.operation === 'insert') {
    throw Object.assign(new Error('These records can only be created through their secure workflow.'), { status: 403 })
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
  const { operation, selection = '*', filters, orders = [], range, limit, payload, count, head, single, returning } = request
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
  // Supabase's order() cannot express a portable CASE status priority. Fetch
  // the filtered order set, sort it once here, then apply pagination below.
  const sortOrderListInMemory = table === 'orders' && operation === 'select' && !single && !head

  // A read without its own range or limit means "every matching row" (the
  // in-memory order sort also needs the whole set), so read it in pages.
  if (operation === 'select' && !single && !head && (sortOrderListInMemory || (!range && !limit))) {
    const result = await selectEveryRow(({ from, to, count: countMode, head: countOnly, stableOrder }) => {
      let page = database.from(table).select(selection, countMode ? { count: countMode, head: countOnly } : undefined)
      if (SOFT_DELETABLE_TABLES.has(table)) page = page.is('deleted_at', null)
      page = applyFilters(page, filters)
      if (countOnly) return page
      if (!sortOrderListInMemory) orders.forEach(({ column, options }) => { page = page.order(column, options) })
      if (stableOrder) page = page.order('id', { ascending: true })
      return page.range(from, to)
    }, count, { rowOrderIsFree: sortOrderListInMemory })
    if (sortOrderListInMemory && !result.error && Array.isArray(result.data)) {
      const sorted = [...result.data].sort(compareOrdersForList)
      if (range) result.data = sorted.slice(range.from, range.to + 1)
      else if (limit) result.data = sorted.slice(0, limit)
      else result.data = sorted
    }
    return result
  }

  let query = database.from(table)
  if (operation === 'select') {
    // `head` returns only the count, without downloading any rows.
    query = query.select(selection, count || head ? { count, head } : undefined)
    if (SOFT_DELETABLE_TABLES.has(table)) query = query.is('deleted_at', null)
  }
  if (operation === 'insert') query = query.insert(payload)
  if (operation === 'update') query = query.update(payload)
  if (operation === 'delete') query = query.delete()
  query = applyFilters(query, filters)
  if (operation !== 'select' && returning) query = query.select(selection)
  orders.forEach(({ column, options }) => { query = query.order(column, options) })
  if (range) query = query.range(range.from, range.to)
  if (limit) query = query.limit(limit)
  if (single === 'single') query = query.single()
  if (single === 'maybeSingle') query = query.maybeSingle()

  const result = await query
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
