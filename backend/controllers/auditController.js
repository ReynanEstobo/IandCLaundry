import { database } from '../config/supabase.js'

const RESTORABLE_TABLES = new Set(['customers', 'staff', 'inventory_items', 'inventory_categories', 'service_types', 'expenses'])
const requireAdmin = identity => {
  if (identity.role !== 'admin') throw Object.assign(new Error('Administrator access required.'), { status: 403 })
}

export async function listRecycleBin(identity) {
  requireAdmin(identity)
  const results = await Promise.all([...RESTORABLE_TABLES].map(async table => {
    const { data, error } = await database.from(table).select('*').not('deleted_at', 'is', null).order('deleted_at', { ascending: false })
    if (error) throw Object.assign(new Error(error.message), { status: 400, details: error })
    return (data || []).map(record => ({ ...record, table_name: table }))
  }))
  const { data: logs, error: logError } = await database.from('audit_logs')
    .select('id, action, event_type, event_category, table_name, record_id, branch_id, created_at, actor_staff_id, changed_fields, reason, source, staff:actor_staff_id(full_name)')
    .order('created_at', { ascending: false }).limit(150)
  if (logError) throw Object.assign(new Error(logError.message), { status: 400, details: logError })
  return { records: results.flat().sort((a, b) => new Date(b.deleted_at) - new Date(a.deleted_at)), logs: logs || [] }
}

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
