import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Builds a Word document containing I&C Laundry functional test cases and UAT forms.
const dir = path.dirname(fileURLToPath(import.meta.url));
const output = path.join(dir, 'ic-laundry-testing-and-evaluation-grouped.docx');
const pageWidth = 14040; // landscape letter, with 0.625-inch side margins
const parts = [];
const esc = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');

function run(text, { bold = false, italic = false, color = '24364B', size = null } = {}) {
  return `<w:r><w:rPr>${bold ? '<w:b/>' : ''}${italic ? '<w:i/>' : ''}<w:color w:val="${color}"/>${size ? `<w:sz w:val="${size}"/>` : ''}</w:rPr><w:t xml:space="preserve">${esc(text)}</w:t></w:r>`;
}
function paragraph(text, style = 'Normal', { pageBreak = false, keepNext = false, ...opts } = {}) {
  return `<w:p><w:pPr><w:pStyle w:val="${style}"/>${pageBreak ? '<w:pageBreakBefore/>' : ''}${keepNext ? '<w:keepNext/>' : ''}</w:pPr>${run(text, opts)}</w:p>`;
}
function add(text, style = 'Normal', opts = {}) { parts.push(paragraph(text, style, opts)); }
function heading(text, pageBreak = false) { add(text, 'Heading1', { pageBreak, keepNext: true }); }
function subheading(text, pageBreak = false) { add(text, 'Heading2', { pageBreak, keepNext: true }); }
function table(headers, rows, widths, { compact = false, apa = false } = {}) {
  const borders = ['top', 'left', 'bottom', 'right', 'insideH', 'insideV']
    .map(side => `<w:${side} w:val="single" w:sz="5" w:color="B8C9D8"/>`).join('');
  const tableBorders = apa
    ? '<w:top w:val="single" w:sz="8" w:color="000000"/><w:left w:val="nil"/><w:bottom w:val="single" w:sz="8" w:color="000000"/><w:right w:val="nil"/><w:insideH w:val="nil"/><w:insideV w:val="nil"/>'
    : borders;
  let xml = `<w:tbl><w:tblPr><w:tblW w:w="${pageWidth}" w:type="dxa"/><w:tblLayout w:type="fixed"/><w:tblBorders>${tableBorders}</w:tblBorders><w:tblCellMar><w:top w:w="${compact ? 55 : 85}" w:type="dxa"/><w:left w:w="75" w:type="dxa"/><w:bottom w:w="${compact ? 55 : 85}" w:type="dxa"/><w:right w:w="75" w:type="dxa"/></w:tblCellMar></w:tblPr><w:tblGrid>${widths.map(value => `<w:gridCol w:w="${value}"/>`).join('')}</w:tblGrid>`;
  for (const [index, row] of [headers, ...rows].entries()) {
    xml += `<w:tr><w:trPr><w:cantSplit/>${index === 0 ? '<w:tblHeader/>' : ''}</w:trPr>`;
    row.forEach((cell, col) => {
      const fill = index === 0 ? '174A6E' : (index % 2 ? 'F0F5F9' : 'FFFFFF');
      const color = index === 0 ? (apa ? '000000' : 'FFFFFF') : '24364B';
      const size = compact ? 16 : 18;
      const value = String(cell ?? '');
      const content = value.split('\n').map((line, lineIndex) => `${lineIndex ? '<w:r><w:br/></w:r>' : ''}${run(line, { bold: index === 0 || (index > 0 && col === 0), color, size })}`).join('');
      const headerRule = apa && index === 0 ? '<w:tcBorders><w:bottom w:val="single" w:sz="6" w:color="000000"/></w:tcBorders>' : '';
      const shading = apa ? '' : `<w:shd w:val="clear" w:fill="${fill}"/>`;
      xml += `<w:tc><w:tcPr><w:tcW w:w="${widths[col]}" w:type="dxa"/>${shading}${headerRule}<w:vAlign w:val="top"/></w:tcPr><w:p><w:pPr><w:pStyle w:val="TableText"/></w:pPr>${content}</w:p></w:tc>`;
    });
    xml += '</w:tr>';
  }
  parts.push(`${xml}</w:tbl>${paragraph('', 'AfterTable')}`);
}

