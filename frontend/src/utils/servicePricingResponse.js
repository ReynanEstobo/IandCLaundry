function peso(value) {
  return `₱${Number(value).toLocaleString("en-PH", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  })}`;
}

export function availableServicePrices(services = []) {
  if (!Array.isArray(services)) return [];

  return services
    .filter((service) => service && service.is_active !== false && !service.deleted_at)
    .map((service) => ({
      name: String(service.name || "").trim(),
      bundleKg: Number(service.bundle_kg),
      bundlePrice: Number(service.bundle_price),
      excessKgPrice: Number(service.excess_kg_price),
    }))
    .filter((service) => service.name
      && Number.isFinite(service.bundleKg) && service.bundleKg > 0
      && Number.isFinite(service.bundlePrice) && service.bundlePrice >= 0
      && Number.isFinite(service.excessKgPrice) && service.excessKgPrice >= 0)
    .sort((left, right) => left.name.localeCompare(right.name));
}

export function servicePricingResponse(services = []) {
  const available = availableServicePrices(services);
  if (!available.length) {
    return "Current service prices are temporarily unavailable. Please contact the shop so our staff can confirm the latest rates.";
  }

  const priceLines = available.map((service) =>
    `• ${service.name}: ${peso(service.bundlePrice)} per ${service.bundleKg.toLocaleString("en-PH")} kg load; ${peso(service.excessKgPrice)} per excess kg`,
  );

  return [
    "Here are our currently available service prices:",
    ...priceLines,
    "The final service total depends on the recorded weight. Optional add-ons are charged separately and can vary by branch.",
  ].join("\n");
}
