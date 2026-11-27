import { quantity } from './alertText.js'

// Customer supply choices on an order. Each service uses its usual supplies
// (set on the Services page) unless staff change one for this customer, within
// what the Administrator allows for that supply: an approved replacement (with
// its own amount and extra charge per load), the customer's own, or none.
// Amounts and charges shown here are previews; the server works them out again
// from the Administrator's settings.

export const SUPPLY_CHOICES = [
  { value: 'default', label: "Shop's usual" },
  { value: 'substitute', label: 'Other item' },
  { value: 'customer_own', label: "Customer's own" },
  { value: 'none', label: 'Leave out' },
]

export function serviceLoads(weight, service) {
  const kg = Number(weight)
  const loadSize = Number(service?.bundle_kg) || 0
  if (!(kg > 0) || !(loadSize > 0)) return 1
  return Math.max(1, Math.ceil(kg / loadSize))
}

export const peso = value => `₱${Number(value || 0).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

// The usual supplies of one service at one branch, each with what the
// Administrator allows: bringing their own, leaving it out, and the approved
// replacements that are still in this branch's inventory.
export function serviceRecipe(requirements, stockItems, branchId, serviceId, replacements = []) {
  if (!branchId || !serviceId) return []
  const itemsById = new Map((stockItems || []).map(item => [String(item.id), item]))
  const lines = (requirements || [])
    .filter(requirement => String(requirement.branch_id) === String(branchId)
      && String(requirement.service_type_id) === String(serviceId))
    .map(requirement => ({
      requirementId: String(requirement.id),
      quantityPerLoad: Number(requirement.quantity_per_load) || 0,
      item: itemsById.get(String(requirement.inventory_item_id)),
      allowCustomerOwn: requirement.allow_customer_own !== false,
      allowLeaveOut: requirement.allow_leave_out !== false,
    }))
    .filter(line => line.item)
  const usualIds = new Set(lines.map(line => String(line.item.id)))
  return lines
    .map(line => ({
      ...line,
      replacements: (replacements || [])
        .filter(option => String(option.requirement_id) === line.requirementId && option.is_active !== false)
        .map(option => ({
          replacementId: String(option.id),
          item: itemsById.get(String(option.replacement_item_id)),
          quantityPerLoad: Number(option.quantity_per_load) || 0,
          extraChargePerLoad: Number(option.extra_charge_per_load) || 0,
        }))
        // Archived, moved to another branch, or now a usual supply: not offered.
        .filter(option => option.item && !option.item.deleted_at
          && String(option.item.branch_id) === String(line.item.branch_id)
          && !usualIds.has(String(option.item.id)))
        .sort((a, b) => a.item.name.localeCompare(b.item.name)),
    }))
    .sort((a, b) => a.item.name.localeCompare(b.item.name))
}

export function chosenReplacement(line, choice) {
  if (choice?.choice !== 'substitute') return null
  return (line?.replacements || []).find(option => option.replacementId === String(choice.replacementId)) || null
}

function isChanged(choice) {
  return Boolean(choice?.choice) && choice.choice !== 'default'
}

// What still needs fixing before the order can be saved: an option the
// Administrator does not allow, a replacement not picked, or not enough stock.
export function supplyChoiceProblem(choices, recipe, loads = 1) {
  for (const line of recipe || []) {
    const choice = choices?.[line.requirementId]
    if (choice?.choice === 'customer_own' && !line.allowCustomerOwn) {
      return `In Step 3, the customer cannot bring their own ${line.item.name} for this service.`
    }
    if (choice?.choice === 'none' && !line.allowLeaveOut) {
      return `In Step 3, ${line.item.name} cannot be left out for this service.`
    }
    if (choice?.choice !== 'substitute') continue
    const replacement = chosenReplacement(line, choice)
    if (!replacement) return `In Step 3, choose the item to use instead of ${line.item.name}, or pick another option.`
    const amount = replacement.quantityPerLoad * loads
    if (amount > Number(replacement.item.current_stock || 0)) {
      return `In Step 3, ${replacement.item.name} has only ${quantity(replacement.item.current_stock, replacement.item.unit)} left, but ${quantity(amount, replacement.item.unit)} is needed.`
    }
  }
  return null
}

// The changes to send with one service: only real changes to its current usual
// supplies. A replacement is sent as the approved option, never as an amount
// or a price.
export function supplyChoicesPayload(choices, recipe) {
  const linesById = new Map((recipe || []).map(line => [line.requirementId, line]))
  return Object.entries(choices || {})
    .filter(([requirementId, choice]) => linesById.has(requirementId) && isChanged(choice))
    .map(([requirementId, choice]) => {
      if (choice.choice !== 'substitute') return { requirement_id: requirementId, choice: choice.choice }
      const replacement = chosenReplacement(linesById.get(requirementId), choice)
      return replacement ? { requirement_id: requirementId, choice: 'substitute', replacement_id: replacement.replacementId } : null
    })
    .filter(Boolean)
}

// The extra charge of one service's supply changes, for the price preview.
export function supplyCharge(choices, recipe, loads = 1) {
  return Math.round((recipe || []).reduce((sum, line) => {
    const replacement = chosenReplacement(line, choices?.[line.requirementId])
    return sum + (replacement ? replacement.extraChargePerLoad * loads : 0)
  }, 0) * 100) / 100
}

export function changedSupplyCount(choices, recipe) {
  return (recipe || []).filter(line => isChanged(choices?.[line.requirementId])).length
}

// The choices recorded on a service, in the form the supply step uses.
export function choicesFromRecorded(recorded) {
  return Object.fromEntries((recorded || [])
    .filter(change => change.service_inventory_requirement_id)
    .map(change => [String(change.service_inventory_requirement_id), change.choice === 'substitute'
      ? { choice: 'substitute', replacementId: change.replacement_id ? String(change.replacement_id) : '' }
      : { choice: change.choice }]))
}

// One recorded change, as shown in the order details and on the tracking page.
export function describeSupplyChange(change) {
  const replacement = change.choice === 'substitute'
    ? change.used_item_name_snapshot
    : change.choice === 'customer_own' ? "Customer's own" : 'Left out'
  return `${change.default_item_name_snapshot} → ${replacement}`
}
