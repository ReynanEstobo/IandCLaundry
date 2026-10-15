import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const output = path.join(dir, 'ic-laundry-functional-testing-uat.docx');
const esc = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const paragraph = (text, style = 'Normal', pageBreak = false) => `<w:p><w:pPr><w:pStyle w:val="${style}"/>${pageBreak ? '<w:pageBreakBefore/>' : ''}</w:pPr><w:r><w:rPr><w:sz w:val="20"/></w:rPr><w:t xml:space="preserve">${esc(text)}</w:t></w:r></w:p>`;
const headings = [];
const cellParagraph = (text, bold = false, color = '24364B', size = 18) => `<w:p><w:pPr><w:spacing w:after="40" w:line="230" w:lineRule="auto"/></w:pPr><w:r><w:rPr>${bold ? '<w:b/>' : ''}<w:color w:val="${color}"/><w:sz w:val="${size}"/></w:rPr><w:t xml:space="preserve">${esc(text)}</w:t></w:r></w:p>`;
function table(headers, rows, widths) {
  const borders = ['top','left','bottom','right','insideH','insideV'].map(side => `<w:${side} w:val="single" w:sz="5" w:color="B8C9D8"/>`).join('');
  let xml = `<w:tbl><w:tblPr><w:tblW w:w="14400" w:type="dxa"/><w:tblLayout w:type="fixed"/><w:tblBorders>${borders}</w:tblBorders><w:tblCellMar><w:top w:w="75" w:type="dxa"/><w:left w:w="90" w:type="dxa"/><w:bottom w:w="75" w:type="dxa"/><w:right w:w="90" w:type="dxa"/></w:tblCellMar></w:tblPr><w:tblGrid>${widths.map(w => `<w:gridCol w:w="${w}"/>`).join('')}</w:tblGrid>`;
  [headers, ...rows].forEach((row, rowIndex) => {
    xml += `<w:tr><w:trPr><w:cantSplit/>${rowIndex === 0 ? '<w:tblHeader/>' : ''}</w:trPr>`;
    row.forEach((value, columnIndex) => {
      const fill = rowIndex === 0 ? '174A6E' : (rowIndex % 2 ? 'F0F5F9' : 'FFFFFF');
      const color = rowIndex === 0 ? 'FFFFFF' : '24364B';
      const bold = rowIndex === 0 || columnIndex === 0;
      xml += `<w:tc><w:tcPr><w:tcW w:w="${widths[columnIndex]}" w:type="dxa"/><w:shd w:val="clear" w:fill="${fill}"/><w:vAlign w:val="top"/></w:tcPr>${cellParagraph(value, bold, color, rowIndex === 0 ? 16 : 17)}</w:tc>`;
    });
    xml += '</w:tr>';
  });
  return `${xml}</w:tbl>${paragraph('')}`;
}
function heading(text, breakBefore = false) { headings.push(paragraph(text, 'Heading1', breakBefore)); }