const adminCases = [
  ['ADM-01', 'Administrator sign-in and access', 'An active administrator account is available and signed out.', 'Sign in with valid credentials, then open Analytics, Staff, Settings, and Recycle Bin.', 'The administrator reaches the dashboard and can open administrator-only modules.'],
  ['ADM-02', 'Create a branch-assigned staff account', 'Administrator is signed in; a valid test branch and unused account details are available.', 'Open Staff, create a staff account, assign one branch, save, then review the staff list.', 'The account is saved with the staff role and selected branch; the account is not given global administrator access.'],
  ['ADM-03', 'Create an inventory item', 'Administrator is signed in; a test branch and unique item name are available.', 'Open Inventory, add an item, select its unit and branch, enter starting stock and minimum level, and save.', 'The item appears once with the entered unit, quantities, and branch.'],
  ['ADM-04', 'Restock inventory and record cost', 'A test inventory item exists in a selected branch.', 'Restock the item with a positive quantity, total cost, and supplier; review stock, restock history, and expenses.', 'Stock increases for the selected branch, a restock entry is recorded, and the related expense is reflected once.'],
  ['ADM-05', 'Create an order for a selected branch', 'An active service and sufficient branch stock exist; a valid customer and cash payment at or above the required minimum are prepared.', 'Create an order as administrator, select a branch, add service and weight, enter payment, and submit once.', 'The order is created once for the selected branch with the correct service, price, payment state, and initial Received status.'],
  ['ADM-06', 'Reject an invalid order submission', 'Administrator is signed in; use a disposable test form without submitting valid data.', 'Attempt to submit with a missing branch, invalid weight, or payment below the allowed minimum.', 'Validation prevents order creation and no customer, payment, or inventory side effect is recorded.'],
  ['ADM-07', 'Review and complete an order payment', 'A test order with a remaining balance exists.', 'Record a partial payment, review payment status, then record the exact remaining cash balance.', 'Recorded paid amount and payment status update correctly; a Ready order can only be Released after full payment.'],
  ['ADM-08', 'Review an order stage history', 'A test order is available and its stage history can be inspected.', 'Advance the order through permitted stages, then make a backward correction with a reason.', 'Only allowed stage transitions occur; the correction reason and stage/ETA history are retained.'],
  ['ADM-09', 'Cancel an active order', 'A disposable active order has inventory usage recorded.', 'Cancel it with a reason; inspect status, inventory, audit/history, and public tracking.', 'The order is marked cancelled, inventory is restored once, the reason is recorded, and public tracking does not expose the cancelled order.'],
  ['ADM-10', 'Filter analytics by branch and date range', 'Administrator has access to test records in more than one branch and date period.', 'Open Analytics, change branch and date filters, and compare summary cards, charts, and tables.', 'All analytics sections update to the selected scope and exclude records according to displayed report rules.'],
  ['ADM-11', 'Export analytics report', 'Analytics has loaded for a selected range and branch scope.', 'Export CSV and print/save the report as PDF; compare visible values and selected filters.', 'Exports are readable and correspond to the selected scope and range without mixing unrelated branch records.'],
  ['ADM-12', 'Review revenue and demand forecast', 'Forecast data is available; if Gemini is used, the provider can be made unavailable in a staging test.', 'Open Analytics forecast, note the forecast title, values, date range, confidence/method, and fallback state.', 'Forecast values are clearly labeled as estimates. If Gemini is unavailable or data is limited, the local fallback is identified and confidence is not overstated.'],
  ['ADM-13', 'Review DSS insights and recommendations', 'Analytics metrics, forecast, and operational signals are available or intentionally sparse.', 'Open the DSS overview and inspect its insights, evidence, and suggested next actions.', 'Insights correspond to supplied signals, express uncertainty when data is limited, and present recommendations as optional decision support.'],
  ['ADM-14', 'Review loyalty rewards', 'Loyalty is enabled and a test customer has qualifying reward records.', 'Open the rewards view, inspect eligibility and status, then revoke a disposable eligible reward with a reason if appropriate.', 'Reward details and status are displayed accurately; an authorized revocation is recorded and cannot be performed by staff.'],
  ['ADM-15', 'Restore a deleted record', 'Administrator is signed in; a disposable test record has been archived.', 'Open Recycle Bin, locate the record, restore it, and verify its active list and audit entry.', 'The record returns to the active list once and the restore action is traceable.'],
];

