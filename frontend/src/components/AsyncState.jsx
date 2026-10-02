import { AlertCircle, RefreshCw } from "lucide-react";
import React from "react";

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

export function LoadingVisual({ label = "Loading data…", compact = false }) {
  return <SkeletonLoader label={label} compact={compact} />;
}

export function PageLoader({ label = "Loading data…" }) {
  return (
    <div className="async-state" role="status" aria-live="polite">
      <SkeletonLoader label={label} />
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

export class AppErrorBoundary extends React.Component {
  constructor(props) { super(props); this.state = { error: null }; }
  static getDerivedStateFromError(error) { return { error }; }
  componentDidCatch(error) { console.error("Application render error:", error); }
  render() {
    if (this.state.error) return <PageError message="An unexpected screen error occurred. Refresh the page or try again." onRetry={() => this.setState({ error: null })} />;
    return this.props.children;
  }
}