const groups = [
  { title: 'Table 1. Functional Test Cases for Administrator Modules', cases: [
    ['TC-ADM-01', 'Sign in with valid Administrator credentials.', 'Administrator dashboard opens and Administrator-only modules are available.'],
    ['TC-ADM-02', 'Attempt sign-in with an invalid password.', 'Sign-in is rejected and protected pages remain inaccessible.'],
    ['TC-ADM-03', 'Create a Staff account and assign a branch.', 'The account is provisioned with the selected branch and Staff permissions.'],
    ['TC-ADM-04', 'Attempt to open Analytics, Staff, or Service Configuration as Staff.', 'Administrator-only pages and protected requests are denied.'],
    ['TC-ADM-05', 'Create a new customer while placing an order.', 'The customer is saved once and linked to the new order; the system does not create a duplicate for an existing customer.'],
    ['TC-ADM-06', 'Update permitted customer contact information.', 'The permitted change is saved while existing orders and payment history remain linked.'],
    ['TC-ADM-07', 'Configure a service with branch-specific automatic inventory requirements and optional add-ons.', 'Only valid inventory items for the selected branch and service can be saved in that service configuration.'],
    ['TC-ADM-08', 'Archive an inventory item linked to an active service configuration.', 'A confirmation prompt explains that active links will be disabled. On confirmation, the item is archived and its active service links are deactivated; existing order history remains.'],
    ['TC-ADM-09', 'Attempt to archive inventory while signed in as Staff.', 'Staff has no usable archive action; a direct unauthorized request is rejected and the inventory item remains active.'],
    ['TC-ADM-10', 'Review orders and analytics using a selected branch and date range.', 'The displayed results reflect the chosen reporting scope and distinguish branch records.'],
    ['TC-ADM-11', 'Review demand forecasts and decision-support recommendations.', 'Estimates are labeled as estimates/advisory information; when Gemini is unavailable, the system provides a local fallback or a clear unavailable state without blocking routine transactions.'],
    ['TC-ADM-12', 'Generate or export an operational report.', 'The report reflects the selected scope and its totals agree with the underlying displayed records.'],
  ]},
  { title: 'Table 2. Functional Test Cases for Staff Modules', cases: [
    ['TC-STF-01', 'Sign in with valid Staff credentials.', 'The Staff dashboard opens with functions limited to the assigned role and branch.'],
    ['TC-STF-02', 'Attempt sign-in with invalid credentials.', 'Sign-in is rejected and no protected information is displayed.'],
    ['TC-STF-03', 'Attempt to access another branch’s restricted operational records.', 'The request is blocked and records outside the assigned branch are not disclosed.'],
    ['TC-STF-04', 'Place an order for a new customer.', 'The customer is created through order placement and linked to the saved order.'],
    ['TC-STF-05', 'Place an order for an existing customer.', 'The existing customer is selected without creating a duplicate, and prior history remains available.'],
    ['TC-STF-06', 'Create an order with multiple services, per-service weights, and configured add-ons.', 'The selected services and eligible add-ons match the service and branch configuration; the displayed total and saved order details are correct.'],
    ['TC-STF-07', 'Submit an order with missing service/weight, invalid payment, or payment below the required minimum.', 'The order is not submitted and clear validation guidance is shown.'],
    ['TC-STF-08', 'Record an accepted cash payment and then record a remaining balance payment.', 'Payment entries are saved and the displayed paid amount and remaining balance update correctly.'],
    ['TC-STF-09', 'Advance an order through the permitted processing stages.', 'The order/service status and recorded history reflect each valid transition.'],
    ['TC-STF-10', 'Mark a fully paid order ready and release it after customer pickup.', 'Release requires confirmation; the released status and pickup time are recorded.'],
    ['TC-STF-11', 'Restock inventory for the assigned branch.', 'The authorized stock operation is recorded and does not change another branch’s stock.'],
    ['TC-STF-12', 'Open order details for an order containing add-ons.', 'Each add-on is shown under its service with the saved item name, quantity, and subtotal.'],
    ['TC-STF-13', 'Review an old order after its inventory item is archived or its service add-on configuration is removed.', 'The old order continues to display its saved add-on details; the archived item/configuration is not offered for a new order.'],
    ['TC-STF-14', 'Use order search while a status filter is selected.', 'Search results match both the search term and selected status.'],
    ['TC-STF-15', 'Review a qualifying loyalty reward during checkout.', 'Eligible reward information and the applied benefit are clear; Staff cannot access Administrator reward controls.'],
    ['TC-STF-16', 'Trigger the ready-for-pickup customer email using a test recipient.', 'The intended recipient receives the status email, or a delivery failure is reported and recorded for review.'],
  ]},
  { title: 'Table 3. Functional Test Cases for Public Pages and Order Tracking', cases: [
    ['TC-PUB-01', 'Open the landing page and navigate to services, process, contact, and tracking information.', 'Public sections load and show the current public-facing information without exposing protected dashboard data.'],
    ['TC-PUB-02', 'Submit a valid complete order tracking number.', 'The page shows the matching order’s current public status and estimated-ready information without private customer or payment details.'],
    ['TC-PUB-03', 'Submit an incomplete, invalid, or unknown tracking number.', 'The request is rejected or shows a safe no-match message; unrelated records are not disclosed.'],
    ['TC-PUB-04', 'Submit the Contact Us form with valid information.', 'The form confirms successful submission or presents a clear delivery error without exposing server details.'],
  ]},
];

