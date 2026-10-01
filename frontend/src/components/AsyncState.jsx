import { AlertCircle, RefreshCw } from "lucide-react";
import React from "react";

export function LoadingVisual({ label = "Loading data…", compact = false }) {
  return (
    <div className={`shared-loading-visual ${compact ? "shared-loading-compact" : ""}`} role="status" aria-live="polite">
      <div className="shared-loading-stage" aria-hidden="true">
        <span className="shared-loading-ring shared-loading-ring-outer" />
        <span className="shared-loading-ring shared-loading-ring-inner" />
        <div className="shared-loading-figure">
          <img src="/assets/image%2046.png" alt="" />
        </div>
        <span className="shared-loading-bubble bubble-one" />
        <span className="shared-loading-bubble bubble-two" />
        <span className="shared-loading-bubble bubble-three" />
      </div>
      <div className="shared-loading-copy">
        <strong>{label}</strong>
        <span>Syncing the latest I&amp;C records</span>
        <span className="shared-loading-dots" aria-hidden="true"><i /><i /><i /></span>
      </div>
    </div>
  );
}

export function PageLoader({ label = "Loading data…" }) {
  return (
    <div className="async-state" role="status" aria-live="polite">
      <LoadingVisual label={label} compact />
    </div>
  );
}

export function PageError({ message = "We could not load this page.", onRetry }) {
  return (
    <div className="async-state async-error" role="alert">
      <div className="async-error-icon"><AlertCircle size={25} /></div>
      <strong>Something went wrong</strong>
      <span>{message}</span>
      {onRetry && <button className="btn btn-primary async-retry" onClick={onRetry}><RefreshCw size={16} /> Try again</button>}
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
