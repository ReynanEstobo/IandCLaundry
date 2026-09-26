export function pricingInputLabel(service) {
  return 'Weight (kg)'
}

export function serviceItemSubtotal(item, service) {
  if (!service) return 0
  const weight = Number(item?.weight_kg) || 0
  const bundleKg = Math.max(Number(service.bundle_kg) || 8, 1)
  const bundlePrice = Math.max(Number(service.bundle_price) || 0, 0)
  const excessPrice = Math.max(Number(service.excess_kg_price) || 0, 0)
  return bundlePrice + Math.ceil(Math.max(weight - bundleKg, 0)) * excessPrice
}

export function validServiceItem(item, service) {
  if (!service) return false
  return Number(item?.weight_kg) > 0
}

export function orderItemsTotal(items, services) {
  return (items || []).reduce((total, item) => {
    const service = (services || []).find(candidate => String(candidate.id) === String(item.service_type_id))
    return total + serviceItemSubtotal(item, service)
  }, 0)
}
