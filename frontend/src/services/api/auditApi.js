import { apiFetch } from './client'

export const getAuditLog = ({ page = 1, pageSize = 25 } = {}) => apiFetch(`/api/audit-log?page=${page}&pageSize=${pageSize}`)
export const restoreDeletedRecord = (table, id) => apiFetch('/api/recycle-bin/restore', {
  method: 'POST', body: JSON.stringify({ table, id }),
})
