import { ArchiveRestore, ChevronLeft, ChevronRight, History, RotateCcw, ShieldCheck } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import toast from 'react-hot-toast'
import { PageError, PageLoader, TableSkeleton } from '../components/AsyncState'
import ConfirmDialog from '../components/ConfirmDialog'
import { DataTable, EmptyState, PageHeader, SortableHeader, useSortableRows } from '../components/DataView'
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
  const [auditLoading, setAuditLoading] = useState(false)
  const [error, setError] = useState('')
  const [restoringId, setRestoringId] = useState('')
  const [recordToRestore, setRecordToRestore] = useState(null)
  const hasLoaded = useRef(false)

  const load = useCallback(async (page = 1, background = false) => {
    const isInitialLoad = !hasLoaded.current
    if (!background) {
      if (isInitialLoad) setLoading(true)
      else setAuditLoading(true)
      setError('')
    }
    try {
      const data = await getAuditLog({ page, pageSize: 25 })
      setRecords(data.records || [])
      setAudit(data.audit || { items: [], page, pageSize: 25, total: 0, totalPages: 1 })
      hasLoaded.current = true
    } catch (requestError) {
      if (isInitialLoad) setError(requestError.message || 'Unable to load the Audit Log.')
      else if (!background) toast.error(requestError.message || 'Unable to load that audit page.')
      else console.error('Background Audit Log refresh failed:', requestError)
    } finally {
      if (!background) {
        setLoading(false)
        setAuditLoading(false)
      }
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

  const archivedSort = useSortableRows(records, 'archived', {
    type: record => labels[record.table_name] || record.table_name,
    record: recordName,
    branch: record => record.branch,
    archived: record => record.deleted_at ? new Date(record.deleted_at).getTime() : 0,
  }, 'desc')
  const activitySort = useSortableRows(audit.items, 'when', {
    activity: log => log.description,
    branch: log => log.table_name === 'orders' ? log.branch?.name : '',
    actor: log => log.staff?.full_name || 'System / unassigned',
    when: log => new Date(log.created_at).getTime(),
  }, 'desc')

  if (loading && !hasLoaded.current) return <PageLoader label="Loading Audit Log…" />
  if (error) return <PageError message={error} onRetry={() => load(audit.page)} />

  return <div className="audit-page">
    <PageHeader
      icon={<ShieldCheck size={21} />}
      eyebrow="Accountability and recovery"
      title="Audit Log"
      description="Review important system activity. Archived customers, staff, inventory, services, and expenses can be restored below; orders and payments remain permanent for accountability."
    />

    <section className="card audit-section-card">
      <div className="card-header audit-card-header">
        <h3><ArchiveRestore size={18} color="#2563eb" /> Archived records</h3>
        <span>{records.length} record{records.length === 1 ? '' : 's'}</span>
      </div>
      <DataTable ariaLabel="Archived records">
        <thead><tr>
          <SortableHeader label="Type" column="type" sort={archivedSort.sort} onSort={archivedSort.requestSort} />
          <SortableHeader label="Record" column="record" sort={archivedSort.sort} onSort={archivedSort.requestSort} />
          <SortableHeader label="Branch" column="branch" sort={archivedSort.sort} onSort={archivedSort.requestSort} />
          <SortableHeader label="Archived at" column="archived" sort={archivedSort.sort} onSort={archivedSort.requestSort} />
          <th>Action</th>
        </tr></thead>
        <tbody>
          {!records.length ? <EmptyState colSpan={5} message="No archived records" /> : archivedSort.sortedRows.map(record => {
            const key = `${record.table_name}:${record.id}`
            return <tr key={key}>
              <td data-card-primary data-label="Type"><span className="record-type-badge">{labels[record.table_name] || record.table_name}</span></td>
              <td data-label="Record"><strong>{recordName(record)}</strong></td>
              <td data-label="Branch">{record.branch || '—'}</td>
              <td data-label="Archived at">{record.deleted_at ? new Date(record.deleted_at).toLocaleString('en-PH') : '—'}</td>
              <td data-card-actions data-label="Action"><div><button className="btn btn-sm btn-primary" disabled={restoringId === key} onClick={() => setRecordToRestore(record)}><RotateCcw size={14} /> {restoringId === key ? 'Restoring…' : 'Restore'}</button></div></td>
            </tr>
          })}
        </tbody>
      </DataTable>
    </section>

    <section className="card audit-section-card" aria-busy={auditLoading || undefined}>
      <div className="card-header audit-card-header">
        <h3><History size={18} color="#7c3aed" /> Activity history</h3>
        <span>{audit.total} event{audit.total === 1 ? '' : 's'}</span>
      </div>
      {auditLoading ? <TableSkeleton label="Loading audit page…" rows={5} columns={4} /> : <DataTable ariaLabel="Audit activity">
        <thead><tr>
          <SortableHeader label="Activity" column="activity" sort={activitySort.sort} onSort={activitySort.requestSort} />
          <SortableHeader label="Branch" column="branch" sort={activitySort.sort} onSort={activitySort.requestSort} />
          <SortableHeader label="Performed by" column="actor" sort={activitySort.sort} onSort={activitySort.requestSort} />
          <SortableHeader label="When" column="when" sort={activitySort.sort} onSort={activitySort.requestSort} />
        </tr></thead>
        <tbody>
          {!audit.items.length ? <EmptyState colSpan={4} message="No audit activity recorded yet" /> : activitySort.sortedRows.map(log => <tr key={log.id}>
            <td data-card-primary data-label="Activity" className="audit-description">{log.description}</td>
            <td data-label="Branch">{log.table_name === 'orders' ? log.branch?.name || 'Not recorded' : '—'}</td>
            <td data-label="Performed by">{log.staff?.full_name || 'System / unassigned'}</td>
            <td data-label="When">{new Date(log.created_at).toLocaleString('en-PH')}</td>
          </tr>)}
        </tbody>
      </DataTable>}
      <div className="audit-pagination system-pagination">
        <span>Page {audit.page} of {audit.totalPages}</span>
        <div>
          <button className="btn btn-sm btn-secondary" disabled={audit.page <= 1 || auditLoading} onClick={() => load(audit.page - 1)}><ChevronLeft size={15} /> Previous</button>
          <button className="btn btn-sm btn-secondary" disabled={audit.page >= audit.totalPages || auditLoading} onClick={() => load(audit.page + 1)}>Next <ChevronRight size={15} /></button>
        </div>
      </div>
    </section>

    <ConfirmDialog
      open={Boolean(recordToRestore)}
      title={`Restore this ${labels[recordToRestore?.table_name] || 'record'}?`}
      message={<><strong>{recordToRestore ? recordName(recordToRestore) : ''}</strong> will return to the active system lists and become available again.</>}
      confirmLabel="Restore Record"
      cancelLabel="Keep Archived"
      variant="restore"
      loading={Boolean(restoringId)}
      onConfirm={restore}
      onClose={() => setRecordToRestore(null)}
    />
  </div>
}
