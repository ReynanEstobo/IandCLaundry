import { apiFetch } from './client'

function legacyDescription(log) {
  const before = log.before_data || {}
  const after = log.after_data || {}
  const row = after.name || after.full_name || before.name || before.full_name || log.table_name || 'Record'
  if (log.action === 'delete') return `${row} was archived.`
  if (log.action === 'restore') return `${row} was restored to the active system.`
  if (log.action === 'cancel') return 'An order was cancelled.'
  if (before.status !== after.status && (before.status || after.status)) return `Order status changed from ${before.status || 'not set'} to ${after.status || 'not set'}.`
  return `${row} was ${String(log.action || 'updated').replaceAll('_', ' ')}.`
}

export async function getAuditLog({ page = 1, pageSize = 25 } = {}) {
  try {
    return await apiFetch(`/api/audit-log?page=${page}&pageSize=${pageSize}`)
  } catch (error) {
    // Supports an already-deployed Worker while its API routes are catching
    // up with the renamed Audit Log page. Remove once every environment has
    // deployed the current worker.
    if (!/endpoint not found/i.test(error.message)) throw error
    const legacy = await apiFetch('/api/recycle-bin')
    const all = legacy.logs || []
    const from = (page - 1) * pageSize
    const items = all.slice(from, from + pageSize).map(log => ({ ...log, description: legacyDescription(log) }))
    return {
      records: legacy.records || [],
      audit: { items, page, pageSize, total: all.length, totalPages: Math.max(1, Math.ceil(all.length / pageSize)) },
    }
  }
}
export const restoreDeletedRecord = (table, id) => apiFetch('/api/recycle-bin/restore', {
  method: 'POST', body: JSON.stringify({ table, id }),
})
