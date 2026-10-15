function normalizeBranch(value) {
  return String(value ?? '').trim().toLocaleLowerCase()
}

export function resolveBranchId(branches, branchValue) {
  if (!branchValue) return null
  const value = String(branchValue).trim()
  const byId = (branches || []).find(branch => String(branch.id) === value)
  if (byId) return byId.id

  const normalized = normalizeBranch(value)
  const match = (branches || []).find(branch =>
    [branch.name, branch.branch_name].some(name => normalizeBranch(name) === normalized),
  )
  return match?.id ?? null
}

export function getAvailableOrderAddons(addons, branchId, serviceIds) {
  if (!branchId) return []
  const selectedServices = new Set(Array.from(serviceIds || [], id => String(id)))

  return (addons || []).filter(addon =>
    String(addon.branch_id) === String(branchId)
    && String(addon.inventory_branch_id) === String(branchId)
    && selectedServices.has(String(addon.service_type_id))
    && !addon.inventory_deleted_at,
  )
}

export function retainAvailableOrderAddons(selectedAddons, availableIds) {
  const available = new Set(Array.from(availableIds || [], id => String(id)))
  return Object.fromEntries(Object.entries(selectedAddons || {}).filter(([id, quantity]) =>
    Number(quantity) > 0 && available.has(String(id)),
  ))
}
