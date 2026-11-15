// Pieces, packs, bottles and sachets are counted, so their stock, minimum
// level and deliveries are whole numbers. Weights and volumes may have
// decimals. The server applies the same rule (backend/utils/recordRules.js).
export const COUNTABLE_UNITS = ['pcs', 'packs', 'bottles', 'sachets']

export function isCountableUnit(unit) {
  return COUNTABLE_UNITS.includes(String(unit || '').trim().toLowerCase())
}

export function stockStep(unit) {
  return isCountableUnit(unit) ? '1' : '0.01'
}

export function wholeNumberProblem(unit, value, label) {
  const amount = Number(value)
  if (value === '' || value === null || value === undefined || !Number.isFinite(amount)) return null
  return isCountableUnit(unit) && !Number.isInteger(amount)
    ? `${label} must be a whole number for items counted in ${String(unit).trim()}.`
    : null
}
