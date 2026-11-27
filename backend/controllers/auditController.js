import { database } from '../config/supabase.js'
import { assertUniqueInventoryName, assertUniqueServiceName } from '../utils/recordRules.js'

const RESTORABLE_TABLES = new Set(['customers', 'staff', 'inventory_items', 'inventory_categories', 'service_types', 'expenses'])
const AUDIT_PAGE_SIZE = 25
const AUDIT_MAX_PAGE_SIZE = 100
const requireAdmin = identity => {
  if (identity.role !== 'admin') throw Object.assign(new Error('Administrator access required.'), { status: 403 })
}

const titleCase = value => String(value || '').replaceAll('_', ' ').replace(/\b\w/g, letter => letter.toUpperCase())
const valueLabel = value => value === null || value === undefined || value === '' ? 'not set' : titleCase(value)
const capitalize = text => text ? text.charAt(0).toUpperCase() + text.slice(1) : text
const amount = value => Number(value || 0).toLocaleString('en-PH', { maximumFractionDigits: 2 })
const TABLE_LABELS = {
  order_item_addons: 'Order add-on', service_addon_items: 'Add-on setting',
  service_inventory_requirements: 'Automatic deduction setting', inventory_usage_log: 'Stock usage',
  inventory_restocks: 'Restock', inventory_adjustments: 'Stock correction', settings: 'Business settings',
  inventory_categories: 'Inventory category', loyalty_rewards: 'Loyalty reward', payments: 'Payment',
  order_refunds: 'Refund', branches: 'Branch', service_supply_replacements: 'Supply replacement setting',
}
const orderLabel = log => log.order_number ? `order ${log.order_number}` : 'an order'
const recordLabel = log => {
  const row = log.after_data || log.before_data || {}
  if (log.table_name === 'orders') return row.order_number ? `order ${row.order_number}` : 'an order'
  if (log.table_name === 'order_items') {
    const weight = Number(row.weight_kg) > 0 ? ` (${amount(row.weight_kg)} kg)` : ''
    return `${row.service_name_snapshot || 'A service'}${weight}`
  }
  return row.full_name || row.name || row.description || TABLE_LABELS[log.table_name] || `${titleCase(log.table_name)} record`
}
const IGNORED_FIELDS = ['created_at', 'updated_at', 'last_updated_by_staff_id', 'created_by_staff_id']
const changedFieldNames = log => Object.keys(log.changed_fields || {}).filter(field => !IGNORED_FIELDS.includes(field))
const withOrderBranch = (log, text) => {
  if (log.table_name !== 'orders') return text
  const row = log.after_data || log.before_data || {}
  const branch = log.branch?.name || row.branch || ''
  return branch ? text.replace(/\.$/, ` at ${branch}.`) : text
}

const peso = value => `₱${Number(value || 0).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
// One supply change in words, for example "Ariel → Tide (+₱20.00)".
function supplyChangeText(change) {
  const used = change.choice === 'substitute' ? change.used_item || 'another item'
    : change.choice === 'customer_own' ? "customer's own" : 'left out'
  const charge = Number(change.extra_charge) > 0 ? ` (+${peso(change.extra_charge)})` : ''
  return `${change.usual_item || 'A supply'} → ${used}${charge}`
}
// What was used for one usual supply, for example "Tide (+₱20.00)".
function supplyUsedText(change) {
  if (!change) return "the shop's usual"
  const used = change.choice === 'substitute' ? change.used_item || 'another item'
    : change.choice === 'customer_own' ? "customer's own" : 'left out'
  return Number(change.extra_charge) > 0 ? `${used} (+${peso(change.extra_charge)})` : used
}
// "Powder Detergent from Tide (+₱20.00) to Liquid Detergent" for each supply
// whose choice differs between the old and the new supplies.
function supplyEditText(beforeChanges, afterChanges) {
  const byItem = list => new Map(list.map(change => [change.usual_item || 'A supply', change]))
  const before = byItem(beforeChanges), after = byItem(afterChanges)
  return [...new Set([...before.keys(), ...after.keys()])]
    .map(item => ({ item, from: supplyUsedText(before.get(item)), to: supplyUsedText(after.get(item)) }))
    .filter(({ from, to }) => from !== to)
    .map(({ item, from, to }) => `${item} from ${from} to ${to}`)
}
function describeSupplyChanges(log, after) {
  const order = after.order_number ? `order ${after.order_number}` : orderLabel(log)
  const branch = log.branch?.name ? ` at ${log.branch.name}` : ''
  const changes = Array.isArray(after.changes) ? after.changes : []
  if (log.action === 'update') {
    const service = after.service ? ` for ${after.service}` : ''
    const previous = log.before_data?.changes
    if (Array.isArray(previous)) {
      const edits = supplyEditText(previous, changes)
      return edits.length
        ? `Supplies${service} on ${order}${branch} were changed: ${edits.join('; ')}.`
        : `Supplies${service} on ${order}${branch} were saved without a change.`
    }
    return changes.length
      ? `Supplies${service} on ${order}${branch} were changed to: ${changes.map(supplyChangeText).join('; ')}.`
      : `Supplies${service} on ${order}${branch} were changed back to the shop's usual supplies.`
  }
  return `Supplies changed for the customer on ${order}${branch}: ${changes.map(supplyChangeText).join('; ')}.`
}