const staffCases = [
  ['STF-01', 'Staff sign-in and branch scope', 'An active staff account assigned to a branch is available and signed out.', 'Sign in and open Dashboard, Orders, Customers, and Inventory; attempt to access an administrator-only route.', 'Staff can access operational modules for the assigned branch; administrator-only access is denied.'],
  ['STF-02', 'Create an order for a new customer', 'Staff is signed in; required services and branch stock are available; valid unused customer contact details are prepared.', 'Open New Order, enter customer details, choose service and weight, enter an allowed cash payment, and submit once.', 'Customer and order are created once, linked to the staff branch, and the order begins in Received status with correct pricing/payment.'],
  ['STF-03', 'Create an order for an existing customer', 'An active customer with a matching phone number exists in the staff branch.', 'Start New Order, search by the customer phone, select the existing customer, complete order details, and submit.', 'The existing customer is selected without a duplicate customer record; the new order is linked to that customer and branch.'],
  ['STF-04', 'Reject invalid order inputs', 'Staff is signed in and the New Order form is open.', 'Try missing required fields, zero/invalid weight, or a payment below the configured minimum; submit each attempt.', 'Each invalid attempt shows a validation message and creates no order, payment, or inventory deduction.'],
  ['STF-05', 'Deduct inventory for order services', 'The assigned branch has sufficient stock and each selected service has configured inventory usage.', 'Create an order with one or more services, then inspect stock and usage logs for the assigned branch.', 'Configured quantities and units are deducted for the correct branch once per order; no unrelated branch stock changes.'],
  ['STF-06', 'Prevent order creation when stock is insufficient', 'The selected service requires more stock than is available at the staff branch.', 'Attempt to place the order and inspect order, payment, customer-branch association, stock, and usage log.', 'The operation is rejected without partial order/payment records or inventory changes.'],
  ['STF-07', 'Advance an order through service stages', 'A Received order assigned to the staff branch is available.', 'Move it to On Process, then Ready for Pickup using the page controls.', 'Each permitted step updates the order status and its corresponding processing/ready timestamps.'],
  ['STF-08', 'Search within a selected status filter', 'Orders exist in at least two statuses, including order numbers that can be searched.', 'Select one status filter, search for an order in that status, then search for a matching order in another status.', 'Search results remain constrained by the selected status; the matching order from another status is not shown.'],
  ['STF-09', 'Correct an order stage backward', 'An assigned-branch order is at On Process or Ready for Pickup.', 'Move the order back one stage and provide a correction reason when prompted.', 'The backward correction is allowed only through the correction flow; reason, revised ETA, and history are recorded.'],
  ['STF-10', 'Record partial and final balance payments', 'A valid order with a remaining balance exists in the assigned branch.', 'Record a partial cash payment, verify the balance, then submit the exact remaining balance.', 'Payment records and balance update accurately; the order cannot be released before fully paid.'],
  ['STF-11', 'Release a fully paid order', 'An order is Ready for Pickup and fully paid.', 'Confirm pickup/release using the available order action.', 'The order becomes Released and the pickup timestamp is saved; further active-stage edits are blocked.'],
  ['STF-12', 'Restock only the assigned branch', 'Staff is signed in; an inventory item belongs to the assigned branch.', 'Submit a valid restock, then attempt to restock an item belonging to another branch.', 'A valid restock updates only the assigned branch and is logged; another-branch item is rejected.'],
  ['STF-13', 'View the branch customer directory', 'Staff is signed in and customers exist in multiple branches.', 'Open Customers and search for a customer assigned to the staff branch and another branch.', 'The list exposes only permitted customers for the staff branch and excludes archived records.'],
  ['STF-14', 'Review ETA on a new order', 'A service has a configured default ETA; comparable history may be available for a test branch.', 'Create a comparable order and review the saved ETA and its displayed source/revised label.', 'The order receives one saved ETA based on the applicable configured or historical method; later settings changes do not silently rewrite it.'],
  ['STF-15', 'Verify a ready-for-pickup notification', 'A test order has a customer email address and the email provider is configured for staging.', 'Move the order to Ready for Pickup and inspect the test inbox and safe delivery result.', 'A ready notification is attempted for the test recipient; message details are correct and secrets or unrelated customer data are not exposed.'],
];

