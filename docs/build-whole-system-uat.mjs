import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';

// Start from the user's current UAT document so its page setup, tables, and
// visual style are retained. The supplied source document is never modified.
const template = 'C:/Users/jjama/OneDrive/Desktop/EMMAN THING/ic-laundry-functional-testing-uat-revised.docx';
const output = path.join(path.dirname(fileURLToPath(import.meta.url)), 'ic-laundry-whole-system-functional-uat.docx');

const adminCases = [
  ['TC-ADM-14', 'Review dashboard totals, recent orders, and workload signals with All Branches selected.', 'The overview reflects the selected scope; displayed totals agree with the underlying order, payment, and expense records.'],
  ['TC-ADM-15', 'Change the dashboard branch and date filters, then return to All Branches.', 'Cards, charts, and recent records update to the selected scope and do not retain values from the previous filter.'],
  ['TC-ADM-16', 'Create or update service pricing for a selected branch, including per-load and excess-weight rates where configured.', 'The saved service settings persist after reload and are used by new orders for the correct branch/service.'],
  ['TC-ADM-17', 'Configure automatic deductions and optional add-ons for a service using inventory from a different branch or an archived item.', 'Invalid, archived, or cross-branch items cannot be enabled; valid active items are saved only for the selected branch and service.'],
  ['TC-ADM-18', 'Receive or restock an inventory item using a valid quantity and review its stock history.', 'Stock increases by the entered quantity once and the action is recorded with the correct item, branch, actor, and timestamp.'],
  ['TC-ADM-19', 'Archive configured inventory, then restore it from the Recycle Bin.', 'Archiving disables active deduction and add-on links; restoring the item does not reactivate those links. Past order snapshots remain unchanged.'],
  ['TC-ADM-20', 'Create and edit Staff and Administrator accounts, including required branch assignment for Staff.', 'Staff has the selected branch and limited permissions; Administrator is global and has no branch assignment. Changes persist after reload.'],
  ['TC-ADM-21', 'Reset a Staff account credential and sign in using its temporary credential.', 'The old credential is rejected; the temporary credential requires password activation before protected work can continue.'],
  ['TC-ADM-22', 'Attempt to authenticate or recover access for a deleted/recycled account.', 'The account cannot obtain a new or reused session and receives a safe rejection.'],
  ['TC-ADM-23', 'Request password recovery and submit an incorrect, expired, reused, and valid one-time code in staging.', 'Invalid, expired, and reused codes are rejected; a valid code permits the authorized password change once.'],
  ['TC-ADM-24', 'Change the signed-in Administrator email using the required password and verification code.', 'The verified email is bound to the current account only; invalid/replayed codes and duplicate addresses are rejected.'],
  ['TC-ADM-25', 'Update allowed Settings values such as default processing time, ETA buffer, sample threshold, or undo window.', 'Valid values persist and are applied to later operations; invalid values are rejected with no partial save.'],
  ['TC-ADM-26', 'Create an expense with a branch, category, amount, and date, then review it in the expense list.', 'The expense is saved once with the selected branch/date and appears in reports for the correct scope.'],
  ['TC-ADM-27', 'Compare Analytics results for a branch/date range against its source orders, payment ledger, and expenses.', 'Revenue uses recorded collection dates/amounts, expenses use their expense dates, and cancelled orders follow the report rules.'],
  ['TC-ADM-28', 'Export the filtered Analytics report to CSV or workbook.', 'The export opens, contains the selected reporting scope and expected report sections, and excludes unrelated branch records.'],
  ['TC-ADM-29', 'Print or save the Analytics report as PDF.', 'The report is readable and identifies its branch scope, reporting period, generated date, summaries, and applicable forecasts.'],
  ['TC-ADM-30', 'Review inventory low-stock and usage/run-out signals for a branch.', 'Signals use that branch’s stock and available usage history; limited data is identified rather than presented as a certain date.'],
  ['TC-ADM-31', 'Review business forecasts and decision-support information with Gemini available and unavailable.', 'Forecasts are labeled as estimates; when Gemini is unavailable, the documented local fallback/unavailable state appears without blocking routine work.'],
  ['TC-ADM-32', 'Review the Audit Log after account, inventory, order-stage, cancellation, or restore actions.', 'The event identifies the action, record, actor, time, and branch when applicable; sensitive credentials and OTPs are not exposed.'],
  ['TC-ADM-33', 'Archive and restore a disposable customer, inventory item, or other supported record through Recycle Bin.', 'The record is removed from active views, can be restored once, and its historical links are preserved as designed.'],
  ['TC-ADM-34', 'Send a notification to a test email or phone using the configured delivery provider.', 'A valid test delivery is recorded, or a safe delivery failure is shown and auditable; secrets and OTP values are not exposed.'],
  ['TC-ADM-35', 'Attempt repeated invalid logins and contact submissions in staging until the configured rate limit is reached.', 'The system blocks excess requests with a clear retry message and resumes normally after the limit window.'],
  ['TC-ADM-36', 'Sign out, then revisit a protected URL and make a protected request with the expired session.', 'The session is rejected and protected data is not returned; a new valid sign-in restores access.'],
  ['TC-ADM-37', 'Review the global branch selector and branch-scoped records as an Administrator.', 'The Administrator can access authorized branches, while each selected view/report is scoped consistently.'],
  ['TC-ADM-38', 'Review loyalty reward eligibility and issued rewards for a test customer.', 'The reward status and eligibility are consistent with the order/customer record and Administrator-only controls stay protected.'],
];

