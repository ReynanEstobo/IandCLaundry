import { differenceInDays } from 'date-fns'

function estimateDailyInventoryUsage(
  item,
  usageLogs = [],
  serviceRecipes = [],
  serviceOrderItems = [],
  now = new Date(),
) {
  const itemLogs = usageLogs.filter(log => log.item_id === item?.id && !log.reversed_at)

  if (itemLogs.length >= 2) {
    const sortedLogs = [...itemLogs].sort((a, b) => new Date(a.logged_at) - new Date(b.logged_at))
    const firstLog = new Date(sortedLogs[0].logged_at)
    const lastLog = new Date(sortedLogs[sortedLogs.length - 1].logged_at)
    const observedDays = Math.max(differenceInDays(lastLog, firstLog), 1)
    const totalUsed = itemLogs.reduce((sum, log) => sum + Math.max(Number(log.quantity_used) || 0, 0), 0)
    const dailyUsage = totalUsed / observedDays
    if (dailyUsage > 0) return dailyUsage
  }

  const recipes = serviceRecipes.filter(recipe =>
    recipe.inventory_item_id === item?.id && recipe.branch_id === item?.branch_id,
  )
  if (recipes.length) {
    const thirtyDaysAgo = new Date(now)
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30)
    const recentItems = serviceOrderItems.filter(orderItem =>
      orderItem.branch_id === item?.branch_id && new Date(orderItem.created_at) >= thirtyDaysAgo,
    )
    const configuredUsage = recentItems.reduce((total, orderItem) => {
      const recipe = recipes.find(candidate => candidate.service_type_id === orderItem.service_type_id)
      return total + (recipe ? Number(recipe.quantity_per_load) * Math.max(Number(orderItem.loads) || 1, 1) : 0)
    }, 0)

    if (configuredUsage > 0) {
      const firstDate = recentItems.reduce((earliest, row) => {
        const date = new Date(row.created_at)
        return !earliest || date < earliest ? date : earliest
      }, null)
      const observedDays = Math.max(1, Math.min(30, differenceInDays(now, firstDate) + 1))
      return configuredUsage / observedDays
    }
  }

  return null
}

export function predictInventoryDaysLeft(
  item,
  usageLogs = [],
  serviceRecipes = [],
  serviceOrderItems = [],
  now = new Date(),
) {
  const stock = Math.max(Number(item?.current_stock) || 0, 0)
  const dailyUsage = estimateDailyInventoryUsage(item, usageLogs, serviceRecipes, serviceOrderItems, now)
  return dailyUsage > 0 ? Math.floor(stock / dailyUsage) : null
}

export function suggestInventoryReorderQuantity(
  item,
  usageLogs = [],
  serviceRecipes = [],
  serviceOrderItems = [],
  now = new Date(),
) {
  const dailyUsage = estimateDailyInventoryUsage(item, usageLogs, serviceRecipes, serviceOrderItems, now)
  if (dailyUsage > 0) return Math.max(1, Math.ceil(dailyUsage * 30))

  // With limited usage history, restore a low-stock item to a full minimum-level buffer.
  const currentStock = Math.max(Number(item?.current_stock) || 0, 0)
  const minimumStock = Math.max(Number(item?.minimum_stock) || 0, 0)
  return Math.max(1, Math.ceil((minimumStock * 2) - currentStock))
}

export function inventoryRunOutLabel(daysLeft, now = new Date()) {
  if (daysLeft === null || daysLeft === undefined) return 'Forecast unavailable — more usage history is needed'
  if (daysLeft <= 0) return 'Estimated to run out today'
  const date = new Date(now)
  date.setDate(date.getDate() + daysLeft)
  const dateLabel = date.toLocaleDateString('en-PH', { month: 'short', day: 'numeric', year: 'numeric' })
  return `Estimated to last ${daysLeft} day${daysLeft === 1 ? '' : 's'} · Until ${dateLabel}`
}