const publicCases = [
  ['PUB-01', 'Track an active laundry order', 'A non-cancelled test order has a valid tracking number.', 'Open the public tracking page while signed out and search using the complete tracking number.', 'Public tracking displays only customer-safe order status, service/weight, and ETA information.'],
  ['PUB-02', 'Reject invalid or cancelled tracking requests', 'An invalid number and a cancelled test order are available.', 'Search with an incomplete tracking number, then attempt to track the cancelled order.', 'Invalid input is rejected; cancelled orders are not returned; customer, payment, and staff details remain private.'],
  ['PUB-03', 'Submit the landing-page contact form safely', 'Turnstile site and secret keys and a test inbox are configured in staging.', 'Submit incomplete fields; submit with an unchecked/expired security token; then submit valid test details with a completed Turnstile check.', 'Invalid attempts are rejected without email delivery. A valid request passes server-side verification and reaches only the configured test inbox.'],
  ['PUB-04', 'Apply contact-form bot and rate protections', 'Contact form rate limiting and Turnstile are active in staging; do not use production.', 'Submit with the honeypot populated, then exceed the configured contact request limit using test data.', 'Honeypot submissions are silently discarded; rate-limited requests are blocked; no contact email is sent for blocked submissions.'],
];

const adminSurvey = [
  'The system restricts administrative functions to authorized accounts.',
  'The dashboard and branch filters help me monitor operations across branches.',
  'Analytics clearly presents sales, service demand, branch productivity, and customer trends.',
  'Reports and exports are understandable and match the selected reporting scope.',
  'The revenue and demand forecast is clearly labeled, and its uncertainty is understandable.',
  'DSS insights are relevant to the operational data displayed.',
  'DSS recommendations are practical options and leave final decisions to management.',
  'Inventory and loyalty information help me identify items or records needing review.',
  'The system responds reliably during the management tasks I performed.',
  'Overall, the system supports my monitoring and decision-making responsibilities.',
];
const staffSurvey = [
  'The system is easy to navigate for my daily branch tasks.',
  'Creating or finding a customer and recording an order is clear.',
  'Order service, payment, and status information is easy to understand.',
  'Inventory quantities and units are clear when I create or process an order.',
  'The system prevents invalid entries and explains what needs correction.',
  'The order list search and filters help me find the correct order.',
  'The system responds reliably while I complete operational tasks.',
  'The information shown for my branch is relevant to my work.',
  'The system helps me complete work more efficiently than the previous process.',
  'Overall, I am satisfied with the system for my assigned responsibilities.',
];

add('I&C LAUNDRY', 'Kicker');
add('TESTING AND EVALUATION', 'Title');
add('Functional Test Cases and User Acceptance Evaluation', 'Subtitle');
add('Prepared for system evaluation. Execute manual cases in a test/staging environment and record actual results and status during execution.', 'Intro');

heading('Purpose and Evaluation Setup');
add('This document provides role-based functional test cases and user evaluation forms for the I&C Laundry system, including Administrator, Staff, and public-facing workflows.');
add('Functional testing records whether a specified action produces its expected system result. User Acceptance Testing (UAT) gathers owner/administrator and staff feedback using the 5-point scale and reports the collected responses in the blank result tables.');
add('Respondent count: __________ (verify the active owner/administrator and staff roster before evaluation). Evaluation date: __________. Environment/version: __________.');
add('Rating scale: 5 – Strongly Agree; 4 – Agree; 3 – Neutral; 2 – Disagree; 1 – Strongly Disagree. Respondents should rate only features they personally tested.');
add('Execution note: Actual Result and Status cells are intentionally blank. Use a separate approved staging environment for tests that create, update, cancel, or delete records.');

