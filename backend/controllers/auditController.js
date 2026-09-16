import { database } from '../config/supabase.js'

const RESTORABLE_TABLES = new Set(['customers', 'staff', 'inventory_items', 'inventory_categories', 'service_types', 'expenses'])
const AUDIT_PAGE_SIZE = 25
const AUDIT_MAX_PAGE_SIZE = 100
const requireAdmin = identity => {
  if (identity.role !== 'admin') throw Object.assign(new Error('Administrator access required.'), { status: 403 })
}

const titleCase = value => String(value || '').replaceAll('_', ' ').replace(/\b\w/g, letter => letter.toUpperCase())
const valueLabel = value => value === null || value === undefined || value === '' ? 'not set' : titleCase(value)
const recordLabel = log => {
  const row = log.after_data || log.before_data || {}
  if (log.table_name === 'orders') return row.order_number ? `order ${row.order_number}` : 'an order'
  return row.full_name || row.name || row.description || `${titleCase(log.table_name)} record`
}
const changedLabels = log => Object.keys(log.changed_fields || {})
  .filter(field => !['created_at', 'updated_at', 'last_updated_by_staff_id', 'created_by_staff_id'].includes(field))
  .map(titleCase)

export function describeAuditEvent(log) {
  const before = log.before_data || {}
  const after = log.after_data || {}
  const record = recordLabel(log)
  if (log.action === 'delete') return `${record} was archived.`
  if (log.action === 'restore') return `${record} was restored to the active system.`
  if (log.action === 'cancel') {
    const reason = log.reason || after.cancellation_reason || before.cancellation_reason
    return `${record} was cancelled${reason ? `: ${reason}` : '.'}`
  }
  if (log.action === 'password_changed') return 'A staff password was changed.'
  if (log.action === 'email_changed') return 'A staff recovery email was changed.'
  if (log.action === 'credentials_reset') return `Temporary credentials were reset for ${record}.`
  if (log.action === 'provision') return `A new staff account was created for ${record}.`
  if (log.action === 'order_transition' || (log.table_name === 'orders' && before.status !== after.status)) {
    return `${record} status changed from ${valueLabel(before.status)} to ${valueLabel(after.status)}.`
  }
  if (log.action === 'payment_collected') {
    return `${record} payment changed from ₱${Number(before.amount_paid || 0).toLocaleString()} to ₱${Number(after.amount_paid || 0).toLocaleString()}.`
  }
  if (log.action === 'inventory_restock') return 'An inventory restock was recorded.'
  if (log.action === 'inventory_adjustment') return 'An inventory adjustment was recorded.'
  if (log.action === 'insert') return `${record} was created.`
  const fields = changedLabels(log)
  return fields.length ? `${record} was updated: ${fields.join(', ')}.` : `${record} was updated.`
}

export async function listAuditLog(identity, { page = 1, pageSize = AUDIT_PAGE_SIZE } = {}) {
  requireAdmin(identity)
  const safePage = Math.max(1, Number.parseInt(page, 10) || 1)
  const safePageSize = Math.min(AUDIT_MAX_PAGE_SIZE, Math.max(1, Number.parseInt(pageSize, 10) || AUDIT_PAGE_SIZE))
  const results = await Promise.all([...RESTORABLE_TABLES].map(async table => {
    const { data, error } = await database.from(table).select('*').not('deleted_at', 'is', null).order('deleted_at', { ascending: false })
    if (error) throw Object.assign(new Error(error.message), { status: 400, details: error })
    return (data || []).map(record => ({ ...record, table_name: table }))
  }))
  const from = (safePage - 1) * safePageSize
  const { data: logs, error: logError, count } = await database.from('audit_logs')
    .select('id, action, event_type, event_category, table_name, record_id, branch_id, created_at, actor_staff_id, changed_fields, reason, source, before_data, after_data, staff:actor_staff_id(full_name)', { count: 'exact' })
    .order('created_at', { ascending: false }).range(from, from + safePageSize - 1)
  if (logError) throw Object.assign(new Error(logError.message), { status: 400, details: logError })
  const items = (logs || []).map(({ before_data, after_data, ...log }) => ({
    ...log,
    description: describeAuditEvent({ ...log, before_data, after_data }),
  }))
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
  const { data: after, error: restoreError } = await database.from(table).update({ deleted_at: null, deleted_by_staff_id: null }).eq('id', id).select('*').single()
  if (restoreError) throw Object.assign(new Error(restoreError.message), { status: 400, details: restoreError })
  const { error: auditError } = await database.from('audit_logs').insert({
    action: 'restore', table_name: table, record_id: id, actor_staff_id: identity.staffId || null,
    branch_id: before.branch_id || null, before_data: before, after_data: after,
  })
  if (auditError) throw Object.assign(new Error(auditError.message), { status: 400, details: auditError })
  return { data: after }
}
