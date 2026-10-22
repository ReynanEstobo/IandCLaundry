import { AlertCircle, RefreshCw } from "lucide-react";
import React, { useRef } from "react";

// True only until a page's first load has finished. Later fetches keep the
// page mounted, so React updates just the parts whose data changed instead of
// swapping the whole page for a loader.
export function useShowPageLoader(loading) {
  const loadedOnce = useRef(false);
  if (!loading) loadedOnce.current = true;
  return loading && !loadedOnce.current;
}

export function SkeletonLoader({ label = "Loading data…", compact = false }) {
  return (
    <div className={`skeleton-loader ${compact ? "skeleton-loader-compact" : ""}`} role="status" aria-live="polite" aria-label={label}>
      <span className="skeleton-loader-label">{label}</span>
      <div className="skeleton-header" aria-hidden="true">
        <span className="skeleton-shape skeleton-avatar" />
        <span className="skeleton-header-lines">
          <i className="skeleton-shape skeleton-line skeleton-line-title" />
          <i className="skeleton-shape skeleton-line skeleton-line-copy" />
        </span>
      </div>
      <div className="skeleton-card-grid" aria-hidden="true">
        {[0, 1, 2].map(item => (
          <span className="skeleton-card" key={item}>
            <i className="skeleton-shape skeleton-line skeleton-line-short" />
            <i className="skeleton-shape skeleton-value" />
            <i className="skeleton-shape skeleton-line" />
          </span>
        ))}
      </div>
      <div className="skeleton-rows" aria-hidden="true">
        {[0, 1, 2].map(item => (
          <span className="skeleton-row" key={item}>
            <i className="skeleton-shape skeleton-row-icon" />
            <i className="skeleton-shape skeleton-line" />
            <i className="skeleton-shape skeleton-line skeleton-line-short" />
          </span>
        ))}
      </div>
    </div>
  );
}

export function InlineSkeleton({ label = "Updating data…" }) {
  return (
    <span className="inline-skeleton" role="status" aria-live="polite" aria-label={label}>
      <span className="inline-skeleton-preview" aria-hidden="true">
        <i className="skeleton-shape" />
        <i className="skeleton-shape" />
        <i className="skeleton-shape" />
      </span>
      <span className="inline-skeleton-label">{label}</span>
    </span>
  );
}

export function TableSkeleton({ label = "Loading records…", rows = 5, columns = 4 }) {
  return (
    <div className="table-skeleton" role="status" aria-live="polite" aria-label={label}>
      <span className="skeleton-loader-label">{label}</span>
      <div className="table-skeleton-grid" style={{ "--skeleton-columns": columns }} aria-hidden="true">
        {Array.from({ length: rows + 1 }, (_, row) => (
          <span className={`table-skeleton-row${row === 0 ? " is-header" : ""}`} key={row}>
            {Array.from({ length: columns }, (_, column) => (
              <i className="skeleton-shape" key={column} />
            ))}
          </span>
        ))}
      </div>
    </div>
  );
}

// The I&C Laundry loading mark: a washing machine whose drum tumbles while
// data loads. Used for page and section loads; buttons keep the small spinner.
export function LaundryLoader({ label = "Loading data…", compact = false }) {
  return (
    <div className={`laundry-loader ${compact ? "laundry-loader-compact" : ""}`} role="status" aria-live="polite">
      <svg className="laundry-loader-machine" viewBox="0 0 64 72" aria-hidden="true">
        <rect className="laundry-loader-body" x="3" y="3" width="58" height="66" rx="9" />
        <line className="laundry-loader-panel" x1="3" y1="17" x2="61" y2="17" />
        <circle className="laundry-loader-knob" cx="13" cy="10" r="3" />
        <circle className="laundry-loader-light" cx="45" cy="10" r="1.7" />
        <circle className="laundry-loader-light laundry-loader-light-2" cx="52" cy="10" r="1.7" />
        <circle className="laundry-loader-door" cx="32" cy="43" r="18" />
        <g className="laundry-loader-drum">
          <circle className="laundry-loader-water" cx="32" cy="43" r="13" />
          <path className="laundry-loader-cloth" d="M23 41c3.5-4.5 9.5-4.5 13 0-3.5 2.5-9.5 2.5-13 0z" />
          <rect className="laundry-loader-cloth laundry-loader-cloth-2" x="31" y="45" width="8" height="5" rx="2.5" />
        </g>
        <circle className="laundry-loader-bubble" cx="25" cy="34" r="1.8" />
        <circle className="laundry-loader-bubble laundry-loader-bubble-2" cx="39" cy="36" r="1.4" />
        <circle className="laundry-loader-bubble laundry-loader-bubble-3" cx="35" cy="31" r="1.1" />
      </svg>
      <span className="laundry-loader-label">{label}</span>
    </div>
  );
}

export function LoadingVisual({ label = "Loading data…", compact = false }) {
  return <LaundryLoader label={label} compact={compact} />;
}

export function PageLoader({ label = "Loading data…" }) {
  return (
    <div className="async-state">
      <LaundryLoader label={label} />
    </div>
  );
}

export function PageError({ message = "We could not load this page.", onRetry }) {
  return (
    <div className="async-state async-error" role="alert">
      <div className="async-error-icon"><AlertCircle size={25} /></div>
      <strong>Something went wrong</strong>
      <span>{message}</span>
      {onRetry && <button className="btn btn-primary async-retry" onClick={() => onRetry()}><RefreshCw size={16} /> Try again</button>}
    </div>
  );
}

// A tab opened from an older version of the app (left open across an update,
// restored or duplicated) can ask for page files that no longer exist.
const OUTDATED_PAGE_ERROR = /dynamically imported module|Importing a module script failed|Unable to preload CSS|ChunkLoadError/i;
const UPDATE_RELOAD_KEY = "ic-laundry-update-reload";

// Reloads to pick up the current version, at most once in a short window so a
// file that is truly missing shows the error instead of reloading forever.
function reloadForUpdate() {
  try {
    if (Date.now() - Number(sessionStorage.getItem(UPDATE_RELOAD_KEY) || 0) < 15_000) return false;
    sessionStorage.setItem(UPDATE_RELOAD_KEY, String(Date.now()));
  } catch { /* storage unavailable: reload once anyway */ }
  window.location.reload();
  return true;
}

export class AppErrorBoundary extends React.Component {
  constructor(props) { super(props); this.state = { error: null, updating: false }; }
  static getDerivedStateFromError(error) { return { error, updating: OUTDATED_PAGE_ERROR.test(String(error?.message || error)) }; }
  componentDidCatch(error) {
    if (this.state.updating && reloadForUpdate()) return;
    if (this.state.updating) this.setState({ updating: false });
    console.error("Application render error:", error);
  }
  render() {
    // While the newer version loads, show the usual loader rather than an error.
    if (this.state.updating) return <PageLoader label="Loading the latest version…" />;
    if (this.state.error) return <PageError message="An unexpected screen error occurred. Refresh the page or try again." onRetry={() => this.setState({ error: null })} />;
    return this.props.children;
  }
}
