const text = (value) => String(value ?? '')
const html = (value) => text(value)
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;')
  .replaceAll("'", '&#039;')
const csvCell = (value) => `"${text(value).replaceAll('"', '""')}"`
const number = (value) => Number(value) || 0
const fixed = (value, digits = 2) => number(value).toLocaleString('en-PH', {
  minimumFractionDigits: digits,
  maximumFractionDigits: digits,
})
const peso = (value) => `₱${fixed(value)}`
const percent = (value) => `${fixed(value, 1)}%`

function reportTimestamp(date) {
  return date.toLocaleString('en-PH', {
    year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit',
  })
}

function createReportId(date) {
  const pad = (value) => String(value).padStart(2, '0')
  return `IC-MPR-${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}`
}

function confidenceLabel(value) {
  const normalized = text(value || 'low').toLowerCase()
  return normalized.charAt(0).toUpperCase() + normalized.slice(1)
}

function reportMetrics(model) {
  const revenue = number(model.stats?.totalRevenue)
  const expenses = number(model.stats?.totalExpenses)
  const profit = number(model.stats?.profit)
  const orders = number(model.stats?.totalOrders)
  const released = number(model.operationalSummary?.completedOrders)
  const forecastRevenue = model.forecastData.reduce((sum, item) => sum + number(item.predicted), 0)
  const forecastOrders = model.forecastData.reduce((sum, item) => sum + number(item.predictedOrders), 0)
  return {
    revenue,
    expenses,
    profit,
    orders,
    averageOrderValue: number(model.stats?.avgOrderValue),
    margin: revenue ? (profit / revenue) * 100 : 0,
    released,
    releaseRate: orders ? (released / orders) * 100 : 0,
    forecastRevenue,
    forecastOrders,
  }
}

function executiveNarrative(model, metrics) {
  const lowStockCount = model.operationalSummary.lowStockItems.length
  const cashPosition = metrics.profit >= 0
    ? `${peso(metrics.profit)} in cash remaining after recorded expenses`
    : `recorded expenses exceeding collected cash by ${peso(Math.abs(metrics.profit))}`
  const turnaround = model.operationalSummary.averageTurnaroundHours == null
    ? 'Turnaround time is not yet available for the selected scope.'
    : `Average released-order turnaround was ${fixed(model.operationalSummary.averageTurnaroundHours, 1)} hours.`
  const inventory = lowStockCount
    ? `${lowStockCount} inventory ${lowStockCount === 1 ? 'item requires' : 'items require'} management attention.`
    : 'No inventory items are at or below their configured minimum level.'
  return `The selected scope recorded ${metrics.orders} order${metrics.orders === 1 ? '' : 's'}, ${peso(metrics.revenue)} in cash received, and ${cashPosition}. ${turnaround} ${inventory}`
}

function managementHighlights(model, metrics) {
  const leadingService = model.operationalSummary.services[0]
  const leadingBranch = model.operationalSummary.branches[0]
  const lowStockCount = model.operationalSummary.lowStockItems.length
  const cashMessage = metrics.profit >= 0
    ? `After subtracting the expenses recorded for this period, ${peso(metrics.profit)} of collected cash remains.`
    : `Recorded expenses are ${peso(Math.abs(metrics.profit))} higher than the cash collected for this period. Management should review costs and any collections that are still pending.`

  return [
    {
      title: 'Customer payments collected',
      detail: `${peso(metrics.revenue)} was actually received from customers. This includes deposits and later balance payments, counted on the dates the money was collected.`,
    },
    {
      title: 'Cash remaining after recorded expenses',
      detail: cashMessage,
    },
    {
      title: 'Orders and completion',
      detail: `${metrics.orders} unique order${metrics.orders === 1 ? ' was' : 's were'} created and ${metrics.released} ${metrics.released === 1 ? 'was' : 'were'} released to customers. Paying an order more than once does not increase the order count.`,
    },
    {
      title: 'Strongest activity',
      detail: leadingService || leadingBranch
        ? `${leadingService ? `${leadingService.name} led the service list with ${number(leadingService.orders)} request${number(leadingService.orders) === 1 ? '' : 's'}` : 'No service activity was recorded'}${leadingBranch ? `, while ${leadingBranch.name} led branch cash collections at ${peso(leadingBranch.revenue)}` : ''}.`
        : 'There is not enough activity in this period to identify a leading service or branch.',
    },
    {
      title: 'Stock requiring attention',
      detail: lowStockCount
        ? `${lowStockCount} ${lowStockCount === 1 ? 'item is' : 'items are'} at or below the minimum stock level. Review the Inventory Attention section before the next busy period.`
        : 'All monitored inventory items are currently above their minimum stock levels.',
    },
    {
      title: 'Expected activity ahead',
      detail: model.forecastData.length
        ? `The forecast estimates ${metrics.forecastOrders} order${metrics.forecastOrders === 1 ? '' : 's'} and ${peso(metrics.forecastRevenue)} in customer payments across the forecast dates. This is an estimate, not a guaranteed result.`
        : 'No forward estimate is available for the selected period.',
    },
  ]
}

