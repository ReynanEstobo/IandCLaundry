// Resource endpoint → database resource mapping. Controllers remain independent
// of HTTP details, even though this project intentionally uses Node's native HTTP server.
export const resourceRoutes = new Map([
  ['customers', 'customers'], ['orders', 'orders'], ['inventory/items', 'inventory_items'],
  ['inventory/categories', 'inventory_categories'], ['inventory/usage', 'inventory_usage_log'],
  ['inventory/restocks', 'inventory_restocks'], ['expenses', 'expenses'], ['staff', 'staff'],
  ['settings', 'settings'], ['service-types', 'service_types'], ['sms-log', 'sms_log'],
  ['branches', 'branches'], ['payments', 'payments'], ['ai-forecasts', 'ai_forecasts'],
])