function describe(log) {
  const before = log.before_data || {}
  const after = log.after_data || {}
  const record = recordLabel(log)
  if (log.event_type === 'order_supplies_changed') return describeSupplyChanges(log, after)
  if (log.action === 'delete') return withOrderBranch(log, `${record} was archived.`)
  if (log.action === 'restore') return withOrderBranch(log, `${record} was restored to the active system.`)
  if (log.action === 'cancel') {
    const reason = log.reason || after.cancellation_reason || before.cancellation_reason
    const reasonText = reason ? `: ${String(reason).replace(/\.$/, '')}.` : '.'
    return withOrderBranch(log, `${record} was cancelled${reasonText}`)
  }
  if (log.action === 'password_changed') return 'A staff password was changed.'
  if (log.action === 'email_changed') return 'A staff recovery email was changed.'
  if (log.action === 'credentials_reset') return `Temporary credentials were reset for ${record}.`
  if (log.action === 'provision') return `A new staff account was created for ${record}.`
  const fields = changedFieldNames(log)
  if (log.table_name === 'order_items') {
    if (log.action === 'insert') return `${record} was added to ${orderLabel(log)}.`
    if (before.status !== after.status) return `${record} on ${orderLabel(log)} moved from ${valueLabel(before.status)} to ${valueLabel(after.status)}.`
    return fields.length ? `${record} on ${orderLabel(log)} was updated: ${fields.map(titleCase).join(', ')}.` : `${record} on ${orderLabel(log)} was updated.`
  }
  // A new order is created, not moved from "not set" into its first stage.
  if (log.action === 'insert') return withOrderBranch(log, `${record} was created.`)
  if (log.action === 'order_transition' || (log.table_name === 'orders' && before.status !== after.status)) {
    return withOrderBranch(log, `${record} status changed from ${valueLabel(before.status)} to ${valueLabel(after.status)}.`)
  }
  if (log.action === 'payment_collected') {
    return withOrderBranch(log, `${record} payment changed from ₱${Number(before.amount_paid || 0).toLocaleString()} to ₱${Number(after.amount_paid || 0).toLocaleString()}.`)
  }
  if (log.action === 'inventory_restock') return 'An inventory restock was recorded.'
  if (log.action === 'inventory_adjustment') return 'An inventory adjustment was recorded.'
  if (log.table_name === 'inventory_items' && fields.length && fields.every(field => field === 'current_stock')) {
    const unit = after.unit || before.unit || ''
    return `${record} stock changed from ${amount(before.current_stock)} to ${amount(after.current_stock)}${unit ? ` ${unit}` : ''}.`
  }
  return withOrderBranch(log, fields.length ? `${record} was updated: ${fields.map(titleCase).join(', ')}.` : `${record} was updated.`)
}

export function describeAuditEvent(log) {
  return capitalize(describe(log))
}

// Service lines are saved with the order's id; the Audit Log names the order.
async function orderNumbersFor(logs) {
  const ids = [...new Set(logs.filter(log => ['order_items', 'order_item_addons'].includes(log.table_name))
    .map(log => log.after_data?.order_id || log.before_data?.order_id).filter(Boolean))]
  if (!ids.length) return new Map()
  const { data, error } = await database.from('orders').select('id, order_number').in('id', ids)
  if (error) return new Map()
  return new Map((data || []).map(order => [order.id, order.order_number]))
}

