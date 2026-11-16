import { Building2, Lightbulb, Package, ShoppingBag, Users } from 'lucide-react'
import { DECISION_AREAS, decisionAreaLabel } from '../utils/decisionAreas'

// The four decision-support recommendations (service demand, staffing,
// inventory usage, branch performance), shown the same way on Analytics and
// on the admin Dashboard.
const AREA_ICONS = {
  service_demand: ShoppingBag,
  staffing: Users,
  inventory: Package,
  branch_performance: Building2,
}

const withoutOptionPrefix = text => String(text || '').replace(/^Option(?:\s+to\s+consider)?:\s*/i, '').trim()

export function DecisionInsight({ insight }) {
  const Icon = AREA_ICONS[insight?.area] || Lightbulb
  const label = decisionAreaLabel(insight?.area)
  return (
    <article className={`decision-insight decision-insight-${insight?.area || 'general'}`}>
      <span className="decision-insight-icon" aria-hidden="true"><Icon size={18} /></span>
      <div className="decision-insight-body">
        {label && <span className="decision-insight-area">{label}</span>}
        <h4 className="decision-insight-title">{insight?.title || 'Decision support'}</h4>
        <p className="decision-insight-action">
          <strong>Option:</strong> {withoutOptionPrefix(insight?.recommendation) || 'Review the signal below and check current records before acting.'}
        </p>
        <p className="decision-insight-signal">
          <strong>Signal:</strong> {insight?.description || 'No supporting signal is available.'}
        </p>
      </div>
    </article>
  )
}

export default function DecisionInsights({ insights = [], loading = false, loadingLabel = 'Preparing recommendations…' }) {
  // The outer box lets the grid use two columns only where there is room
  // (Analytics), and stay a single list in narrower spots (the Dashboard).
  return (
    <div className="decision-insights">
      {loading ? (
        <div className="decision-insight-grid" role="status" aria-label={loadingLabel}>
          {DECISION_AREAS.map(area => <div key={area.key} className="decision-insight-skeleton skeleton-shape" />)}
        </div>
      ) : (
        <div className="decision-insight-grid">
          {insights.map((insight, index) => <DecisionInsight key={insight?.area || index} insight={insight} />)}
        </div>
      )}
    </div>
  )
}
