// The four recommendation areas of AI decision support (specific objective 3).
// The server returns one recommendation for each, in this order.
export const DECISION_AREAS = [
  { key: 'service_demand', label: 'Service demand' },
  { key: 'staffing', label: 'Staffing' },
  { key: 'inventory', label: 'Inventory usage' },
  { key: 'branch_performance', label: 'Branch performance' },
]

export function decisionAreaLabel(area) {
  return DECISION_AREAS.find(item => item.key === area)?.label || ''
}

// Shown when the AI service cannot be reached at all.
export const UNAVAILABLE_DECISION_INSIGHTS = [
  { area: 'service_demand', title: 'Service demand', description: 'AI recommendation unavailable; the service ranking still applies.', recommendation: 'Review the top services before planning supplies.' },
  { area: 'staffing', title: 'Staff coverage', description: 'AI recommendation unavailable; treat the forecast as an estimate.', recommendation: 'Check live orders before changing staff coverage.' },
  { area: 'inventory', title: 'Inventory usage', description: 'AI recommendation unavailable; low-stock alerts still apply.', recommendation: 'Check stock levels before the next busy period.' },
  { area: 'branch_performance', title: 'Branch performance', description: 'AI recommendation unavailable; branch results are shown in Analytics.', recommendation: 'Compare branches before moving staff or supplies.' },
]

// "Staffing · Weekend coverage", or the title alone for an older result.
export function decisionTitle(item) {
  const label = decisionAreaLabel(item?.area)
  return label ? `${label} · ${item?.title || ''}` : item?.title || ''
}