export async function listAuditLog(identity, { page = 1, pageSize = AUDIT_PAGE_SIZE, direction = 'desc', type = '' } = {}) {
  requireAdmin(identity)
  const safePage = Math.max(1, Number.parseInt(page, 10) || 1)
  const safePageSize = Math.min(AUDIT_MAX_PAGE_SIZE, Math.max(1, Number.parseInt(pageSize, 10) || AUDIT_PAGE_SIZE))
  const results = await Promise.all([...RESTORABLE_TABLES].map(async table => {
    const { data, error } = await database.from(table).select('*').not('deleted_at', 'is', null).order('deleted_at', { ascending: false })
    if (error) throw Object.assign(new Error(error.message), { status: 400, details: error })
    return (data || []).map(record => ({ ...record, table_name: table }))
  }))
  const from = (safePage - 1) * safePageSize
  // The database records every staff-table change but cannot see who made it;
  // each of those changes also has an application entry that names the
  // administrator. Only that one is listed, so a change does not appear twice.
  let logQuery = database.from('audit_logs')
    .select('id, action, event_type, event_category, table_name, record_id, branch_id, created_at, actor_staff_id, changed_fields, reason, source, before_data, after_data, staff:actor_staff_id(full_name), branch:branch_id(name)', { count: 'exact' })
    .or('table_name.neq.staff,source.neq.database_trigger,actor_staff_id.not.is.null')
  // "Supply changes" lists only the supply changes made on orders.
  if (type === 'supply_changes') logQuery = logQuery.eq('event_type', 'order_supplies_changed')
  const { data: logs, error: logError, count } = await logQuery
    .order('created_at', { ascending: direction === 'asc' }).range(from, from + safePageSize - 1)
  if (logError) throw Object.assign(new Error(logError.message), { status: 400, details: logError })
  const orderNumbers = await orderNumbersFor(logs || [])
  const items = (logs || []).map(({ before_data, after_data, ...log }) => {
    const order_number = orderNumbers.get(after_data?.order_id || before_data?.order_id) || null
    return { ...log, description: describeAuditEvent({ ...log, order_number, before_data, after_data }) }
  })
  const total = Number.isFinite(count) ? count : items.length
  return {
    records: results.flat().sort((a, b) => new Date(b.deleted_at) - new Date(a.deleted_at)),
    audit: { items, page: safePage, pageSize: safePageSize, total, totalPages: Math.max(1, Math.ceil(total / safePageSize)) },
  }
}

// Kept temporarily for existing tests and callers that still use the old name.
export const listRecycleBin = listAuditLog

export async function restoreRecord(body, identity) {
  requireAdmin(identity)
  const table = body?.table
  const id = body?.id
  if (!RESTORABLE_TABLES.has(table) || !id) throw Object.assign(new Error('A valid deleted record is required.'), { status: 400 })
  const { data: before, error: findError } = await database.from(table).select('*').eq('id', id).not('deleted_at', 'is', null).maybeSingle()
  if (findError || !before) throw Object.assign(new Error('Deleted record not found.'), { status: 404, details: findError })
  // An archived customer's number can be given to a new customer, so a restore
  // must not create two active customers with the same phone.
  if (table === 'customers' && before.phone) {
    const { data: holder, error: holderError } = await database.from('customers')
      .select('id, name').eq('phone', before.phone).is('deleted_at', null).neq('id', id).limit(1)
    if (holderError) throw Object.assign(new Error(holderError.message), { status: 400, details: holderError })
    if (holder?.length) {
      throw Object.assign(new Error(`This customer cannot be restored because ${holder[0].name} now uses the phone number ${before.phone}.`), { status: 409 })
    }
  }
  // A new item or service may have been added with the same name meanwhile.
  if (table === 'inventory_items') {
    await assertUniqueInventoryName(database, { name: before.name, branchId: before.branch_id, branchName: before.branch, exceptId: id })
      .catch(error => { throw Object.assign(new Error(`This item cannot be restored because ${before.branch || 'its branch'} already has an active item named "${before.name}".`), { status: error.status || 409 }) })
  }
  if (table === 'service_types') {
    await assertUniqueServiceName(database, { name: before.name, exceptId: id })
      .catch(error => { throw Object.assign(new Error(`This service cannot be restored because an active service is already named "${before.name}".`), { status: error.status || 409 }) })
  }
  // Another active account may have taken a deleted account's recovery email.
  // Restore the account without it rather than leave two accounts sharing one
  // ("Forgot password" refuses an address two accounts share).
  const changes = { deleted_at: null, deleted_by_staff_id: null }
  let notice = null
  if (table === 'staff' && before.contact_email) {
    const literal = before.contact_email.replace(/[\\%_]/g, character => `\\${character}`)
    for (const column of ['contact_email', 'email']) {
      const { data: owners, error: ownerError } = await database.from('staff').select('id, full_name').is('deleted_at', null).ilike(column, literal).limit(5)
      if (ownerError) throw Object.assign(new Error('Unable to check the account’s recovery email.'), { status: 400, details: ownerError })
      const owner = (owners || []).find(account => account.id !== id)
      if (owner) {
        changes.contact_email = null
        notice = `${before.full_name} was restored without a recovery email, because ${owner.full_name} now uses ${before.contact_email}. Add a new recovery email on the Staff page.`
        break
      }
    }
  }
  const { data: after, error: restoreError } = await database.from(table).update(changes).eq('id', id).select('*').single()
  if (restoreError) throw Object.assign(new Error(restoreError.message), { status: 400, details: restoreError })
  const { error: auditError } = await database.from('audit_logs').insert({
    action: 'restore', table_name: table, record_id: id, actor_staff_id: identity.staffId || null,
    branch_id: before.branch_id || null, before_data: before, after_data: after,
  })
  if (auditError) throw Object.assign(new Error(auditError.message), { status: 400, details: auditError })
  return { data: after, notice }
}
