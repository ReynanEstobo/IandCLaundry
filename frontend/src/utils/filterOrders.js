/**
 * Apply the Orders page's selected status and text search to one source list.
 * Search is intentionally combined with, not substituted for, the status filter.
 */
export function filterOrders(orders, { status = 'all', searchTerm = '' } = {}) {
  const query = String(searchTerm ?? '').trim().toLowerCase();

  return (Array.isArray(orders) ? orders : []).filter((order) => {
    if (status !== 'all' && order?.status !== status) return false;
    if (!query) return true;

    return String(order?.order_number ?? '').toLowerCase().includes(query)
      || String(order?.customers?.name ?? '').toLowerCase().includes(query);
  });
}
