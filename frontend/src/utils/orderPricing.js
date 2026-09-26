export function pricingInputLabel(service) {
  switch (service?.pricing_type) {
    case 'per_piece': return 'Quantity (pcs)'
    case 'fixed': return null
    default: return 'Weight (kg)'
  }
}

export function serviceItemSubtotal(item, service, settings = {}) {
  if (!service) return 0
  const weight = Number(item?.weight_kg) || 0
  const quantity = Number(item?.quantity) || 0
  const unitPrice = Number(service.unit_price ?? service.price_per_kg) || 0
  if (service.pricing_type === 'bundle') {
    const bundleKg = Math.max(Number(settings.bundlekg) || 8, 1)
    const bundlePrice = Math.max(Number(settings.bundleprice) || 200, 0)
    const excessPrice = Math.max(Number(settings.excesskgprice) || 30, 0)
    return bundlePrice + Math.ceil(Math.max(weight - bundleKg, 0)) * excessPrice
  }
  if (service.pricing_type === 'per_kg') return weight * unitPrice
  if (service.pricing_type === 'per_piece') return quantity * unitPrice
  if (service.pricing_type === 'fixed') return unitPrice
  return 0
}

export function validServiceItem(item, service) {
  if (!service) return false
  if (['bundle', 'per_kg'].includes(service.pricing_type)) return Number(item?.weight_kg) > 0
  if (service.pricing_type === 'per_piece') return Number.isInteger(Number(item?.quantity)) && Number(item.quantity) > 0
  return service.pricing_type === 'fixed'
}

export function orderItemsTotal(items, services, settings) {
  return (items || []).reduce((total, item) => {
    const service = (services || []).find(candidate => String(candidate.id) === String(item.service_type_id))
    return total + serviceItemSubtotal(item, service, settings)
  }, 0)
}
