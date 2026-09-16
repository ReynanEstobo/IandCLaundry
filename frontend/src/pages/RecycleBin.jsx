import { ArchiveRestore, History, RotateCcw, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import toast from 'react-hot-toast'
import { PageError, PageLoader } from '../components/AsyncState'
import ConfirmDialog from '../components/ConfirmDialog'
import { getRecycleBin, restoreDeletedRecord } from '../services/api/auditApi'

const labels = {
  customers: 'Customer', staff: 'Staff account', inventory_items: 'Inventory item',
  inventory_categories: 'Inventory category', service_types: 'Service type', expenses: 'Expense',
}

function recordName(record) {
  return record.full_name || record.name || record.description || record.category || record.id
}

export default function RecycleBin() {
  const [records, setRecords] = useState([])
  const [logs, setLogs] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [restoringId, setRestoringId] = useState('')
  const [recordToRestore, setRecordToRestore] = useState(null)

  const load = useCallback(async (background = false) => {
    if (!background) {
      setLoading(true)
      setError('')
    }
    try {
      const data = await getRecycleBin()
      setRecords(data.records || [])
      setLogs(data.logs || [])
    } catch (requestError) {
      if (!background) setError(requestError.message || 'Unable to load the Recycle Bin.')
      else console.error('Background Recycle Bin refresh failed:', requestError)
    } finally {
      if (!background) setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  async function restore() {
    const record = recordToRestore
    if (!record) return
    setRestoringId(`${record.table_name}:${record.id}`)
    try {
      await restoreDeletedRecord(record.table_name, record.id)
      toast.success(`${labels[record.table_name] || 'Record'} restored`)
      setRecordToRestore(null)
      await load(true)
    } catch (requestError) {
      toast.error(requestError.message)
    } finally {
      setRestoringId('')
    }
  }

  if (loading) return <PageLoader label="Loading Recycle Bin…" />
  if (error) return <PageError message={error} onRetry={load} />

  return <div style={{ display: 'grid', gap: 22 }}>
    <div className="card" style={{ padding: 24, border: '1px solid #fee2e2', background: 'linear-gradient(135deg,#fff7ed,#fff)' }}>
      <div style={{ display: 'flex', gap: 14, alignItems: 'flex-start' }}>
        <div style={{ width: 42, height: 42, borderRadius: 12, display: 'grid', placeItems: 'center', background: '#ffedd5', color: '#ea580c' }}><Trash2 size={21} /></div>
        <div>
          <h3 style={{ margin: '1px 0 5px' }}>Recycle Bin</h3>
          <p style={{ margin: 0, color: 'var(--text-secondary)', fontSize: 13 }}>Deleted customers, staff, inventory, services, and expenses can be restored here. Orders and payment records are preserved through cancellation or correction workflows.</p>
        </div>
      </div>
    </div>

    <div className="card" style={{ padding: 0 }}>
      <div className="card-header" style={{ padding: '18px 20px', margin: 0, borderBottom: '1px solid var(--border)' }}>
        <h3 style={{ display: 'flex', gap: 8, alignItems: 'center' }}><ArchiveRestore size={18} color="#2563eb" /> Deleted records</h3>
        <span style={{ fontSize: 12, color: 'var(--text-muted)', fontWeight: 700 }}>{records.length} record{records.length === 1 ? '' : 's'}</span>
      </div>
      <div className="table-wrapper"><table><thead><tr><th>Type</th><th>Record</th><th>Branch</th><th>Deleted at</th><th>Action</th></tr></thead><tbody>
        {!records.length ? <tr><td colSpan={5} className="empty-state"><p>Recycle Bin is empty</p></td></tr> : records.map(record => {
          const key = `${record.table_name}:${record.id}`
          return <tr key={key}><td><span style={{ fontSize: 12, fontWeight: 700, color: '#2563eb', background: '#eff6ff', padding: '4px 8px', borderRadius: 999 }}>{labels[record.table_name] || record.table_name}</span></td><td style={{ fontWeight: 650 }}>{recordName(record)}</td><td>{record.branch || '—'}</td><td>{record.deleted_at ? new Date(record.deleted_at).toLocaleString('en-PH') : '—'}</td><td><button className="btn btn-sm btn-primary" disabled={restoringId === key} onClick={() => setRecordToRestore(record)}><RotateCcw size={14} /> {restoringId === key ? 'Restoring…' : 'Restore'}</button></td></tr>
        })}
      </tbody></table></div>
    </div>

    <div className="card" style={{ padding: 0 }}>
      <div className="card-header" style={{ padding: '18px 20px', margin: 0, borderBottom: '1px solid var(--border)' }}><h3 style={{ display: 'flex', gap: 8, alignItems: 'center' }}><History size={18} color="#7c3aed" /> Audit trail</h3><span style={{ fontSize: 12, color: 'var(--text-muted)' }}>Latest 150 events</span></div>
      <div className="table-wrapper"><table><thead><tr><th>Event</th><th>Record type</th><th>Changed fields</th><th>Performed by</th><th>When</th></tr></thead><tbody>
        {!logs.length ? <tr><td colSpan={5} className="empty-state"><p>No audit activity recorded yet</p></td></tr> : logs.map(log => {
          const fields = Object.keys(log.changed_fields || {}).filter(field => !['created_at', 'updated_at'].includes(field))
          const event = log.event_type || log.action
          return <tr key={log.id}><td><span style={{ textTransform: 'capitalize', fontWeight: 700, color: log.action === 'restore' ? '#059669' : log.action === 'delete' || log.action === 'cancel' ? '#dc2626' : '#2563eb' }}>{event.replaceAll('_', ' ')}</span></td><td>{labels[log.table_name] || log.table_name}</td><td title={fields.join(', ')}>{fields.length ? fields.slice(0, 3).join(', ') + (fields.length > 3 ? ` +${fields.length - 3}` : '') : log.reason || 'Recorded event'}</td><td>{log.staff?.full_name || 'System / unassigned'}</td><td>{new Date(log.created_at).toLocaleString('en-PH')}</td></tr>
        })}
      </tbody></table></div>
    </div>
    <ConfirmDialog
      open={Boolean(recordToRestore)}
      title={`Restore this ${labels[recordToRestore?.table_name] || 'record'}?`}
      message={<> <strong>{recordToRestore ? recordName(recordToRestore) : ''}</strong> will return to the active system lists and become available again.</>}
      confirmLabel="Restore Record"
      cancelLabel="Keep in Recycle Bin"
      variant="restore"
      loading={Boolean(restoringId)}
      onConfirm={restore}
      onClose={() => setRecordToRestore(null)}
    />
  </div>
}
