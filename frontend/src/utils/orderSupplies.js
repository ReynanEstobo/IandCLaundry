import { quantity } from './alertText.js'
import { wholeNumberProblem } from './inventoryUnits.js'

// Customer supply choices on a new order. Each service uses its usual supplies
// (set on the Services page) unless staff change one for this customer:
// another item from the branch's stock, the customer's own, or none.

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

// The usual supplies of one service at one branch, with each item's details.
export function serviceRecipe(requirements, stockItems, branchId, serviceId) {
  if (!branchId || !serviceId) return []
  const itemsById = new Map((stockItems || []).map(item => [String(item.id), item]))
  return (requirements || [])
    .filter(requirement => String(requirement.branch_id) === String(branchId)
      && String(requirement.service_type_id) === String(serviceId))
    .map(requirement => ({
      requirementId: String(requirement.id),
      quantityPerLoad: Number(requirement.quantity_per_load) || 0,
      item: itemsById.get(String(requirement.inventory_item_id)),
    }))
    .filter(line => line.item)
    .sort((a, b) => a.item.name.localeCompare(b.item.name))
}

// Items that can replace a usual supply: any other item in the same branch's
// stock, leaving out the service's other usual supplies. Items counted like
// the usual one come first, since they use the usual amount.
export function replacementOptions(stockItems, usualItem, recipe = []) {
  if (!usualItem) return []
  const usualIds = new Set(recipe.map(line => String(line.item.id)))
  usualIds.add(String(usualItem.id))
  return (stockItems || [])
    .filter(item => !usualIds.has(String(item.id)) && String(item.branch_id) === String(usualItem.branch_id))
    .sort((a, b) => Number(b.unit === usualItem.unit) - Number(a.unit === usualItem.unit) || a.name.localeCompare(b.name))
}

// A replacement counted in another unit (for example mL instead of sachets)
// cannot use the usual amount, so staff enter how much to use.
export function needsAmount(usualItem, replacement) {
  return Boolean(usualItem && replacement) && replacement.unit !== usualItem.unit
}

function isChanged(choice) {
  return Boolean(choice?.choice) && choice.choice !== 'default'
}

// What still needs fixing on Step 3 before the order can be saved: an item
// not picked, an amount missing or not whole, or not enough stock.
export function supplyChoiceProblem(choices, recipe, stockItems, loads = 1) {
  for (const line of recipe || []) {
    const choice = choices?.[line.requirementId]
    if (choice?.choice !== 'substitute') continue
    const replacement = (stockItems || []).find(item => String(item.id) === String(choice.itemId))
    if (!replacement) return `In Step 3, choose the item to use instead of ${line.item.name}, or pick another option.`
    let amount = line.quantityPerLoad * loads
    if (needsAmount(line.item, replacement)) {
      if (!(Number(choice.amount) > 0)) return `In Step 3, enter how much ${replacement.name} to use instead of ${line.item.name}.`
      const whole = wholeNumberProblem(replacement.unit, choice.amount, `The amount of ${replacement.name}`)
      if (whole) return `In Step 3: ${whole}`
      amount = Number(choice.amount)
    }
    if (amount > Number(replacement.current_stock || 0)) {
      return `In Step 3, ${replacement.name} has only ${quantity(replacement.current_stock, replacement.unit)} left, but ${quantity(amount, replacement.unit)} is needed.`
    }
  }
  return null
}

// The changes to send with one service: only lines of its current usual
// supplies that differ from the usual, so stale choices are never sent.
export function supplyChoicesPayload(choices, recipe, stockItems) {
  const linesById = new Map((recipe || []).map(line => [line.requirementId, line]))
  return Object.entries(choices || {})
    .filter(([requirementId, choice]) => linesById.has(requirementId) && isChanged(choice)
      && (choice.choice !== 'substitute' || choice.itemId))
    .map(([requirementId, choice]) => {
      if (choice.choice !== 'substitute') return { requirement_id: requirementId, choice: choice.choice }
      const replacement = (stockItems || []).find(item => String(item.id) === String(choice.itemId))
      return needsAmount(linesById.get(requirementId).item, replacement)
        ? { requirement_id: requirementId, choice: 'substitute', item_id: choice.itemId, quantity: Number(choice.amount) }
        : { requirement_id: requirementId, choice: 'substitute', item_id: choice.itemId }
    })
}

export function changedSupplyCount(choices, recipe) {
  return (recipe || []).filter(line => isChanged(choices?.[line.requirementId])).length
}

// One recorded change, as shown in the order details.
export function describeSupplyChange(change) {
  const replacement = change.choice === 'substitute'
    ? change.used_item_name_snapshot
    : change.choice === 'customer_own' ? "Customer's own" : 'Left out'
  return `${change.default_item_name_snapshot} → ${replacement}`
}