heading('Alignment Notes for the Manuscript');
table(['Topic', 'Finding to verify or align'], [
  ['Roles and participant forms', 'The application has Administrator and Staff roles. The reference’s Meter Reader and Consumer forms do not map directly; this document uses owner/administrator and staff forms. Public order tracking is not an authenticated consumer portal.'],
  ['AI and forecasting description', 'Forecasting and DSS are Gemini-assisted when a usable provider response is available, with deterministic local fallback behavior for sparse data or provider errors. Describe this as AI-assisted with fallback, not as Gemini being the only calculation path.'],
  ['Completed evaluation claims', 'The manuscript describes testing and evaluation in future tense. Do not report UAT, usability, performance, forecast-accuracy, weighted-mean, or satisfaction results until they have been conducted and documented.'],
  ['Respondents and statistics', 'The manuscript specifies owner plus all staff and a 5-point Likert scale/weighted mean. Confirm the live roster and respondent count; add the approved interpretation ranges and actual calculations only after the instrument and data are finalized.'],
  ['Performance and forecast accuracy', 'No performance thresholds or forecast-accuracy results are supplied in the current materials. Record measured results and an adviser-approved acceptance criterion before claiming these evaluations passed.'],
  ['Automated suite baseline', 'On 14 October 2026, npm.cmd test reported 87 passing and 2 failing out of 89. Both failures are assertions about workload-summary wording (expected “expected today” wording); they are not evidence that all testing passed.'],
], [2550, 11490], { compact: true });

heading('Part I — Functional Testing', true);
add('Functional testing verifies that system actions produce the expected outcomes. Record the actual result and mark each case Pass or Fail only after execution.');
subheading('Administrator Functional Test Cases');
table(['Test Case ID', 'Test Case Description', 'Expected Result', 'Actual Result', 'Status'], adminCases.map(([id, desc, pre, steps, expected]) => [id, `${desc}\nPreconditions: ${pre}\nSteps: ${steps}`, expected, '', '']), [1050, 5650, 4300, 2050, 990], { compact: true });

subheading('Staff Functional Test Cases', true);
table(['Test Case ID', 'Test Case Description', 'Expected Result', 'Actual Result', 'Status'], staffCases.map(([id, desc, pre, steps, expected]) => [id, `${desc}\nPreconditions: ${pre}\nSteps: ${steps}`, expected, '', '']), [1050, 5650, 4300, 2050, 990], { compact: true });

subheading('Public-Page Functional Test Cases', true);
table(['Test Case ID', 'Test Case Description', 'Expected Result', 'Actual Result', 'Status'], publicCases.map(([id, desc, pre, steps, expected]) => [id, `${desc}\nPreconditions: ${pre}\nSteps: ${steps}`, expected, '', '']), [1050, 5650, 4300, 2050, 990], { compact: true });

subheading('Corrective Action and Retest Log', true);
add('Use this log when a test fails. Record the original result, the correction made, and the result after retesting.');
table(['Test Case ID', 'Initial Result', 'Corrective Action', 'Retest Result', 'Date / Tester'], Array.from({ length: 8 }, () => ['', '', '', '', '']), [1600, 2700, 5200, 2700, 1840], { compact: true });

function addEvaluationForm(title, prefix, statements) {
  subheading(title, true);
  add('Respondent role: ____________________    Name (optional): ____________________    Date: ____________________');
  add('Instructions: After testing the relevant system functions, place one check mark in the response column that best represents your opinion. Leave an item blank if you did not test that feature.');
  const rows = statements.map((statement, index) => [`${prefix}-${String(index + 1).padStart(2, '0')}`, statement, '☐', '☐', '☐', '☐', '☐']);
  table(['No.', 'Evaluation Statement', '5', '4', '3', '2', '1'], rows, [850, 8190, 1000, 1000, 1000, 1000, 1000], { compact: true });
  add('Comments or suggested improvements: ____________________________________________________________________________________');
  add('____________________________________________________________________________________________________________________________');
}
heading('Part II — User Acceptance Testing (UAT)', true);
add('UAT gathers the owner/administrator and staff members’ feedback after they use the system features relevant to their roles. Complete the response forms after the functional testing activities.');
addEvaluationForm('Administrator / Owner Evaluation Form', 'AD', adminSurvey);
addEvaluationForm('Staff Evaluation Form', 'ST', staffSurvey);

