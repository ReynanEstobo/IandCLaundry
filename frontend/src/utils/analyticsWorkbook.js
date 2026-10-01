import ExcelJS from 'exceljs'

const COLORS = {
  navy: '123F5C',
  blue: '159DCC',
  lightBlue: 'EAF7FC',
  paleBlue: 'F5FAFD',
  white: 'FFFFFF',
  ink: '17324A',
  muted: '607487',
  border: 'D8E4EB',
  green: '087C62',
  paleGreen: 'EAF7F2',
  red: 'B42318',
  paleRed: 'FFF0EE',
  amber: '9A6700',
  paleAmber: 'FFF7DC',
  purple: '6748A7',
  palePurple: 'F5F1FC',
}

const moneyFormat = '"₱"#,##0.00;[Red]-"₱"#,##0.00'
const number = (value) => Number(value) || 0
const text = (value) => String(value ?? '')
const peso = (value) => `₱${number(value).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

function normalizeInput(input) {
  const operations = input.operationalSummary || {}
  const generatedAt = input.generatedAt instanceof Date ? input.generatedAt : new Date(input.generatedAt || Date.now())
  const revenue = number(input.stats?.totalRevenue)
  const expenses = number(input.stats?.totalExpenses)
  const orders = number(input.stats?.totalOrders)
  const released = number(operations.completedOrders)
  return {
    reportScope: input.reportScope || 'All branches',
    reportPeriod: input.reportPeriod || 'Current view',
    stats: input.stats || {},
    payments: input.payments || [],
    descriptiveData: input.descriptiveData || [],
    forecastData: input.forecastData || [],
    forecastModel: input.forecastModel || 'Not available',
    forecastSource: input.forecastSource || 'Not recorded',
    decisionSupportSource: input.decisionSupportSource || 'Not recorded',
    aiInsights: input.aiInsights || [],
    services: operations.services || operations.topServices || [],
    branches: operations.branches || operations.topBranches || [],
    staff: operations.staffPerformance || [],
    lowStock: operations.lowStockItems || [],
    repeatCustomers: number(operations.repeatCustomers),
    completedOrders: released,
    turnaround: operations.averageTurnaroundHours ?? null,
    generatedAt,
    revenue,
    expenses,
    cashRemaining: number(input.stats?.profit ?? revenue - expenses),
    orders,
    releaseRate: orders ? released / orders : 0,
    margin: revenue ? number(input.stats?.profit ?? revenue - expenses) / revenue : 0,
    averageOrderValue: number(input.stats?.avgOrderValue),
  }
}

function setSheetDefaults(sheet, landscape = false) {
  sheet.properties.defaultRowHeight = 19
  sheet.views = [{ state: 'frozen', ySplit: 1, showGridLines: false }]
  sheet.pageSetup = {
    paperSize: 9,
    orientation: landscape ? 'landscape' : 'portrait',
    fitToPage: true,
    fitToWidth: 1,
    fitToHeight: 0,
    margins: { left: 0.28, right: 0.28, top: 0.55, bottom: 0.55, header: 0.2, footer: 0.2 },
  }
  sheet.headerFooter.oddFooter = '&LI&C Laundry · Internal Management Use&CPage &P of &N&RGenerated report'
}

function fill(color) {
  return { type: 'pattern', pattern: 'solid', fgColor: { argb: color } }
}

function border(color = COLORS.border) {
  const line = { style: 'thin', color: { argb: color } }
  return { top: line, left: line, bottom: line, right: line }
}

function titleBand(sheet, title, subtitle, endColumn = 8) {
  sheet.mergeCells(1, 1, 1, endColumn)
  const titleCell = sheet.getCell(1, 1)
  titleCell.value = title
  titleCell.font = { name: 'Aptos Display', size: 20, bold: true, color: { argb: COLORS.white } }
  titleCell.fill = fill(COLORS.navy)
  titleCell.alignment = { vertical: 'middle', horizontal: 'left' }
  sheet.getRow(1).height = 35
  sheet.mergeCells(2, 1, 2, endColumn)
  const subtitleCell = sheet.getCell(2, 1)
  subtitleCell.value = subtitle
  subtitleCell.font = { name: 'Aptos', size: 10, color: { argb: COLORS.white } }
  subtitleCell.fill = fill(COLORS.blue)
  subtitleCell.alignment = { vertical: 'middle', horizontal: 'left' }
  sheet.getRow(2).height = 24
}

function sectionBand(sheet, rowNumber, title, endColumn = 8, color = COLORS.navy) {
  sheet.mergeCells(rowNumber, 1, rowNumber, endColumn)
  const cell = sheet.getCell(rowNumber, 1)
  cell.value = title
  cell.font = { name: 'Aptos', size: 11, bold: true, color: { argb: COLORS.white } }
  cell.fill = fill(color)
  cell.alignment = { vertical: 'middle' }
  sheet.getRow(rowNumber).height = 24
}

function styleTableHeader(row) {
  row.eachCell((cell) => {
    cell.font = { name: 'Aptos', size: 9, bold: true, color: { argb: COLORS.white } }
    cell.fill = fill(COLORS.navy)
    cell.border = border(COLORS.navy)
    cell.alignment = { vertical: 'middle', wrapText: true }
  })
  row.height = 28
}

function styleDataRows(sheet, startRow, endRow, currencyColumns = [], percentageColumns = []) {
  for (let rowNumber = startRow; rowNumber <= endRow; rowNumber += 1) {
    const row = sheet.getRow(rowNumber)
    row.eachCell({ includeEmpty: true }, (cell) => {
      cell.font = { name: 'Aptos', size: 9, color: { argb: COLORS.ink } }
      cell.fill = fill(rowNumber % 2 === 0 ? COLORS.paleBlue : COLORS.white)
      cell.border = border()
      cell.alignment = { vertical: 'top', wrapText: true }
    })
    currencyColumns.forEach((column) => { row.getCell(column).numFmt = moneyFormat })
    percentageColumns.forEach((column) => { row.getCell(column).numFmt = '0.0%' })
  }
}

function addEmptyMessage(sheet, message, columns) {
  const row = sheet.addRow([message])
  sheet.mergeCells(row.number, 1, row.number, columns)
  row.getCell(1).font = { name: 'Aptos', italic: true, color: { argb: COLORS.muted } }
  row.getCell(1).fill = fill('F7F9FB')
  row.getCell(1).border = border()
  row.getCell(1).alignment = { horizontal: 'center', vertical: 'middle' }
  row.height = 28
  return row.number
}

function addTable(sheet, headers, rows, options = {}) {
  const header = sheet.addRow(headers)
  styleTableHeader(header)
  const start = header.number + 1
  if (!rows.length) {
    addEmptyMessage(sheet, options.empty || 'No information is available for this reporting period.', headers.length)
    return { header: header.number, start, end: start }
  }
  rows.forEach((values) => sheet.addRow(values))
  const end = sheet.lastRow.number
  styleDataRows(sheet, start, end, options.currencyColumns, options.percentageColumns)
  if (options.totalRow) {
    const row = sheet.getRow(end)
    row.font = { name: 'Aptos', size: 9, bold: true, color: { argb: COLORS.ink } }
    row.fill = fill(COLORS.lightBlue)
  }
  return { header: header.number, start, end }
}

function plainLanguageFindings(model) {
  const leadingService = model.services[0]
  const leadingBranch = model.branches[0]
  return [
    ['Money collected', `${peso(model.revenue)} was actually received from customers, including deposits and later balance payments.`],
    ['Orders counted once', `${model.orders} unique order${model.orders === 1 ? ' was' : 's were'} created. An order is still counted once when a customer pays more than once.`],
    ['Cash after expenses', model.cashRemaining >= 0
      ? `${peso(model.cashRemaining)} remains after subtracting expenses recorded in this period.`
      : `Recorded expenses are ${peso(Math.abs(model.cashRemaining))} higher than collected cash.`],
    ['Strongest activity', leadingService || leadingBranch
      ? `${leadingService ? `${text(leadingService.name)} led services with ${number(leadingService.orders)} requests` : 'No service leader is available'}${leadingBranch ? `; ${text(leadingBranch.name)} led branch collections at ${peso(leadingBranch.revenue)}` : ''}.`
      : 'There is not enough activity to identify a leading service or branch.'],
    ['Inventory attention', model.lowStock.length
      ? `${model.lowStock.length} inventory item${model.lowStock.length === 1 ? ' needs' : 's need'} attention because stock is at or below the configured minimum.`
      : 'No inventory item is currently at or below its minimum stock level.'],
  ]
}

async function addLogo(workbook, sheet, logoUrl) {
  if (!logoUrl || typeof fetch !== 'function') return
  try {
    const response = await fetch(logoUrl)
    if (!response.ok) return
    const logo = await response.arrayBuffer()
    const imageId = workbook.addImage({ buffer: logo, extension: 'png' })
    sheet.addImage(imageId, { tl: { col: 6.8, row: 0.15 }, ext: { width: 72, height: 72 } })
  } catch {
    // The report remains usable if the browser cannot load the logo asset.
  }
}

function addSummarySheet(workbook, model) {
  const sheet = workbook.addWorksheet('Management Summary', { properties: { tabColor: { argb: COLORS.blue } } })
  setSheetDefaults(sheet)
  sheet.columns = [
    { width: 24 }, { width: 28 }, { width: 18 }, { width: 20 },
    { width: 20 }, { width: 19 }, { width: 18 }, { width: 16 },
  ]
  titleBand(sheet, 'I&C LAUNDRY MANAGEMENT REPORT', 'Business Analytics and Decision Support · Clear information for everyday management')
  sheet.addRow([])
  const controlStart = sheet.lastRow.number + 1
  ;[
    ['Report scope', model.reportScope, 'Reporting period', model.reportPeriod],
    ['Generated', model.generatedAt.toLocaleString('en-PH'), 'Classification', 'Internal Management Use'],
    ['Counting rule', 'Each non-cancelled order is counted once.', 'Payment rule', 'Every payment is counted on the date received.'],
  ].forEach((values) => {
    const row = sheet.addRow(values)
    row.height = 23
    ;[1, 3].forEach((column) => {
      row.getCell(column).font = { name: 'Aptos', size: 9, bold: true, color: { argb: COLORS.muted } }
      row.getCell(column).fill = fill('EDF3F7')
    })
    ;[2, 4].forEach((column) => {
      row.getCell(column).font = { name: 'Aptos', size: 9, bold: true, color: { argb: COLORS.ink } }
    })
    for (let column = 1; column <= 4; column += 1) {
      row.getCell(column).border = border()
      row.getCell(column).alignment = { vertical: 'middle', wrapText: true }
    }
    sheet.mergeCells(row.number, 4, row.number, 8)
  })
  sheet.getRow(controlStart + 2).height = 38
  sheet.addRow([])

  sectionBand(sheet, sheet.lastRow.number + 1, 'EXECUTIVE SUMMARY · Results at a Glance')
  const cardLabels = sheet.addRow(['Customer Payments Collected', '', 'Recorded Expenses', '', 'Cash Remaining', '', 'Unique Orders', ''])
  const cardValues = sheet.addRow([model.revenue, '', model.expenses, '', model.cashRemaining, '', model.orders, ''])
  ;[[1, 2], [3, 4], [5, 6], [7, 8]].forEach(([start, end], index) => {
    sheet.mergeCells(cardLabels.number, start, cardLabels.number, end)
    sheet.mergeCells(cardValues.number, start, cardValues.number, end)
    const label = sheet.getCell(cardLabels.number, start)
    label.font = { name: 'Aptos', size: 8, bold: true, color: { argb: COLORS.muted } }
    label.fill = fill(index === 2 ? COLORS.paleGreen : COLORS.paleBlue)
    label.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true }
    label.border = border()
    const value = sheet.getCell(cardValues.number, start)
    value.font = { name: 'Aptos Display', size: 16, bold: true, color: { argb: index === 2 ? (model.cashRemaining < 0 ? COLORS.red : COLORS.green) : COLORS.ink } }
    value.fill = label.fill
    value.alignment = { horizontal: 'center', vertical: 'middle' }
    value.border = border()
    if (index < 3) value.numFmt = moneyFormat
  })
  cardLabels.height = 27
  cardValues.height = 35

  sheet.addRow([])
  sectionBand(sheet, sheet.lastRow.number + 1, 'WHAT MANAGEMENT SHOULD KNOW · Plain-Language Explanation', 8, COLORS.blue)
  addTable(sheet, ['Topic', 'Explanation'], plainLanguageFindings(model), { empty: 'No management findings are available.' })
  sheet.mergeCells(sheet.lastRow.number - plainLanguageFindings(model).length, 2, sheet.lastRow.number - plainLanguageFindings(model).length, 8)
  for (let rowNumber = sheet.lastRow.number - plainLanguageFindings(model).length + 1; rowNumber <= sheet.lastRow.number; rowNumber += 1) {
    sheet.mergeCells(rowNumber, 2, rowNumber, 8)
    sheet.getRow(rowNumber).height = 36
  }

  sheet.addRow([])
  sectionBand(sheet, sheet.lastRow.number + 1, 'ADDITIONAL INDICATORS')
  const indicators = addTable(sheet,
    ['Indicator', 'Result', 'What it means'],
    [
      ['Average cash collected per order', model.averageOrderValue, 'Collected cash divided by unique orders in this report.'],
      ['Orders released to customers', model.completedOrders, 'Orders completed and picked up by customers.'],
      ['Share of orders released', model.releaseRate, 'Released orders compared with orders created.'],
      ['Customers with repeat visits', model.repeatCustomers, 'Customers with more than one recorded order in scope.'],
      ['Average turnaround time', model.turnaround == null ? 'Not available' : number(model.turnaround), model.turnaround == null ? 'Not enough released-order history.' : 'Average hours from order creation to release.'],
      ['Payment entries', model.payments.length, 'Deposits and balance payments; this does not represent the order count.'],
    ],
  )
  sheet.getCell(indicators.start, 2).numFmt = moneyFormat
  sheet.getCell(indicators.start + 2, 2).numFmt = '0.0%'
  sheet.views = [{ state: 'frozen', ySplit: 2, showGridLines: false }]
  return sheet
}

function addFinancialSheet(workbook, model) {
  const sheet = workbook.addWorksheet('Financial Trend', { properties: { tabColor: { argb: COLORS.green } } })
  setSheetDefaults(sheet, true)
  sheet.columns = [{ width: 24 }, { width: 25 }, { width: 23 }, { width: 25 }]
  titleBand(sheet, 'MONEY COLLECTED AND EXPENSES', `${model.reportScope} · ${model.reportPeriod}`, 4)
  sheet.addRow([])
  const rows = model.descriptiveData.map((item) => [
    item.date,
    number(item.revenue),
    number(item.expenses),
    number(item.revenue) - number(item.expenses),
  ])
  const table = addTable(sheet,
    ['Period', 'Customer Payments Collected', 'Recorded Expenses', 'Cash Remaining'],
    rows,
    { currencyColumns: [2, 3, 4], empty: 'No financial activity is available for this period.' },
  )
  if (rows.length) sheet.autoFilter = `A${table.header}:D${table.end}`
  sheet.views = [{ state: 'frozen', ySplit: table.header, showGridLines: false }]
  sheet.addRow([])
  const note = sheet.addRow(['How to read this sheet', 'Money is counted when it was received. A deposit and a later balance payment are separate cash entries, but they do not create extra orders.'])
  sheet.mergeCells(note.number, 2, note.number, 4)
  note.height = 38
  note.eachCell((cell) => {
    cell.fill = fill(COLORS.lightBlue)
    cell.border = border()
    cell.font = { name: 'Aptos', size: 9, bold: cell.col === 1, color: { argb: COLORS.ink } }
    cell.alignment = { vertical: 'middle', wrapText: true }
  })
  return sheet
}

function addOperationsSheet(workbook, model) {
  const sheet = workbook.addWorksheet('Operations', { properties: { tabColor: { argb: COLORS.purple } } })
  setSheetDefaults(sheet, true)
  sheet.columns = [{ width: 9 }, { width: 28 }, { width: 20 }, { width: 24 }, { width: 18 }, { width: 18 }]
  titleBand(sheet, 'SERVICE, BRANCH, AND STAFF PERFORMANCE', `${model.reportScope} · ${model.reportPeriod}`, 6)
  sheet.addRow([])
  sectionBand(sheet, sheet.lastRow.number + 1, 'SERVICE PERFORMANCE', 6, COLORS.purple)
  addTable(sheet,
    ['Rank', 'Service', 'Times Requested', 'Value of Service Requests', 'Weight (kg)', 'Quantity'],
    model.services.map((item, index) => [index + 1, item.name, number(item.orders), number(item.revenue), number(item.weightKg), number(item.quantity)]),
    { currencyColumns: [4], empty: 'No service activity is available for this period.' },
  )
  sheet.addRow([])
  sectionBand(sheet, sheet.lastRow.number + 1, 'BRANCH PERFORMANCE', 6, COLORS.blue)
  addTable(sheet,
    ['Rank', 'Branch', 'Unique Orders', 'Customer Payments Collected'],
    model.branches.map((item, index) => [index + 1, item.name, number(item.orders), number(item.revenue)]),
    { currencyColumns: [4], empty: 'No branch activity is available for this period.' },
  )
  sheet.addRow([])
  sectionBand(sheet, sheet.lastRow.number + 1, 'STAFF PRODUCTIVITY', 6, COLORS.green)
  addTable(sheet,
    ['Rank', 'Staff Member', 'Orders Handled', 'Released to Customers', 'Share Released'],
    model.staff.map((item, index) => [index + 1, item.name, number(item.created), number(item.completed), number(item.created) ? number(item.completed) / number(item.created) : 0]),
    { percentageColumns: [5], empty: 'No staff productivity information is available for this period.' },
  )
  sheet.views = [{ state: 'frozen', ySplit: 2, showGridLines: false }]
  return sheet
}

function addPlanningSheet(workbook, model) {
  const sheet = workbook.addWorksheet('Inventory & Forecast', { properties: { tabColor: { argb: COLORS.amber } } })
  setSheetDefaults(sheet, true)
  sheet.columns = [{ width: 28 }, { width: 28 }, { width: 18 }, { width: 17 }, { width: 19 }, { width: 25 }]
  titleBand(sheet, 'INVENTORY ATTENTION AND EXPECTED ACTIVITY', `${model.reportScope} · ${model.reportPeriod}`, 6)
  sheet.addRow([])
  sectionBand(sheet, sheet.lastRow.number + 1, 'INVENTORY ITEMS NEEDING ATTENTION', 6, COLORS.red)
  addTable(sheet,
    ['Inventory Item', 'Branch', 'Stock Available', 'Unit', 'Minimum Desired', 'Amount Needed to Reach Minimum'],
    model.lowStock.map((item) => [item.name, item.branch || 'Unassigned', number(item.current_stock), item.unit, number(item.minimum_stock), Math.max(0, number(item.minimum_stock) - number(item.current_stock))]),
    { empty: 'No inventory items are at or below the minimum stock level.' },
  )
  sheet.addRow([])
  sectionBand(sheet, sheet.lastRow.number + 1, 'EXPECTED ACTIVITY AHEAD', 6, COLORS.purple)
  const forecastRows = model.forecastData.map((item) => [item.forecastDate || item.date, number(item.predicted), number(item.predictedOrders), text(item.confidence || 'Low')])
  addTable(sheet,
    ['Forecast Date', 'Estimated Customer Payments', 'Estimated Orders', 'Confidence'],
    forecastRows,
    { currencyColumns: [2], empty: 'No forecast is available for this reporting scope.' },
  )
  sheet.addRow([])
  const method = sheet.addRow(['Forecast method', model.forecastModel, 'Forecast source', model.forecastSource])
  sheet.mergeCells(method.number, 4, method.number, 6)
  method.height = 31
  method.eachCell((cell) => {
    cell.fill = fill(COLORS.palePurple)
    cell.border = border()
    cell.font = { name: 'Aptos', size: 9, bold: cell.col === 1 || cell.col === 3, color: { argb: COLORS.ink } }
    cell.alignment = { vertical: 'middle', wrapText: true }
  })
  const warning = sheet.addRow(['Important', 'Forecast figures are estimates, not guaranteed results. Check current staffing, machines, weather, supplier timing, and physical stock before acting.'])
  sheet.mergeCells(warning.number, 2, warning.number, 6)
  warning.height = 40
  warning.eachCell((cell) => {
    cell.fill = fill(COLORS.paleAmber)
    cell.border = border('E9CA72')
    cell.font = { name: 'Aptos', size: 9, bold: cell.col === 1, color: { argb: COLORS.amber } }
    cell.alignment = { vertical: 'middle', wrapText: true }
  })
  sheet.views = [{ state: 'frozen', ySplit: 2, showGridLines: false }]
  return sheet
}

function addActionsSheet(workbook, model) {
  const sheet = workbook.addWorksheet('Recommended Actions', { properties: { tabColor: { argb: COLORS.red } } })
  setSheetDefaults(sheet)
  sheet.columns = [{ width: 11 }, { width: 28 }, { width: 70 }, { width: 19 }]
  titleBand(sheet, 'RECOMMENDED MANAGEMENT ACTIONS', 'AI-assisted suggestions written for practical management use', 4)
  sheet.addRow([])
  const rows = model.aiInsights.map((item, index) => [index + 1, item.title, item.description, 'For review'])
  addTable(sheet,
    ['Priority', 'Management Area', 'Recommended Action', 'Management Decision'],
    rows,
    { empty: 'No decision-support recommendations are available for this scope.' },
  )
  for (let rowNumber = 5; rowNumber <= sheet.lastRow.number; rowNumber += 1) sheet.getRow(rowNumber).height = 42
  sheet.addRow([])
  const source = sheet.addRow(['Source', model.decisionSupportSource, '', ''])
  sheet.mergeCells(source.number, 2, source.number, 4)
  source.eachCell((cell) => {
    cell.fill = fill(COLORS.palePurple)
    cell.border = border()
    cell.font = { name: 'Aptos', size: 9, bold: cell.col === 1, color: { argb: COLORS.ink } }
  })
  sheet.addRow([])
  sectionBand(sheet, sheet.lastRow.number + 1, 'REVIEW AND APPROVAL', 4)
  addTable(sheet,
    ['Prepared by', 'Reviewed by', 'Approved by', 'Date'],
    [['I&C Laundry Analytics System', '', '', '']],
  )
  sheet.views = [{ state: 'frozen', ySplit: 2, showGridLines: false }]
  return sheet
}

export async function buildAnalyticsWorkbook(input) {
  const model = normalizeInput(input)
  const workbook = new ExcelJS.Workbook()
  workbook.creator = 'I&C Laundry Business Analytics and Decision Support System'
  workbook.company = 'I&C Laundry'
  workbook.title = 'I&C Laundry Management Performance Report'
  workbook.subject = `${model.reportScope} · ${model.reportPeriod}`
  workbook.description = 'Management report covering cash collections, unique orders, services, branches, staff, inventory, forecasts, and recommended actions.'
  workbook.created = model.generatedAt
  workbook.modified = model.generatedAt
  workbook.calcProperties.fullCalcOnLoad = true

  const summary = addSummarySheet(workbook, model)
  addFinancialSheet(workbook, model)
  addOperationsSheet(workbook, model)
  addPlanningSheet(workbook, model)
  addActionsSheet(workbook, model)
  await addLogo(workbook, summary, input.logoUrl)
  return workbook
}

export async function downloadAnalyticsWorkbook(input) {
  const workbook = await buildAnalyticsWorkbook(input)
  const data = await workbook.xlsx.writeBuffer()
  const blob = new Blob([data], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  const date = (input.generatedAt instanceof Date ? input.generatedAt : new Date()).toISOString().slice(0, 10)
  link.href = url
  link.download = `IC-Laundry-Management-Report-${date}.xlsx`
  document.body.appendChild(link)
  link.click()
  link.remove()
  URL.revokeObjectURL(url)
}