function rowsToCsv(rows) {
  return `\uFEFF${rows.map((row) => row.map(csvCell).join(',')).join('\r\n')}`
}

function emptyRow(columns, message) {
  return `<tr class="empty"><td colspan="${columns}">${html(message)}</td></tr>`
}

export function buildAnalyticsReport(input) {
  const generatedAt = input.generatedAt instanceof Date ? input.generatedAt : new Date(input.generatedAt || Date.now())
  const model = {
    reportScope: input.reportScope || 'All branches',
    reportPeriod: input.reportPeriod || 'Current view',
    stats: input.stats || {},
    payments: input.payments || [],
    descriptiveData: input.descriptiveData || [],
    forecastData: input.forecastData || [],
    forecastModel: input.forecastModel || 'Not available',
    aiInsights: input.aiInsights || [],
    operationalSummary: {
      services: input.operationalSummary?.services || input.operationalSummary?.topServices || [],
      branches: input.operationalSummary?.branches || input.operationalSummary?.topBranches || [],
      staffPerformance: input.operationalSummary?.staffPerformance || [],
      lowStockItems: input.operationalSummary?.lowStockItems || [],
      repeatCustomers: number(input.operationalSummary?.repeatCustomers),
      completedOrders: number(input.operationalSummary?.completedOrders),
      averageTurnaroundHours: input.operationalSummary?.averageTurnaroundHours ?? null,
    },
    logoUrl: input.logoUrl || '/assets/Rectangle.png',
    forecastSource: input.forecastSource || 'Not recorded',
    decisionSupportSource: input.decisionSupportSource || 'Not recorded',
  }
  const metrics = reportMetrics(model)
  const reportId = createReportId(generatedAt)
  const generatedLabel = reportTimestamp(generatedAt)
  const narrative = executiveNarrative(model, metrics)
  const highlights = managementHighlights(model, metrics)
  const fileDate = generatedAt.toISOString().slice(0, 10)

  const csvRows = [
    ['I&C LAUNDRY MANAGEMENT PERFORMANCE REPORT'],
    ['Business Analytics and Decision Support System'],
    [],
    ['REPORT CONTROL'],
    ['Report ID', reportId],
    ['Management scope', model.reportScope],
    ['Reporting period', model.reportPeriod],
    ['Generated', generatedLabel],
    ['Classification', 'Internal Management Use'],
    ['Financial basis', 'Cash received is recognized on each payment collection date.'],
    ['Order-count basis', 'Distinct non-cancelled orders; multiple payments do not duplicate an order.'],
    [],
    ['EXECUTIVE SUMMARY'],
    ['Management note', narrative],
    ['Cash Received (PHP)', metrics.revenue],
    ['Recorded Expenses (PHP)', metrics.expenses],
    ['Cash Remaining After Recorded Expenses (PHP)', metrics.profit],
    ['Share of Collected Cash Remaining (%)', metrics.margin.toFixed(1)],
    ['Unique Orders Created', metrics.orders],
    ['Average Cash Collected per Order (PHP)', metrics.averageOrderValue],
    ['Orders Released to Customers', metrics.released],
    ['Released Orders as Share of Orders Created (%)', metrics.releaseRate.toFixed(1)],
    ['Payment Entries', model.payments.length],
    ['Repeat Customers', model.operationalSummary.repeatCustomers],
    ['Average Turnaround (Hours)', model.operationalSummary.averageTurnaroundHours == null ? 'Not available' : number(model.operationalSummary.averageTurnaroundHours).toFixed(1)],
    ['Low-Stock Items', model.operationalSummary.lowStockItems.length],
    [],
    ['WHAT MANAGEMENT SHOULD KNOW'],
    ['Topic', 'Plain-Language Explanation'],
    ...highlights.map((item) => [item.title, item.detail]),
    [],
    ['FINANCIAL TREND'],
    ['Period', 'Customer Payments Collected (PHP)', 'Recorded Expenses (PHP)', 'Cash Remaining After Expenses (PHP)'],
    ...model.descriptiveData.map((item) => [item.date, number(item.revenue), number(item.expenses), number(item.revenue) - number(item.expenses)]),
    [],
    ['SERVICE PERFORMANCE'],
    ['Rank', 'Service', 'Service Requests', 'Service Sales (PHP)', 'Weight (kg)', 'Quantity'],
    ...model.operationalSummary.services.map((item, index) => [index + 1, item.name, item.orders, item.revenue, item.weightKg, item.quantity]),
    [],
    ['BRANCH PERFORMANCE'],
    ['Rank', 'Branch', 'Orders Created', 'Cash Received (PHP)'],
    ...model.operationalSummary.branches.map((item, index) => [index + 1, item.name, item.orders, item.revenue]),
    [],
    ['STAFF PRODUCTIVITY'],
    ['Rank', 'Staff Member', 'Orders Handled', 'Orders Released', 'Release Rate (%)'],
    ...model.operationalSummary.staffPerformance.map((item, index) => [index + 1, item.name, item.created, item.completed, number(item.created) ? ((number(item.completed) / number(item.created)) * 100).toFixed(1) : '0.0']),
    [],
    ['INVENTORY ATTENTION LIST'],
    ['Item', 'Branch', 'Current Stock', 'Unit', 'Minimum Stock Level', 'Amount Needed to Reach Minimum'],
    ...model.operationalSummary.lowStockItems.map((item) => [item.name, item.branch || 'Unassigned', number(item.current_stock), item.unit, number(item.minimum_stock), Math.max(0, number(item.minimum_stock) - number(item.current_stock))]),
    [],
    ['CASH-RECEIPT AND DEMAND FORECAST'],
    ['Forecast Date', 'Estimated Customer Payments (PHP)', 'Estimated Orders', 'Confidence in Estimate'],
    ...model.forecastData.map((item) => [item.forecastDate || item.date, number(item.predicted), number(item.predictedOrders), confidenceLabel(item.confidence)]),
    ['Forecast Total', metrics.forecastRevenue, metrics.forecastOrders, ''],
    ['Forecast Method', model.forecastModel],
    ['Forecast Source', model.forecastSource],
    [],
    ['RECOMMENDED MANAGEMENT ACTIONS'],
    ['Priority', 'Management Area', 'Recommended Action'],
    ...model.aiInsights.map((item, index) => [index + 1, item.title, item.description]),
    ['Decision-Support Source', model.decisionSupportSource],
    [],
    ['REPORT GOVERNANCE'],
    ['Prepared by', 'I&C Laundry Business Analytics and Decision Support System'],
    ['Reviewed by', ''],
    ['Approved by', ''],
    ['Note', 'Forecasts and recommendations are estimates. Review them together with actual customer demand, staff availability, machine capacity, supplier lead times, and physical stock.'],
  ]

  const trendRows = model.descriptiveData.length
    ? model.descriptiveData.map((item) => `<tr><td>${html(item.date)}</td><td class="money">${peso(item.revenue)}</td><td class="money">${peso(item.expenses)}</td><td class="money ${number(item.revenue) - number(item.expenses) < 0 ? 'negative' : 'positive'}">${peso(number(item.revenue) - number(item.expenses))}</td></tr>`).join('')
    : emptyRow(4, 'No financial activity is available for this reporting period.')
  const serviceRows = model.operationalSummary.services.length
    ? model.operationalSummary.services.map((item, index) => `<tr><td class="rank">${index + 1}</td><td><strong>${html(item.name)}</strong></td><td class="number">${number(item.orders)}</td><td class="money">${peso(item.revenue)}</td><td class="number">${fixed(item.weightKg, 2)}</td></tr>`).join('')
    : emptyRow(5, 'No service activity is available for this reporting period.')
  const branchRows = model.operationalSummary.branches.length
    ? model.operationalSummary.branches.map((item, index) => `<tr><td class="rank">${index + 1}</td><td><strong>${html(item.name)}</strong></td><td class="number">${number(item.orders)}</td><td class="money">${peso(item.revenue)}</td></tr>`).join('')
    : emptyRow(4, 'No branch activity is available for this reporting period.')
  const staffRows = model.operationalSummary.staffPerformance.length
    ? model.operationalSummary.staffPerformance.map((item, index) => `<tr><td class="rank">${index + 1}</td><td><strong>${html(item.name)}</strong></td><td class="number">${number(item.created)}</td><td class="number">${number(item.completed)}</td><td class="number">${percent(number(item.created) ? (number(item.completed) / number(item.created)) * 100 : 0)}</td></tr>`).join('')
    : emptyRow(5, 'No staff productivity data is available for this reporting period.')
  const inventoryRows = model.operationalSummary.lowStockItems.length
    ? model.operationalSummary.lowStockItems.map((item) => `<tr><td><strong>${html(item.name)}</strong></td><td>${html(item.branch || 'Unassigned')}</td><td class="number danger">${fixed(item.current_stock, 2)} ${html(item.unit)}</td><td class="number">${fixed(item.minimum_stock, 2)} ${html(item.unit)}</td><td class="number">${fixed(Math.max(0, number(item.minimum_stock) - number(item.current_stock)), 2)} ${html(item.unit)}</td></tr>`).join('')
    : emptyRow(5, 'No items are at or below their minimum stock level.')
  const forecastRows = model.forecastData.length
    ? model.forecastData.map((item) => `<tr><td>${html(item.forecastDate || item.date)}</td><td class="money">${peso(item.predicted)}</td><td class="number">${number(item.predictedOrders)}</td><td><span class="confidence ${html(text(item.confidence).toLowerCase())}">${html(confidenceLabel(item.confidence))}</span></td></tr>`).join('')
    : emptyRow(4, 'No forecast is available for this reporting scope.')
  const insightMarkup = model.aiInsights.length
    ? model.aiInsights.map((item, index) => `<article class="priority"><span>${index + 1}</span><div><h3>${html(item.title)}</h3><p>${html(item.description)}</p></div></article>`).join('')
    : '<div class="empty-panel">No decision-support priorities are available for this reporting scope.</div>'
  const highlightMarkup = highlights.map((item, index) => `<article class="plain-finding"><span>${index + 1}</span><div><h3>${html(item.title)}</h3><p>${html(item.detail)}</p></div></article>`).join('')

  const printHtml = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${html(reportId)} · I&C Laundry Management Performance Report</title><link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=Manrope:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<style>
@page{size:A4;margin:13mm 12mm 16mm}*{box-sizing:border-box}html{-webkit-print-color-adjust:exact;print-color-adjust:exact}body{margin:0;background:#eef3f7;color:#15253a;font-family:Manrope,"Segoe UI",Arial,sans-serif;font-size:10.5px;line-height:1.45}.report{width:210mm;max-width:100%;margin:0 auto;background:#fff;box-shadow:0 14px 45px rgba(15,43,65,.14)}.page{padding:13mm 12mm 17mm}.masthead{position:relative;overflow:hidden;display:grid;grid-template-columns:auto 1fr auto;align-items:center;gap:14px;padding:18px 20px;background:linear-gradient(125deg,#087dac 0%,#16a4d4 58%,#36b8df 100%);color:#fff}.masthead:after{content:"";position:absolute;width:180px;height:180px;border:34px solid rgba(255,255,255,.10);border-radius:50%;right:-65px;top:-86px}.logo-shell{position:relative;z-index:1;width:68px;height:68px;padding:5px;border-radius:16px;background:#fff;box-shadow:0 6px 18px rgba(0,0,0,.16)}.logo-shell img{display:block;width:100%;height:100%;object-fit:contain}.brand{position:relative;z-index:1}.brand h1{margin:0;font-size:25px;line-height:1.05;letter-spacing:-.025em}.brand p{margin:5px 0 0;color:#dff6ff;font-size:10px;font-weight:650;letter-spacing:.08em;text-transform:uppercase}.classification{position:relative;z-index:1;text-align:right}.classification strong{display:inline-block;padding:5px 8px;border:1px solid rgba(255,255,255,.55);border-radius:999px;font-size:8px;letter-spacing:.09em;text-transform:uppercase}.classification small{display:block;margin-top:7px;color:#e6f8ff;font-size:8.5px}.title-block{display:grid;grid-template-columns:1fr auto;gap:18px;padding:18px 20px 16px;border:1px solid #d7e3eb;border-top:0;background:linear-gradient(180deg,#f9fcfe,#fff)}.eyebrow{margin:0 0 4px;color:#0b86b8;font-size:8.5px;font-weight:800;letter-spacing:.14em;text-transform:uppercase}.title-block h2{margin:0;color:#10243e;font-size:20px;letter-spacing:-.015em}.title-block .subtitle{margin:5px 0 0;color:#64748b;font-size:10px}.report-control{min-width:170px}.control-row{display:flex;justify-content:space-between;gap:14px;padding:3px 0;border-bottom:1px solid #e7eef3;font-size:8.5px}.control-row span{color:#718096}.control-row strong{text-align:right;color:#233b53}.section{margin-top:20px}.section-heading{display:flex;align-items:flex-end;justify-content:space-between;gap:16px;margin:0 0 8px;padding-bottom:6px;border-bottom:2px solid #159dcc}.section-heading h2{margin:0;color:#12304a;font-size:13px;letter-spacing:.01em}.section-heading span{color:#7890a4;font-size:8.5px}.executive-note{padding:12px 14px;border:1px solid #cce5f1;border-left:4px solid #159dcc;border-radius:4px;background:#f3fafd;color:#36536b;font-size:10px}.plain-findings{display:grid;grid-template-columns:1fr 1fr;gap:7px;margin-top:9px}.plain-finding{display:grid;grid-template-columns:21px 1fr;gap:8px;padding:8px 9px;border:1px solid #dce7ed;border-radius:6px;background:#fbfdfe;break-inside:avoid}.plain-finding>span{display:grid;place-items:center;width:20px;height:20px;border-radius:50%;background:#dff3fb;color:#087dac;font-size:8px;font-weight:800}.plain-finding h3{margin:0;color:#173a53;font-size:8.8px}.plain-finding p{margin:2px 0 0;color:#5a7081;font-size:8px;line-height:1.4}.kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-top:10px}.kpi{min-height:69px;padding:9px 10px;border:1px solid #dbe6ed;border-radius:7px;background:#fff}.kpi.primary{background:#f1f9fc;border-color:#bfe0ee}.kpi .label{color:#718096;font-size:7.5px;font-weight:800;letter-spacing:.07em;text-transform:uppercase}.kpi .value{margin-top:8px;color:#102f48;font-size:16px;font-weight:800;letter-spacing:-.02em}.kpi .detail{margin-top:2px;color:#718096;font-size:7.5px}.kpi .value.positive{color:#087c62}.kpi .value.negative{color:#b42318}.indicator-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:7px;margin-top:8px}.indicator{padding:8px 9px;border-radius:6px;background:#f7f9fb;border:1px solid #e5ebf0}.indicator span{display:block;color:#718096;font-size:7.5px;text-transform:uppercase}.indicator strong{display:block;margin-top:3px;color:#20384e;font-size:11px}table{width:100%;border-collapse:collapse;border:1px solid #d8e3ea}thead{display:table-header-group}th{padding:6px 7px;background:#123f5c;color:#fff;font-size:7.5px;font-weight:750;letter-spacing:.05em;text-align:left;text-transform:uppercase}td{padding:6px 7px;border-bottom:1px solid #e2e9ee;color:#334e63;font-size:8.5px;vertical-align:top}tbody tr:nth-child(even){background:#f8fafc}tr{break-inside:avoid}.money,.number{text-align:right;white-space:nowrap}.rank{width:28px;text-align:center;color:#0b88b9;font-weight:800}.positive{color:#087c62!important}.negative,.danger{color:#b42318!important}.empty td,.empty-panel{padding:14px;color:#718096;text-align:center;font-style:italic;background:#f8fafc}.two-column{display:grid;grid-template-columns:1fr 1fr;gap:12px;align-items:start}.alert-box{padding:9px 11px;border:1px solid #f4c7c3;border-left:4px solid #d04438;border-radius:4px;background:#fff7f6;color:#7a312c}.forecast-summary{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:8px}.forecast-summary div{padding:8px 10px;border-radius:6px;background:#f4f0ff;border:1px solid #ddd2fa}.forecast-summary span{display:block;color:#6f638c;font-size:7.5px;text-transform:uppercase}.forecast-summary strong{display:block;margin-top:3px;color:#49377b;font-size:12px}.confidence{display:inline-block;padding:2px 6px;border-radius:999px;background:#eef2f6;color:#526578;font-size:7px;font-weight:800;text-transform:uppercase}.confidence.high{background:#e7f6ef;color:#087c62}.confidence.medium{background:#fff4d6;color:#8a5a00}.priority-list{display:grid;gap:7px}.priority{display:grid;grid-template-columns:24px 1fr;gap:9px;padding:9px 10px;border:1px solid #ded6f4;border-radius:6px;background:#fbf9ff;break-inside:avoid}.priority>span{display:grid;place-items:center;width:22px;height:22px;border-radius:50%;background:#6748a7;color:#fff;font-size:8px;font-weight:800}.priority h3{margin:0;color:#3c2c65;font-size:9.5px}.priority p{margin:3px 0 0;color:#586a7a;font-size:8.5px}.methodology{padding:11px 13px;border-radius:6px;background:#f4f7f9;color:#5d7183;font-size:8.5px}.methodology ul{margin:5px 0 0;padding-left:16px}.methodology li{margin:3px 0}.signoff{display:grid;grid-template-columns:repeat(3,1fr);gap:20px;margin-top:25px}.signature{padding-top:17px;border-top:1px solid #607487;color:#607487;font-size:8px;text-align:center}.signature strong{display:block;color:#243c52;font-size:8.5px}.document-footer{display:flex;justify-content:space-between;gap:16px;margin-top:20px;padding-top:8px;border-top:1px solid #dce5eb;color:#7b8e9e;font-size:7.5px}.screen-actions{position:sticky;top:0;z-index:5;display:flex;justify-content:center;gap:8px;padding:10px;background:#102f48}.screen-actions button{padding:8px 14px;border:0;border-radius:6px;background:#fff;color:#123f5c;font-weight:750;cursor:pointer}.screen-actions button.primary{background:#31b3dd;color:#fff}@media print{body{background:#fff}.report{width:auto;box-shadow:none}.screen-actions{display:none}.page{padding:0}.section,.kpi,.indicator,.plain-finding,.priority,.methodology{break-inside:avoid}.section-heading{break-after:avoid}.page-break{break-before:page}.document-footer{position:relative}}
</style></head><body><main class="report">
<div class="screen-actions"><button onclick="window.close()">Close preview</button><button class="primary" onclick="window.print()">Print / Save as PDF</button></div>
<header class="masthead"><div class="logo-shell"><img src="${html(model.logoUrl)}" alt="I&C Laundry logo"></div><div class="brand"><h1>I&amp;C Laundry</h1><p>Business Analytics &amp; Decision Support System</p></div><div class="classification"><strong>Internal Management Use</strong><small>Three-Branch Operations</small></div></header>
<section class="title-block"><div><p class="eyebrow">Corporate Management Report</p><h2>Management Performance Report</h2><p class="subtitle">Financial, operational, customer, inventory, and forecast intelligence</p></div><div class="report-control"><div class="control-row"><span>Report ID</span><strong>${html(reportId)}</strong></div><div class="control-row"><span>Scope</span><strong>${html(model.reportScope)}</strong></div><div class="control-row"><span>Period</span><strong>${html(model.reportPeriod)}</strong></div><div class="control-row"><span>Generated</span><strong>${html(generatedLabel)}</strong></div></div></section>
<div class="page">
<section class="section"><div class="section-heading"><h2>01 · Executive Performance Summary</h2><span>The most important results at a glance</span></div><div class="executive-note">${html(narrative)}</div><div class="kpis"><div class="kpi primary"><div class="label">Customer Payments Collected</div><div class="value">${peso(metrics.revenue)}</div><div class="detail">Deposits and balance payments actually received</div></div><div class="kpi"><div class="label">Recorded Expenses</div><div class="value">${peso(metrics.expenses)}</div><div class="detail">Expenses entered within this report period</div></div><div class="kpi"><div class="label">Cash Remaining After Expenses</div><div class="value ${metrics.profit < 0 ? 'negative' : 'positive'}">${peso(metrics.profit)}</div><div class="detail">${percent(metrics.margin)} of collected cash</div></div><div class="kpi"><div class="label">Unique Orders Created</div><div class="value">${metrics.orders}</div><div class="detail">An order is counted once, even with several payments</div></div></div><div class="indicator-grid"><div class="indicator"><span>Average collected per order</span><strong>${peso(metrics.averageOrderValue)}</strong></div><div class="indicator"><span>Orders released to customers</span><strong>${metrics.released} · ${percent(metrics.releaseRate)}</strong></div><div class="indicator"><span>Customers with repeat visits</span><strong>${model.operationalSummary.repeatCustomers}</strong></div><div class="indicator"><span>Average time from order to release</span><strong>${model.operationalSummary.averageTurnaroundHours == null ? 'Not available' : `${fixed(model.operationalSummary.averageTurnaroundHours, 1)} hours`}</strong></div></div><div class="section-heading" style="margin-top:14px"><h2>What Management Should Know</h2><span>Plain-language explanation</span></div><div class="plain-findings">${highlightMarkup}</div></section>
<section class="section"><div class="section-heading"><h2>02 · Money Collected and Expenses</h2><span>What came in, what was spent, and what remained</span></div><table><thead><tr><th>Period</th><th class="money">Customer Payments Collected</th><th class="money">Recorded Expenses</th><th class="money">Cash Remaining</th></tr></thead><tbody>${trendRows}</tbody></table></section>
<section class="section"><div class="section-heading"><h2>03 · Services and Branches</h2><span>Which services were requested and where money was collected</span></div><div class="two-column"><table><thead><tr><th>#</th><th>Service</th><th class="number">Times Requested</th><th class="money">Value of Service Requests</th><th class="number">Weight kg</th></tr></thead><tbody>${serviceRows}</tbody></table><table><thead><tr><th>#</th><th>Branch</th><th class="number">Unique Orders</th><th class="money">Customer Payments Collected</th></tr></thead><tbody>${branchRows}</tbody></table></div></section>
<section class="section"><div class="section-heading"><h2>04 · Staff and Completed Pickups</h2><span>How many orders each staff member handled and released</span></div><table><thead><tr><th>#</th><th>Staff Member</th><th class="number">Orders Handled</th><th class="number">Released to Customers</th><th class="number">Share Released</th></tr></thead><tbody>${staffRows}</tbody></table></section>
<section class="section"><div class="section-heading"><h2>05 · Inventory Items Needing Attention</h2><span>${model.operationalSummary.lowStockItems.length} item${model.operationalSummary.lowStockItems.length === 1 ? '' : 's'} at or below minimum stock</span></div>${model.operationalSummary.lowStockItems.length ? '<div class="alert-box">These items have reached the level where restocking should be considered. Confirm the physical quantity first, then plan the amount to purchase using expected demand and supplier delivery time.</div><div style="height:7px"></div>' : ''}<table><thead><tr><th>Inventory Item</th><th>Branch</th><th class="number">Stock Available</th><th class="number">Minimum Desired</th><th class="number">Amount Needed to Reach Minimum</th></tr></thead><tbody>${inventoryRows}</tbody></table></section>
<section class="section page-break"><div class="section-heading"><h2>06 · Expected Activity Ahead</h2><span>Estimate based on available history · ${html(model.forecastModel)}</span></div><div class="forecast-summary"><div><span>Estimated Customer Payments</span><strong>${peso(metrics.forecastRevenue)}</strong></div><div><span>Estimated Orders</span><strong>${metrics.forecastOrders}</strong></div><div><span>Dates / Periods Estimated</span><strong>${model.forecastData.length}</strong></div></div><div class="methodology" style="margin-bottom:8px"><strong>How to read this section:</strong> These figures are estimates of what may happen if recent patterns continue. “Confidence” shows how dependable the estimate appears from the available data: High is more dependable, Medium should be used with caution, and Low means there is limited or inconsistent history.</div><table><thead><tr><th>Forecast Date</th><th class="money">Estimated Customer Payments</th><th class="number">Estimated Orders</th><th>Confidence in Estimate</th></tr></thead><tbody>${forecastRows}</tbody></table></section>
<section class="section"><div class="section-heading"><h2>07 · Recommended Management Actions</h2><span>Suggested next steps · ${html(model.decisionSupportSource)}</span></div><div class="priority-list">${insightMarkup}</div></section>
<section class="section"><div class="section-heading"><h2>08 · Important Notes About the Numbers</h2><span>How this report counts and explains activity</span></div><div class="methodology"><strong>Use these notes when reading the report</strong><ul><li><strong>Customer Payments Collected</strong> means money actually received, including the first payment and any later balance payment. Each payment is counted on the date it was received.</li><li><strong>Unique Orders</strong> counts each non-cancelled order once. An order is not counted again when the customer pays the balance.</li><li><strong>Service Requests</strong> counts every service inside an order. One order containing three services counts as one order but three service requests.</li><li><strong>Cash Remaining After Expenses</strong> is customer payments collected minus expenses entered for the period. It is a simple management cash measure, not a formal accounting profit statement.</li><li><strong>Forecast</strong> means an estimate based on available history. Method used: ${html(model.forecastModel)}. Source: ${html(model.forecastSource)}.</li><li>Recommendations should be checked against actual staffing, machine availability, weather, walk-in customers, supplier delivery time, and physical inventory before management acts.</li></ul></div><div class="signoff"><div class="signature"><strong>Prepared by</strong>I&amp;C Laundry Analytics System</div><div class="signature"><strong>Reviewed by</strong>Branch / Operations Manager</div><div class="signature"><strong>Approved by</strong>Owner / Authorized Manager</div></div></section>
<footer class="document-footer"><span>I&amp;C Laundry · Management Performance Report</span><span>${html(reportId)} · Generated ${html(generatedLabel)}</span></footer>
</div></main></body></html>`

  return {
    reportId,
    csv: rowsToCsv(csvRows),
    csvFilename: `IC-Laundry-Management-Report-${fileDate}.csv`,
    printHtml,
  }
}