function addUatResults(group, tableNumber, prefix, statements, pageBreak = false) {
  subheading(`${group} UAT Results Summary`, pageBreak);
  add(`Table ${tableNumber}`, 'TableNumber');
  add(`Distribution of ${group} UAT Responses by Evaluation Item`, 'TableTitle');
  const rows = statements.map((statement, index) => [
    `${prefix}-${String(index + 1).padStart(2, '0')}`, statement, '', '', '', '', '', '', '',
  ]);
  table(['Item', 'Evaluation statement', 'n', '1 (%)', '2 (%)', '3 (%)', '4 (%)', '5 (%)', 'M', 'SD'], rows,
    [650, 6940, 650, 800, 800, 800, 800, 800, 900, 900], { compact: true, apa: true });
  add('Note. N = ______. Rating scale: 1 = Strongly Disagree, 2 = Disagree, 3 = Neutral, 4 = Agree, 5 = Strongly Agree. M = mean; SD = standard deviation. Percentages are based on valid responses for each item.', 'TableNote');
}
subheading('UAT Results Summary Tables', true);
add('After collecting completed UAT forms, summarize each item using the valid response count, percentage distribution across the five scale points, mean, and standard deviation. Leave this section blank until responses have been collected and checked.');
addUatResults('Administrator / Owner', 1, 'AD', adminSurvey);
addUatResults('Staff', 2, 'ST', staffSurvey, true);

heading('Evaluation Record and Sign-Off', true);
table(['Record', 'Details'], [
  ['System version / environment', ''],
  ['Evaluation date(s)', ''],
  ['Verified number of respondents', ''],
  ['Completed test cases / evidence location', ''],
  ['Open defects and retest status', ''],
  ['Summary of evaluation findings', ''],
  ['Owner / administrator acknowledgment', 'Name: ______________________________  Signature: ______________________________  Date: ______________'],
  ['Researcher / evaluator', 'Name: ______________________________  Signature: ______________________________  Date: ______________'],
], [4200, 9840]);
add('Do not fill the summary with assumed outcomes. Report the actual questionnaire responses and test evidence, and use only the statistical interpretation ranges approved for the study.');

