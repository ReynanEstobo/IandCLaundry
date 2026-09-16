import { ArchiveRestore, ChevronLeft, ChevronRight, History, RotateCcw, ShieldCheck } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import toast from 'react-hot-toast'
import { PageError, PageLoader } from '../components/AsyncState'
import ConfirmDialog from '../components/ConfirmDialog'
import { getAuditLog, restoreDeletedRecord } from '../services/api/auditApi'

const labels = {
  customers: 'Customer', staff: 'Staff account', inventory_items: 'Inventory item',
  inventory_categories: 'Inventory category', service_types: 'Service type', expenses: 'Expense',
}

function recordName(record) {
  return record.full_name || record.name || record.description || record.category || record.id
}

export default function RecycleBin() {
  const [records, setRecords] = useState([])
  const [audit, setAudit] = useState({ items: [], page: 1, pageSize: 25, total: 0, totalPages: 1 })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [restoringId, setRestoringId] = useState('')
  const [recordToRestore, setRecordToRestore] = useState(null)

  const load = useCallback(async (page = 1, background = false) => {
    if (!background) { setLoading(true); setError('') }
    try {
      const data = await getAuditLog({ page, pageSize: 25 })
      setRecords(data.records || [])
      setAudit(data.audit || { items: [], page, pageSize: 25, total: 0, totalPages: 1 })
    } catch (requestError) {
      if (!background) setError(requestError.message || 'Unable to load the Audit Log.')
      else console.error('Background Audit Log refresh failed:', requestError)
    } finally {
      if (!background) setLoading(false)
    }
  }, [])

  useEffect(() => { load(1) }, [load])

  async function restore() {
    const record = recordToRestore
    if (!record) return
    setRestoringId(`${record.table_name}:${record.id}`)
    try {
      await restoreDeletedRecord(record.table_name, record.id)
      toast.success(`${labels[record.table_name] || 'Record'} restored`)
      setRecordToRestore(null)
      await load(audit.page, true)
    } catch (requestError) {
      toast.error(requestError.message)
    } finally {
      setRestoringId('')
    }
  }

  if (loading) return <PageLoader label="Loading Audit Log…" />
  if (error) return <PageError message={error} onRetry={() => load(audit.page)} />

  return <div style={{ display: 'grid', gap: 22 }}>
    <div className="card" style={{ padding: 24, border: '1px solid #ddd6fe', background: 'linear-gradient(135deg,#f5f3ff,#fff)' }}>
      <div style={{ display: 'flex', gap: 14, alignItems: 'flex-start' }}>
        <div style={{ width: 42, height: 42, borderRadius: 12, display: 'grid', placeItems: 'center', background: '#ede9fe', color: '#7c3aed' }}><ShieldCheck size={21} /></div>
        <div>
          <h3 style={{ margin: '1px 0 5px' }}>Audit Log</h3>
          <p style={{ margin: 0, color: 'var(--text-secondary)', fontSize: 13 }}>Review important system activity. Archived customers, staff, inventory, services, and expenses can be restored below; orders and payments remain permanent for accountability.</p>
        </div>
      </div>
    </div>

    <div className="card" style={{ padding: 0 }}>
      <div className="card-header" style={{ padding: '18px 20px', margin: 0, borderBottom: '1px solid var(--border)' }}>
        <h3 style={{ display: 'flex', gap: 8, alignItems: 'center' }}><ArchiveRestore size={18} color="#2563eb" /> Archived records</h3>
        <span style={{ fontSize: 12, color: 'var(--text-muted)', fontWeight: 700 }}>{records.length} record{records.length === 1 ? '' : 's'}</span>
      </div>
      <div className="table-wrapper"><table><thead><tr><th>Type</th><th>Record</th><th>Branch</th><th>Archived at</th><th>Action</th></tr></thead><tbody>
        {!records.length ? <tr><td colSpan={5} className="empty-state"><p>No archived records</p></td></tr> : records.map(record => {
          const key = `${record.table_name}:${record.id}`
          return <tr key={key}><td><span style={{ fontSize: 12, fontWeight: 700, color: '#2563eb', background: '#eff6ff', padding: '4px 8px', borderRadius: 999 }}>{labels[record.table_name] || record.table_name}</span></td><td style={{ fontWeight: 650 }}>{recordName(record)}</td><td>{record.branch || '—'}</td><td>{record.deleted_at ? new Date(record.deleted_at).toLocaleString('en-PH') : '—'}</td><td><button className="btn btn-sm btn-primary" disabled={restoringId === key} onClick={() => setRecordToRestore(record)}><RotateCcw size={14} /> {restoringId === key ? 'Restoring…' : 'Restore'}</button></td></tr>
        })}
      </tbody></table></div>
    </div>

    <div className="card" style={{ padding: 0 }}>
      <div className="card-header" style={{ padding: '18px 20px', margin: 0, borderBottom: '1px solid var(--border)' }}>
        <h3 style={{ display: 'flex', gap: 8, alignItems: 'center' }}><History size={18} color="#7c3aed" /> Activity history</h3>
        <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{audit.total} event{audit.total === 1 ? '' : 's'}</span>
      </div>
      <div className="table-wrapper"><table><thead><tr><th>Activity</th><th>Branch</th><th>Performed by</th><th>When</th></tr></thead><tbody>
        {!audit.items.length ? <tr><td colSpan={4} className="empty-state"><p>No audit activity recorded yet</p></td></tr> : audit.items.map(log => <tr key={log.id}><td style={{ minWidth: 390 }}>{log.description}</td><td>{log.table_name === 'orders' ? log.branch?.name || 'Not recorded' : '—'}</td><td>{log.staff?.full_name || 'System / unassigned'}</td><td style={{ whiteSpace: 'nowrap' }}>{new Date(log.created_at).toLocaleString('en-PH')}</td></tr>)}
      </tbody></table></div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, padding: '14px 20px', borderTop: '1px solid var(--border)', flexWrap: 'wrap' }}>
        <span style={{ color: 'var(--text-muted)', fontSize: 13 }}>Page {audit.page} of {audit.totalPages}</span>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-sm btn-secondary" disabled={audit.page <= 1 || loading} onClick={() => load(audit.page - 1)}><ChevronLeft size={15} /> Previous</button>
          <button className="btn btn-sm btn-secondary" disabled={audit.page >= audit.totalPages || loading} onClick={() => load(audit.page + 1)}>Next <ChevronRight size={15} /></button>
        </div>
      </div>
    </div>

    <ConfirmDialog
      open={Boolean(recordToRestore)}
      title={`Restore this ${labels[recordToRestore?.table_name] || 'record'}?`}
      message={<> <strong>{recordToRestore ? recordName(recordToRestore) : ''}</strong> will return to the active system lists and become available again.</>}
      confirmLabel="Restore Record"
      cancelLabel="Keep Archived"
      variant="restore"
      loading={Boolean(restoringId)}
      onConfirm={restore}
      onClose={() => setRecordToRestore(null)}
    />
  </div>
}
