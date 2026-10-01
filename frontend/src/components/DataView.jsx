import { ArrowDown, ArrowUp, ArrowUpDown } from 'lucide-react'
import { useMemo, useState } from 'react'

export function PageHeader({ icon, eyebrow, title, description, actions, className = '' }) {
  return <section className={`page-header-card ${className}`.trim()}>
    {icon && <span className="page-header-icon">{icon}</span>}
    <div className="page-header-copy">
      {eyebrow && <span className="page-header-eyebrow">{eyebrow}</span>}
      <h3>{title}</h3>
      {description && <p>{description}</p>}
    </div>
    {actions && <div className="page-header-actions">{actions}</div>}
  </section>
}

export function TableToolbar({ children, actions, className = '' }) {
  return <div className={`table-toolbar ${className}`.trim()}>
    <div className="table-toolbar-controls">{children}</div>
    {actions && <div className="table-toolbar-actions">{actions}</div>}
  </div>
}

export function DataTable({ children, ariaLabel, className = '' }) {
  return <div className={`card data-table-card ${className}`.trim()}>
    <div className="table-wrapper responsive-card-table">
      <table aria-label={ariaLabel}>{children}</table>
    </div>
  </div>
}

export function EmptyState({ colSpan, message }) {
  return <tr className="empty-state-row"><td colSpan={colSpan} className="empty-state"><p>{message}</p></td></tr>
}

export function SortableHeader({ label, column, sort, onSort }) {
  const active = sort.key === column
  const Icon = !active ? ArrowUpDown : sort.direction === 'asc' ? ArrowUp : ArrowDown
  return <th aria-sort={active ? (sort.direction === 'asc' ? 'ascending' : 'descending') : 'none'}>
    <button type="button" className={`sortable-heading ${active ? 'active' : ''}`} onClick={() => onSort(column)}>
      <span>{label}</span><Icon size={13} aria-hidden="true" />
    </button>
  </th>
}

function comparable(value) {
  if (value == null) return ''
  if (value instanceof Date) return value.getTime()
  if (typeof value === 'number') return value
  return String(value).toLocaleLowerCase()
}

export function useSortableRows(rows, initialKey, accessors = {}, initialDirection = 'asc') {
  const [sort, setSort] = useState({ key: initialKey, direction: initialDirection })
  const sortedRows = useMemo(() => [...rows].sort((left, right) => {
    const accessor = accessors[sort.key] || ((item) => item?.[sort.key])
    const a = comparable(accessor(left))
    const b = comparable(accessor(right))
    const result = typeof a === 'number' && typeof b === 'number'
      ? a - b
      : String(a).localeCompare(String(b), 'en', { numeric: true, sensitivity: 'base' })
    return sort.direction === 'asc' ? result : -result
  }), [rows, sort, accessors])

  const requestSort = (key) => setSort((current) => ({
    key,
    direction: current.key === key && current.direction === 'asc' ? 'desc' : 'asc',
  }))
  return { sortedRows, sort, requestSort }
}