const staffCases = [
  ['TC-STF-18', 'Open the Staff Dashboard and compare its orders, workload, and inventory signals with the assigned branch.', 'Only the assigned branch’s operational information is shown; totals match that branch’s records.'],
  ['TC-STF-19', 'Create an order with multiple services, separate weights, and branch-configured deductions/add-ons.', 'Each service is priced correctly; only active, available items configured for that branch and service are offered and applied.'],
  ['TC-STF-20', 'Create an order with an archived item that was restored but not reconfigured for its service.', 'The restored item is not offered as an add-on and is not automatically deducted until an Administrator re-enables its service link.'],
  ['TC-STF-21', 'Submit an order with missing required fields, invalid weight, invalid payment, or insufficient initial payment.', 'Validation identifies the issue; no order, payment, inventory deduction, or partial customer association is created.'],
  ['TC-STF-22', 'Advance an active order through each allowed processing stage and inspect its timeline.', 'Only permitted next-stage transitions succeed; timestamps, actor, status, ETA, and history are updated once.'],
  ['TC-STF-23', 'Attempt to skip a stage, change a released/cancelled order, or update an order belonging to another branch.', 'The operation is rejected and the order remains unchanged.'],
  ['TC-STF-24', 'Correct an order to the previous stage with and without a correction reason.', 'A valid correction requires a reason, records the change and revised ETA, and an invalid or unauthorized correction is rejected.'],
  ['TC-STF-25', 'Undo a recent stage change as the same Staff member, then try after expiry or from another account.', 'Only the permitted user can undo their own latest change within the configured window, and only once.'],
  ['TC-STF-26', 'Cancel a disposable active order with a reason and inspect inventory and order history.', 'Cancellation is recorded once, required stock is restored once, and the order is excluded from public tracking.'],
  ['TC-STF-27', 'Try to release a Ready for Pickup order before full payment, then pay the exact balance and release it.', 'Release is blocked until fully paid; after confirmation, payment totals, Released status, pickup time, and history agree.'],
  ['TC-STF-28', 'Restock inventory in the assigned branch, then attempt to restock an item in another branch.', 'The assigned-branch operation is audited; the cross-branch request is denied with no stock or expense change.'],
  ['TC-STF-29', 'Mark an eligible order Ready for Pickup when a test customer contact is configured.', 'The status/timestamp is saved and the ready notification is attempted for the intended test recipient or safely logged as failed.'],
  ['TC-STF-30', 'Review a customer’s order history and issued rewards from the permitted Staff workflow.', 'The correct customer/order information is displayed without exposing another branch’s records or Administrator-only controls.'],
  ['TC-STF-31', 'Try to open Settings, Staff administration, Analytics administration, Audit Log, and Recycle Bin as Staff.', 'Administrator-only pages and corresponding API operations remain inaccessible.'],
  ['TC-STF-32', 'Try to archive an inventory item through the interface and a protected request as Staff.', 'No usable archive action is available and a direct unauthorized request is rejected.'],
];

const publicCases = [
  ['TC-PUB-05', 'Submit the Contact Us form with missing fields and then valid test information.', 'Incomplete input is rejected before delivery; valid input shows a clear result without exposing internal errors.'],
  ['TC-PUB-06', 'Trigger the contact form honeypot or configured CAPTCHA/rate limit in staging.', 'Automated or excess submissions are blocked or silently discarded according to configuration; legitimate contact use remains possible.'],
  ['TC-PUB-07', 'Ask the public assistant a supported FAQ and follow its section link.', 'The assistant gives an appropriate public answer and the link navigates to the intended public section.'],
  ['TC-PUB-08', 'Search tracking using a cancelled order and an order number belonging to another customer.', 'Cancelled orders are not exposed; public results disclose only approved customer-safe order fields.'],
  ['TC-PUB-09', 'Open the landing page, contact form, public pricing, and tracking at desktop and mobile widths.', 'Public sections remain readable and usable; no protected dashboard or operational data is exposed.'],
];

const adminUat = [
  ['OA-15', 'The customer and order information I reviewed was clear and consistent with branch operations.'],
  ['OA-16', 'Inventory changes and service configurations are understandable and predictable.'],
  ['OA-17', 'Order, payment, and expense summaries help me review financial activity for the selected period.'],
  ['OA-18', 'Branch and date filters make reports relevant to the scope I selected.'],
  ['OA-19', 'The Analytics exports and printable report are useful for management review.'],
  ['OA-20', 'Staff account roles and branch assignments support the access needed for operations.'],
  ['OA-21', 'The Audit Log and Recycle Bin help me review and recover supported administrative changes.'],
  ['OA-22', 'Notifications provide useful information and make delivery failures understandable.'],
  ['OA-23', 'The forecast and decision-support information is understandable and clearly presented as an estimate.'],
  ['OA-24', 'The system supports the administrative and reporting tasks I performed.'],
];