const parts = [paragraph('I&C LAUNDRY HUB', 'Kicker'), paragraph('FUNCTIONAL TESTING AND USER ACCEPTANCE TESTING', 'Title'), paragraph('Administrator and Staff workflows, branch operations, and public order tracking', 'Subtitle'), paragraph('Project: AI-Assisted Business Analytics and Decision Support System for I&C Laundry Shop'), paragraph('Test actual system behavior. Keep Actual Result and Status blank until execution. Use test accounts, test customers, and a non-production branch/data set.'), paragraph('PART I — FUNCTIONAL TEST CASES', 'Heading1')];
for (const [index, group] of groups.entries()) {
  parts.push(paragraph(group.title, 'Heading2', index > 0));
  parts.push(table(['Test Case ID', 'Test Case Description', 'Expected Result', 'Actual Result', 'Status'], group.cases.map(row => [row[0], row[1], row[2], '', '']), [1250, 3600, 4700, 3000, 1850]));
}
parts.push(paragraph('Table 4. Corrective Action and Retest Log', 'Heading1', true));
parts.push(paragraph('Complete this log when a functional test fails or requires correction. Link each entry to its test case and retain appropriate non-sensitive evidence.'));
parts.push(table(['Test Case ID', 'Initial Result', 'Corrective Action', 'Retest Result', 'Retest Date / Evidence'], Array.from({ length: 5 }, () => ['', '', '', '', '']), [1600, 2600, 4700, 2500, 3000]));
parts.push(paragraph('PART II — PARTICIPANT INVITATION', 'Heading1', true));
[
  'Dear Participant,',
  'Warm greetings!',
  'We are fourth-year Bachelor of Science in Information Technology students specializing in Business Analytics at Batangas State University – The National Engineering University, Balayan Campus. We are developing the capstone project “AI-Assisted Business Analytics and Decision Support System for I&C Laundry Shop.” The system supports laundry operations across the Main, Calzada, and Nasugbu branches through customer and order records, payment tracking, inventory and service configuration, branch reporting, forecasts, and decision-support information.',
  'We invite you to participate in User Acceptance Testing by trying the system features assigned to your role and completing the corresponding evaluation form. Your feedback will help assess whether the system supports the operational and managerial tasks you perform.',
  'Participation is voluntary. You may decline or stop at any time. Please do not include customer contact details, passwords, or other sensitive information in written comments. Complete only the statements for features you personally evaluated; leave an item blank and explain why if it was not tested or does not apply to your role. Follow the capstone team’s approved participant-consent and data-handling procedures.',
  'Thank you for helping evaluate the I&C Laundry system.',
  'Sincerely,',
  'The Researchers',
  'Emmanuel D. De Castro  •  Reynan M. Estobo  •  Richelle Ann L. Roxas',
  'BS Information Technology with Specialization in Business Analytics',
  '',
  'Noted by:',
  'Mr. Mark Anthony P. Ribaldo',
  'Adviser',
].forEach((line, i) => parts.push(paragraph(line, i === 0 || i === 5 || i === 6 ? 'BodyEmphasis' : 'Normal')));

function evaluationForm(title, role, statements, pageBreak) {
  parts.push(paragraph(title, 'Heading1', pageBreak));
  parts.push(paragraph('Project Title: AI-Assisted Business Analytics and Decision Support System for I&C Laundry Shop'));
  parts.push(paragraph('Participant count: ________    Name (optional): ____________________    Date: ______________    Branch/Role: ____________________'));
  parts.push(paragraph(`Instructions: ${role} participants should rate only the statements for features they have personally tested. Mark one response per statement. Leave non-applicable items blank and note the reason.`));
  parts.push(paragraph('Rating scale: 5 – Strongly Agree   4 – Agree   3 – Neutral   2 – Disagree   1 – Strongly Disagree'));
  const rows = statements.map((statement, i) => [`${role === 'Owner/Administrator' ? 'OA' : 'ST'}-${String(i + 1).padStart(2, '0')}`, statement, '☐', '☐', '☐', '☐', '☐']);
  parts.push(table(['No.', 'Statement', '5', '4', '3', '2', '1'], rows, [900, 9450, 810, 810, 810, 810, 810]));
  parts.push(paragraph('Comments / suggestions: ____________________________________________________________________________________'));
  parts.push(paragraph('____________________________________________________________________________________________________________'));
}

evaluationForm('PART III — OWNER / ADMINISTRATOR EVALUATION FORM', 'Owner/Administrator', [
  'The dashboard and reports help me review operations across the branches.',
  'Branch and date filters make the analytics relevant to the period and location I select.',
  'Order, service, payment, and expense information is clear enough for managerial review.',
  'Staff account creation and branch assignment are straightforward.',
  'Service Configuration makes it clear which inventory items are used by each service.',
  'The inventory information helps me identify stock that needs attention.',
  'Archiving inventory clearly explains how its active service links will be affected.',
  'Order history retains useful add-on details after inventory or service configuration changes.',
  'The service-demand and branch summaries are understandable.',
  'Forecasts clearly identify estimates and their limitations.',
  'Decision-support recommendations are useful as advisory information, not as guaranteed outcomes.',
  'The system is understandable and convenient for the management tasks I performed.',
  'Records I saved remained available when I reopened or refreshed the system.',
], true);

