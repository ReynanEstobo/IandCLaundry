import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';

const dir = path.dirname(fileURLToPath(import.meta.url));
const template = 'C:/Users/jjama/OneDrive/Desktop/EMMAN THING/ic-laundry-functional-testing-uat.docx';
const output = path.join(dir, 'ic-laundry-functional-testing-uat-layout-preserved.docx');

const adminCases = [
  ['TC-ADM-01', 'Sign in with valid Administrator credentials.', 'Administrator dashboard opens and Administrator-only modules are available.'],
  ['TC-ADM-02', 'Attempt sign-in with an invalid password.', 'Sign-in is rejected and protected pages remain inaccessible.'],
  ['TC-ADM-03', 'Create a Staff account and assign a branch.', 'The account is provisioned with the selected branch and Staff permissions.'],
  ['TC-ADM-04', 'Attempt to open Analytics, Staff, or Service Configuration as Staff.', 'Administrator-only pages and protected requests are denied.'],
  ['TC-ADM-05', 'Create a new customer while placing an order.', 'The customer is saved once and linked to the new order; the system does not create a duplicate for an existing customer.'],
  ['TC-ADM-06', 'Update permitted customer contact information.', 'The permitted change is saved while existing orders and payment history remain linked.'],
  ['TC-ADM-07', 'Configure a service with branch-specific automatic inventory requirements and optional add-ons.', 'Only valid inventory items for the selected branch and service can be saved in that service configuration.'],
  ['TC-ADM-08', 'Archive an inventory item linked to an active service configuration.', 'A confirmation prompt explains that active links will be disabled. On confirmation, the item is archived and its active service links are deactivated; existing order history remains.'],
  ['TC-ADM-09', 'Restore an archived inventory item that had service links.', 'The item returns to active inventory, but its deduction and add-on service links remain inactive until an Administrator reconfigures them.'],
  ['TC-ADM-10', 'Attempt to archive inventory while signed in as Staff.', 'Staff has no usable archive action; a direct unauthorized request is rejected and the inventory item remains active.'],
  ['TC-ADM-11', 'Review orders and analytics using a selected branch and date range.', 'The displayed results reflect the chosen reporting scope and distinguish branch records.'],
  ['TC-ADM-12', 'Review demand forecasts and decision-support recommendations.', 'Estimates are labeled as estimates/advisory information; when Gemini is unavailable, the system provides a local fallback or a clear unavailable state without blocking routine transactions.'],
  ['TC-ADM-13', 'Generate or export an operational report.', 'The report reflects the selected scope and its totals agree with the underlying displayed records.'],
];

const staffAdditionalCase = [
  'TC-STF-17',
  'Create a new order after an inventory item linked to a service was archived.',
  'The archived item is not offered as an add-on and is not deducted; only currently active, valid service configurations are applied.',
];

const adminUatAddition = 'Restoring an archived inventory item does not unexpectedly reactivate its old service links.';
const staffUatAddition = 'An inventory item restored from archive is not used by new orders until its service configuration is enabled again.';

const esc = text => String(text)
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;');

function cellText(cell) {
  return [...cell.matchAll(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g)]
    .map(match => match[1]
      .replaceAll('&amp;', '&')
      .replaceAll('&lt;', '<')
      .replaceAll('&gt;', '>')
      .replaceAll('&quot;', '"')
      .replaceAll('&apos;', "'"))
    .join('');
}

function rowCells(row) {
  return [...row.matchAll(/<w:tc\b[^>]*>[\s\S]*?<\/w:tc>/g)].map(match => match[0]);
}

function setCellText(cell, text) {
  let replaced = false;
  return cell.replace(/(<w:t\b[^>]*>)[\s\S]*?(<\/w:t>)/g, (_whole, open, close) => {
    if (replaced) return `${open}${close}`;
    replaced = true;
    return `${open}${esc(text)}${close}`;
  });
}

function setRowCells(row, values) {
  let index = 0;
  const updated = row.replace(/<w:tc\b[^>]*>[\s\S]*?<\/w:tc>/g, cell => {
    const value = values[index];
    index += 1;
    return value === undefined ? cell : setCellText(cell, value);
  });
  if (values.length > index) throw new Error(`Expected at least ${values.length} cells but found ${index}.`);
  return updated;
}

function tableRows(table) {
  return [...table.matchAll(/<w:tr\b[^>]*>[\s\S]*?<\/w:tr>/g)].map(match => match[0]);
}

function idFromRow(row) {
  return cellText(rowCells(row)[0] || '');
}

function updateTable(table, tableIndex) {
  const rows = tableRows(table);
  if (tableIndex === 0) {
    const header = rows[0];
    const dataRows = rows.slice(1);
    const archiveIndex = dataRows.findIndex(row => idFromRow(row) === 'TC-ADM-08');
    if (archiveIndex < 0) throw new Error('Could not find TC-ADM-08 in the template.');
    const inserted = setRowCells(dataRows[archiveIndex], adminCases[archiveIndex + 1]);
    dataRows.splice(archiveIndex + 1, 0, inserted);
    if (dataRows.length !== adminCases.length) throw new Error('Administrator test case count did not match.');
    const revisedRows = dataRows.map((row, index) => setRowCells(row, adminCases[index]));
    return `${table.slice(0, table.indexOf(rows[0]))}${[header, ...revisedRows].join('')}${table.slice(table.lastIndexOf(rows.at(-1)) + rows.at(-1).length)}`;
  }

  if (tableIndex === 1) {
    const lastRow = rows.at(-1);
    const newRow = setRowCells(lastRow, staffAdditionalCase);
    const closing = '</w:tbl>';
    return `${table.slice(0, -closing.length)}${newRow}${closing}`;
  }

  if (tableIndex === 3 || tableIndex === 4) {
    const lastRow = rows.at(-1);
    const statement = tableIndex === 3 ? adminUatAddition : staffUatAddition;
    const newRow = setRowCells(lastRow, [statement]);
    const closing = '</w:tbl>';
    return `${table.slice(0, -closing.length)}${newRow}${closing}`;
  }

  return table;
}

if (!fs.existsSync(template)) throw new Error(`Template not found: ${template}`);
const archive = await JSZip.loadAsync(fs.readFileSync(template));
const documentPart = archive.file('word/document.xml');
if (!documentPart) throw new Error('Template is missing word/document.xml.');
let documentXml = await documentPart.async('string');
let tableIndex = 0;
documentXml = documentXml.replace(/<w:tbl\b[^>]*>[\s\S]*?<\/w:tbl>/g, table => updateTable(table, tableIndex++));
if (tableIndex !== 5) throw new Error(`Expected 5 template tables, found ${tableIndex}.`);
archive.file('word/document.xml', documentXml);
fs.writeFileSync(output, await archive.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
console.log(`Created ${output} from the supplied DOCX template; original layout and table styles retained.`);