const staffUat = [
  ['ST-16', 'The dashboard gives me a clear view of work for my assigned branch.'],
  ['ST-17', 'Creating an order for one or more services is clear and manageable.'],
  ['ST-18', 'The order total and payment/balance information are easy to verify.'],
  ['ST-19', 'Service-configured inventory deductions and add-ons behave as expected during order creation.'],
  ['ST-20', 'Archived or restored inventory is handled clearly for new orders and past order history.'],
  ['ST-21', 'Order status updates and correction history help me follow work accurately.'],
  ['ST-22', 'Cancellation and release safeguards help prevent mistakes.'],
  ['ST-23', 'Customer records and order history are easy to find for my branch.'],
  ['ST-24', 'Inventory and restock information supports my assigned branch tasks.'],
  ['ST-25', 'The system gives clear validation and feedback when an action cannot be completed.'],
];

const xmlEscape = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const decodeXml = value => value.replaceAll('&amp;', '&').replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&quot;', '"').replaceAll('&apos;', "'");
const cellsOf = row => [...row.matchAll(/<w:tc\b[^>]*>[\s\S]*?<\/w:tc>/g)].map(match => match[0]);
const rowText = row => cellsOf(row).map(cell => [...cell.matchAll(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g)].map(match => decodeXml(match[1])).join(''));
const rowsOf = table => [...table.matchAll(/<w:tr\b[^>]*>[\s\S]*?<\/w:tr>/g)].map(match => match[0]);

function setCell(cell, value) {
  let done = false;
  const result = cell.replace(/(<w:t\b[^>]*>)[\s\S]*?(<\/w:t>)/g, (_all, open, close) => {
    if (done) return `${open}${close}`;
    done = true;
    return `${open}${xmlEscape(value)}${close}`;
  });
  if (!done) throw new Error('Template cell has no editable text run.');
  return result;
}

function setRow(row, values) {
  let index = 0;
  const updated = row.replace(/<w:tc\b[^>]*>[\s\S]*?<\/w:tc>/g, cell => {
    const value = values[index++];
    return value === undefined ? cell : setCell(cell, value);
  });
  if (values.length > index) throw new Error('Template row has fewer cells than expected.');
  return updated;
}

function extendTable(table, dataCases, idPrefix) {
  const rows = rowsOf(table);
  const header = rows[0];
  let data = rows.slice(1);
  const seen = new Set(data.map(row => rowText(row)[0]));
  for (const entry of dataCases) {
    if (seen.has(entry[0])) throw new Error(`Duplicate test case ID ${entry[0]}.`);
    const exemplar = data.at(-1);
    data.push(setRow(exemplar, entry));
    seen.add(entry[0]);
  }
  const content = [header, ...data].join('');
  return `${table.slice(0, table.indexOf(rows[0]))}${content}${table.slice(table.lastIndexOf(rows.at(-1)) + rows.at(-1).length)}`;
}

function extendUatTable(table, additions) {
  const rows = rowsOf(table);
  const existing = rows.slice(1);
  const identifiers = new Set(existing.map(row => rowText(row)[0]));
  const additionsXml = additions.map(([id, statement]) => {
    if (identifiers.has(id)) throw new Error(`Duplicate UAT item ${id}.`);
    identifiers.add(id);
    // Current UAT rows have No., Statement, and five rating cells.
    return setRow(rows.at(-1), [id, statement]);
  });
  return `${table.slice(0, table.lastIndexOf(rows.at(-1)) + rows.at(-1).length)}${additionsXml.join('')}${table.slice(table.lastIndexOf(rows.at(-1)) + rows.at(-1).length)}`;
}

if (!fs.existsSync(template)) throw new Error(`Source document not found: ${template}`);
const archive = await JSZip.loadAsync(fs.readFileSync(template));
const part = archive.file('word/document.xml');
if (!part) throw new Error('Source document is missing word/document.xml.');
let xml = await part.async('string');
let index = 0;
xml = xml.replace(/<w:tbl\b[^>]*>[\s\S]*?<\/w:tbl>/g, table => {
  const current = index++;
  if (current === 0) return extendTable(table, adminCases, 'TC-ADM');
  if (current === 1) return extendTable(table, staffCases, 'TC-STF');
  if (current === 2) return extendTable(table, publicCases, 'TC-PUB');
  if (current === 4) return extendUatTable(table, adminUat);
  if (current === 5) return extendUatTable(table, staffUat);
  return table;
});
if (index !== 6) throw new Error(`Expected six source tables, found ${index}.`);
archive.file('word/document.xml', xml);
fs.writeFileSync(output, await archive.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
console.log(`Created ${output} from the supplied layout; ${adminCases.length + staffCases.length + publicCases.length} new functional cases and ${adminUat.length + staffUat.length} new UAT statements added.`);
