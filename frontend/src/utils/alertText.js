// Short, consistent wording for dashboard suggestions and alerts.

// "2nd Branch - Brgy Calzada" → "Calzada", "3rd Branch - Nasugbu" → "Nasugbu",
// "Main - Brgy 7" → "Main". Other names are kept as they are.
export function shortBranch(name = '') {
  const [head, tail] = String(name || '').split(' - ')
  if (!tail) return head
  return /branch/i.test(head) ? tail.replace(/^Brgy\.?\s+/i, '') : head
}

// "1 sachet", "3 sachets", "1 pc", "13 pcs", "2 L".
export function quantity(amount, unit = '') {
  const value = Number(amount) || 0
  const label = String(unit || '').trim()
  const singular = value === 1 ? (label.toLowerCase() === 'pcs' ? 'pc' : label.replace(/s$/i, '')) : label
  return `${value.toLocaleString('en-PH')} ${singular}`.trim()
}

export const days = count => `${count} day${count === 1 ? '' : 's'}`

// "Calzada: Bleach 3 pcs, Hanger 13 pcs · Nasugbu: Color-Safe Bleach 1 sachet",
// listing at most `limit` entries and then "+N more".
export function byBranch(entries, describe, limit = 6) {
  const groups = new Map()
  for (const entry of entries.slice(0, limit)) {
    const branch = shortBranch(entry.branch) || 'All branches'
    if (!groups.has(branch)) groups.set(branch, [])
    groups.get(branch).push(describe(entry))
  }
  const text = [...groups].map(([branch, items]) => `${branch}: ${items.join(', ')}`).join(' · ')
  return entries.length > limit ? `${text} · +${entries.length - limit} more` : text
}

// The unit for one item: "sachets" → "sachet", "pcs" → "pc", "kg" → "kg".
export function unitName(unit = '') {
  return quantity(1, unit).replace(/^1\s*/, '')
}