const styleDefinitions = [
  ['Normal', '', '<w:jc w:val="both"/><w:ind w:firstLine="0"/><w:spacing w:after="120" w:line="250" w:lineRule="auto"/>', '<w:sz w:val="20"/>'],
  ['Kicker', 'Normal', '<w:jc w:val="center"/><w:ind w:firstLine="0"/><w:spacing w:before="1000" w:after="100"/>', '<w:b/><w:color w:val="1280A8"/><w:sz w:val="25"/>'],
  ['Title', 'Normal', '<w:jc w:val="center"/><w:ind w:firstLine="0"/><w:spacing w:after="100"/>', '<w:b/><w:color w:val="173B5E"/><w:sz w:val="36"/>'],
  ['Subtitle', 'Normal', '<w:jc w:val="center"/><w:ind w:firstLine="0"/><w:spacing w:after="160"/>', '<w:color w:val="5B7185"/><w:sz w:val="23"/>'],
  ['Intro', 'Normal', '<w:jc w:val="center"/><w:ind w:firstLine="0"/><w:spacing w:after="300"/>', '<w:color w:val="5B7185"/><w:sz w:val="19"/>'],
  ['Heading1', 'Normal', '<w:jc w:val="left"/><w:ind w:firstLine="0"/><w:keepNext/><w:outlineLvl w:val="0"/><w:spacing w:before="230" w:after="120"/>', '<w:b/><w:color w:val="173B5E"/><w:sz w:val="25"/>'],
  ['Heading2', 'Normal', '<w:jc w:val="left"/><w:ind w:firstLine="0"/><w:keepNext/><w:outlineLvl w:val="1"/><w:spacing w:before="180" w:after="90"/>', '<w:b/><w:color w:val="245B7A"/><w:sz w:val="22"/>'],
  ['TableNumber', 'Normal', '<w:jc w:val="left"/><w:keepNext/><w:spacing w:before="120" w:after="40"/>', '<w:b/><w:sz w:val="20"/>'],
  ['TableTitle', 'Normal', '<w:jc w:val="left"/><w:keepNext/><w:spacing w:after="100"/>', '<w:i/><w:sz w:val="20"/>'],
  ['TableNote', 'Normal', '<w:jc w:val="left"/><w:spacing w:before="60" w:after="180"/>', '<w:sz w:val="18"/>'],
  ['TableText', 'Normal', '<w:jc w:val="left"/><w:spacing w:after="0" w:line="225" w:lineRule="auto"/>', '<w:sz w:val="18"/>'],
  ['AfterTable', 'Normal', '<w:ind w:firstLine="0"/><w:spacing w:after="80" w:line="50" w:lineRule="exact"/>', '<w:sz w:val="4"/>'],
];
const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial"/><w:color w:val="24364B"/><w:sz w:val="20"/><w:lang w:val="en-PH"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:widowControl/></w:pPr></w:pPrDefault></w:docDefaults>${styleDefinitions.map(([id, base, pPr, rPr]) => `<w:style w:type="paragraph" w:styleId="${id}"${id === 'Normal' ? ' w:default="1"' : ''}><w:name w:val="${id}"/>${base ? `<w:basedOn w:val="${base}"/>` : ''}<w:pPr>${pPr}</w:pPr><w:rPr>${rPr}</w:rPr></w:style>`).join('')}</w:styles>`;
const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${parts.join('')}<w:sectPr><w:pgSz w:w="15840" w:h="12240" w:orient="landscape"/><w:pgMar w:top="900" w:right="900" w:bottom="900" w:left="900" w:header="450" w:footer="450"/><w:cols w:space="720"/></w:sectPr></w:body></w:document>`;
const relationship = (id, type, target) => `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}" Target="${target}"/>`;
const files = [
  ['[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>'],
  ['_rels/.rels', `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${relationship('rIdDoc', 'officeDocument', 'word/document.xml')}<Relationship Id="rIdCore" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>`],
  ['docProps/core.xml', '<?xml version="1.0" encoding="UTF-8"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>I&amp;C Laundry Testing and Evaluation</dc:title><dc:creator>I&amp;C Laundry Project</dc:creator><dc:description>Role-based functional test cases and user acceptance evaluation forms.</dc:description></cp:coreProperties>'],
  ['word/document.xml', documentXml],
  ['word/styles.xml', styles],
  ['word/_rels/document.xml.rels', `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${relationship('rIdStyles', 'styles', 'styles.xml')}</Relationships>`],
];

const crcTable = Array.from({ length: 256 }, (_, n) => { let value = n; for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1; return value >>> 0; });
function crc32(bytes) { let value = 0xffffffff; for (const byte of bytes) value = crcTable[(value ^ byte) & 255] ^ (value >>> 8); return (value ^ 0xffffffff) >>> 0; }
function zip(entries) {
  const dataParts = [], directoryParts = [];
  let offset = 0;
  for (const [name, value] of entries) {
    const filename = Buffer.from(name), data = Buffer.isBuffer(value) ? value : Buffer.from(value), crc = crc32(data);
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6); local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(filename.length, 26);
    dataParts.push(local, filename, data);
    const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x800, 8); central.writeUInt32LE(crc, 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(filename.length, 28); central.writeUInt32LE(offset, 42); directoryParts.push(central, filename); offset += local.length + filename.length + data.length;
  }
  const directory = Buffer.concat(directoryParts), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...dataParts, directory, end]);
}

if (adminCases.length !== 15 || staffCases.length !== 15 || publicCases.length !== 4) throw new Error('Expected 15 Administrator, 15 Staff, and 4 public functional test cases.');
fs.writeFileSync(output, zip(files));
console.log(JSON.stringify({ output, administratorCases: adminCases.length, staffCases: staffCases.length, publicCases: publicCases.length, bytes: fs.statSync(output).size }, null, 2));
