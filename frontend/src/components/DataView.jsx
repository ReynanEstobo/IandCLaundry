import { ArrowDown, ArrowUp, ArrowUpDown, Search } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'

/**
 * True from the moment the person types until the results for that search
 * arrive: first the typing pause before the query is committed, then the
 * request itself (settled when the result list changes). It only reads the
 * page's existing search state, and clears itself if a request never lands.
 */
export function useSearchPending(input, query, results) {
  const [settledQuery, setSettledQuery] = useState(query)
  useEffect(() => {
    setSettledQuery(query)
    // Results arriving is what settles a search; the query is read, not watched.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [results])
  useEffect(() => {
    if (query === settledQuery) return undefined
    const timer = window.setTimeout(() => setSettledQuery(query), 8000)
    return () => window.clearTimeout(timer)
  }, [query, settledQuery])
  return input.trim() !== query || query !== settledQuery
}

// The search box's leading icon: a magnifier, or a small spinner while a
// search is running. Screen readers hear "Searching…" once.
export function SearchStatusIcon({ searching }) {
  return <>
    {searching ? <span className="search-box-spinner" aria-hidden="true" /> : <Search aria-hidden="true" />}
    <span className="visually-hidden" role="status" aria-live="polite">{searching ? 'Searching…' : ''}</span>
  </>
}

/**
 * On-screen paging for a list the page already holds (after its search,
 * filter and sort). It only limits how many rows are drawn; it never changes
 * what is fetched. If the list shrinks, the page index clamps to the last page.
 */
export function useClientPagination(rows, pageSize = 10) {
  const [page, setPage] = useState(0)
  const totalCount = rows.length
  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize))
  const currentPage = Math.min(page, totalPages - 1)
  const pageRows = useMemo(
    () => rows.slice(currentPage * pageSize, (currentPage + 1) * pageSize),
    [rows, currentPage, pageSize],
  )
  return { page: currentPage, setPage, pageRows, totalPages, totalCount, pageSize }
}

/**
 * Ids of rows whose data changed in the latest refresh, for a brief highlight.
 * Only rows that were already on screen count: moving to another page or
 * loading new rows does not flash anything.
 */
export function useChangedRows(rows, getKey = row => row.id) {
  const previous = useRef(null)
  const [changed, setChanged] = useState(() => new Set())
  useEffect(() => {
    const snapshot = new Map(rows.map(row => [getKey(row), JSON.stringify(row)]))
    const before = previous.current
    previous.current = snapshot
    if (!before) return undefined
    const updated = new Set()
    snapshot.forEach((value, key) => {
      if (before.has(key) && before.get(key) !== value) updated.add(key)
    })
    if (!updated.size) return undefined
    setChanged(updated)
    const timer = window.setTimeout(() => setChanged(new Set()), 1600)
    return () => window.clearTimeout(timer)
    // getKey is a plain accessor; only the row data decides a re-check.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows])
  return changed
}

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

// `busy` marks a background refresh: the rows dim and pause clicks while the
// rest of the page stays usable, and nothing around the table moves.
export function DataTable({ children, ariaLabel, className = '', busy = false }) {
  return <div className={`card data-table-card ${busy ? 'is-refreshing' : ''} ${className}`.trim()} aria-busy={busy || undefined}>
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