evaluationForm('PART IV — STAFF EVALUATION FORM', 'Staff', [
  'The system provides the operational functions needed for my assigned role and branch.',
  'Finding an existing customer or creating a customer during order placement is straightforward.',
  'Selecting services and entering each service weight is clear.',
  'The order form shows only add-ons configured for the selected service and branch.',
  'The displayed add-on name, quantity, price, and order total are easy to review.',
  'Payment validation and remaining-balance information are clear.',
  'Order status updates help me follow laundry progress.',
  'The release confirmation helps prevent releasing the wrong order.',
  'Inventory availability and restocking information are useful for my branch tasks.',
  'Archived inventory is not offered for new orders, while old order details remain available.',
  'Ready-for-pickup notifications provide useful customer updates.',
  'Order search works together with the selected status filter.',
  'The interface and validation messages are understandable on the device I used.',
  'Records I saved remained available when I reopened or refreshed the system.',
], true);

const styles = `<?xml version="1.0" encoding="UTF-8"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial"/><w:sz w:val="20"/></w:rPr></w:rPrDefault></w:docDefaults>${[
  ['Normal','<w:spacing w:after="130" w:line="260" w:lineRule="auto"/>','<w:sz w:val="20"/>'],
  ['Kicker','<w:jc w:val="center"/><w:spacing w:before="800" w:after="100"/>','<w:b/><w:color w:val="1280A8"/><w:sz w:val="24"/>'],
  ['Title','<w:jc w:val="center"/><w:spacing w:after="100"/>','<w:b/><w:color w:val="173B5E"/><w:sz w:val="34"/>'],
  ['Subtitle','<w:jc w:val="center"/><w:spacing w:after="240"/>','<w:color w:val="5B7185"/><w:sz w:val="22"/>'],
  ['Heading1','<w:keepNext/><w:spacing w:before="180" w:after="100"/>','<w:b/><w:color w:val="173B5E"/><w:sz w:val="25"/>'],
  ['Heading2','<w:keepNext/><w:spacing w:before="150" w:after="80"/>','<w:b/><w:color w:val="174A6E"/><w:sz w:val="22"/>'],
  ['BodyEmphasis','<w:spacing w:after="180"/>','<w:b/><w:sz w:val="20"/>'],
].map(([id,ppr,rpr]) => `<w:style w:type="paragraph" w:styleId="${id}"${id==='Normal'?' w:default="1"':''}><w:name w:val="${id}"/><w:pPr>${ppr}</w:pPr><w:rPr>${rpr}</w:rPr></w:style>`).join('')}</w:styles>`;
const documentXml = `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${parts.join('')}<w:sectPr><w:pgSz w:w="15840" w:h="12240" w:orient="landscape"/><w:pgMar w:top="720" w:right="720" w:bottom="720" w:left="720"/></w:sectPr></w:body></w:document>`;
const crcTable = Array.from({ length: 256 }, (_, n) => { let value = n; for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1; return value >>> 0; });
function crc32(bytes) { let value = 0xffffffff; for (const byte of bytes) value = crcTable[(value ^ byte) & 255] ^ (value >>> 8); return (value ^ 0xffffffff) >>> 0; }
function zip(entries) {
  const dataParts = [], directoryParts = []; let offset = 0;
  for (const [name, text] of entries) {
    const filename = Buffer.from(name), data = Buffer.from(text), crc = crc32(data);
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6); local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(filename.length, 26);
    dataParts.push(local, filename, data);
    const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x800, 8); central.writeUInt32LE(crc, 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(filename.length, 28); central.writeUInt32LE(offset, 42); directoryParts.push(central, filename); offset += local.length + filename.length + data.length;
  }
  const directory = Buffer.concat(directoryParts), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...dataParts, directory, end]);
}
const rel = (id, type, target) => `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}" Target="${target}"/>`;
const files = [
  ['[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>'],
  ['_rels/.rels', `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rel('rIdDoc','officeDocument','word/document.xml')}</Relationships>`],
  ['word/document.xml', documentXml], ['word/styles.xml', styles],
];
fs.writeFileSync(output, zip(files));
console.log(`Created ${output}; ${groups.reduce((n, group) => n + group.cases.length, 0)} functional test cases, a retest log, invitation, and two evaluation forms.`);
