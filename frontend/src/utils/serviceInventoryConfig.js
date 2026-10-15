export function findInvalidServiceInventoryConfigs(configRows, inventoryRows) {
  const inventoryById = new Map((inventoryRows || []).map(item => [String(item.id), item]))

  return (configRows || []).filter(row => {
    if (row.is_active === false) return false
    const item = inventoryById.get(String(row.inventory_item_id))
    return !item || Boolean(item.deleted_at) || String(item.branch_id) !== String(row.branch_id)
  }).map(row => {
    const item = inventoryById.get(String(row.inventory_item_id))
    let reason = 'Inventory item no longer exists'
    if (item?.deleted_at) reason = 'Inventory item is archived'
    else if (item && String(item.branch_id) !== String(row.branch_id)) reason = 'Inventory item belongs to a different branch'
    return { ...row, inventory_name: item?.name || 'Unknown inventory item', invalid_reason: reason }
  })
}

