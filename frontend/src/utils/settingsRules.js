// Order timing values decide every new order's pickup estimate. Blank, zero or
// negative values used to be saved and made estimates only minutes away.
const TIMING_RULES = [
  ['defaultProcessingMinutes', 'Default processing time', 1, 10080],
  ['etaBufferMinutes', 'ETA safety buffer', 0, 1440],
  ['etaMinCompletedOrders', 'Minimum completed orders', 1, 1000],
  ['statusUndoSeconds', 'Staff undo window', 1, 3600],
]

export function orderTimingProblem(values) {
  for (const [field, label, min, max] of TIMING_RULES) {
    const raw = values?.[field]
    const amount = Number(raw)
    if (raw === '' || raw === null || raw === undefined || !Number.isInteger(amount) || amount < min || amount > max) {
      return `${label} must be a whole number from ${min.toLocaleString()} to ${max.toLocaleString()}.`
    }
  }
  return null
}
