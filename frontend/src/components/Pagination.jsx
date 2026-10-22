import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from 'lucide-react'

/**
 * Page controls for lists the server returns one page at a time. `page` is
 * zero-based. The parent keeps owning the fetch: `onPageChange` receives the
 * next page index and the parent calls its existing loader with it, so only
 * one page of rows ever reaches the browser.
 */
export default function Pagination({
  page,
  totalPages,
  totalCount,
  pageSize,
  onPageChange,
  disabled = false,
  label = 'Pagination',
  itemLabel = 'records',
}) {
  const lastPage = Math.max(totalPages - 1, 0)
  const windowStart = Math.min(Math.max(page - 1, 0), Math.max(totalPages - 3, 0))
  const pageNumbers = Array.from({ length: Math.min(totalPages, 3) }, (_, offset) => windowStart + offset)
  const firstShown = page * pageSize + 1
  const lastShown = Math.min((page + 1) * pageSize, totalCount)

  const goTo = nextPage => {
    if (disabled || nextPage === page || nextPage < 0 || nextPage > lastPage) return
    onPageChange(nextPage)
  }

  return (
    <nav className="app-pagination" aria-label={label}>
      <span className="app-pagination-summary" aria-live="polite">
        {totalCount === 0
          ? `No ${itemLabel}`
          : <>Showing <strong>{firstShown.toLocaleString()}–{lastShown.toLocaleString()}</strong> of <strong>{totalCount.toLocaleString()}</strong></>}
      </span>
      <div className="app-pagination-controls">
        <button type="button" className="app-pagination-button" disabled={disabled || page === 0} onClick={() => goTo(0)} aria-label="First page" title="First page">
          <ChevronsLeft size={16} aria-hidden="true" />
        </button>
        <button type="button" className="app-pagination-button" disabled={disabled || page === 0} onClick={() => goTo(page - 1)} aria-label="Previous page" title="Previous page">
          <ChevronLeft size={16} aria-hidden="true" />
        </button>
        {pageNumbers.map(pageIndex => (
          <button
            type="button"
            key={pageIndex}
            className="app-pagination-button"
            disabled={disabled}
            aria-current={pageIndex === page ? 'page' : undefined}
            aria-label={`Page ${pageIndex + 1}`}
            onClick={() => goTo(pageIndex)}
          >
            {pageIndex + 1}
          </button>
        ))}
        <button type="button" className="app-pagination-button" disabled={disabled || page >= lastPage} onClick={() => goTo(page + 1)} aria-label="Next page" title="Next page">
          <ChevronRight size={16} aria-hidden="true" />
        </button>
        <button type="button" className="app-pagination-button" disabled={disabled || page >= lastPage} onClick={() => goTo(lastPage)} aria-label="Last page" title="Last page">
          <ChevronsRight size={16} aria-hidden="true" />
        </button>
      </div>
    </nav>
  )
}
