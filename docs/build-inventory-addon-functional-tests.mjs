import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const output = path.join(dir, 'inventory-addon-functional-tests.docx');
const esc = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const run = (text, bold = false) => `<w:r><w:rPr>${bold ? '<w:b/>' : ''}<w:sz w:val="20"/></w:rPr><w:t xml:space="preserve">${esc(text)}</w:t></w:r>`;
const p = (text, style = 'Normal', pageBreak = false) => `<w:p><w:pPr><w:pStyle w:val="${style}"/>${pageBreak ? '<w:pageBreakBefore/>' : ''}</w:pPr>${run(text)}</w:p>`;
const cases = [
  {
    scenario: 'Administrator archives inventory linked to services.', id: 'INV-ADD-01',
    description: 'Verify that archiving configured inventory warns the administrator and automatically disables its active service links.',
    preconditions: 'Signed in as administrator. A non-critical inventory item is active and linked to at least one active automatic-deduction or optional-add-on service configuration. Use a test branch.',
    steps: ['Open Inventory and locate the configured item.', 'Select Archive.', 'Review the confirmation prompt and confirm the archive.', 'Check the item in Recycle Bin and inspect its service configurations.'],
    expected: 'The prompt states that active service links will be disabled and the item will stop being offered or deducted for new orders. After confirmation, the item is archived, the prior service links are inactive, and the item remains restorable. No historical order details are changed.',
  },
  {
    scenario: 'Staff attempts to archive an inventory item.', id: 'INV-ADD-02',
    description: 'Verify that staff cannot archive inventory through the page or resource API.',
    preconditions: 'Signed in as staff with access to the Inventory page. An active test inventory item exists in the staff member’s branch.',
    steps: ['Open Inventory as staff.', 'Check the available actions for the test item.', 'If an archive request can be initiated, attempt it.', 'Verify the item remains active and visible.'],
    expected: 'Staff has no usable archive action. A direct unauthorized archive request is rejected by the server, and the item remains active.',
  },
  {
    scenario: 'New order after a configured inventory item is archived.', id: 'INV-ADD-03',
    description: 'Verify that a service remains usable for a new order after an associated inventory item is archived and delinked.',
    preconditions: 'An active service has an archived inventory item in its former configuration. Other required active inventory and any selected add-ons have sufficient stock. Signed in to the matching branch.',
    steps: ['Open Orders and start a new order.', 'Select the service previously linked to the archived item.', 'Review automatic deductions and available add-ons.', 'Complete valid customer, weight, and cash payment details, then create the order.', 'Check inventory stock and the saved order details.'],
    expected: 'The archived item is not offered as an add-on or used for automatic deduction. The service is available if its remaining configuration is valid; the order succeeds and only valid configured inventory is deducted. If a required automatic deduction is no longer configured, the system reports that clearly and prevents an invalid order rather than failing with a stale-link error.',
  },
  {
    scenario: 'Historical order displays its add-on after inventory is archived.', id: 'INV-ADD-04',
    description: 'Verify that an existing order continues to show the add-on details saved when the order was created.',
    preconditions: 'A test order exists with an add-on. Its order add-on row contains item-name, quantity, unit-price, and subtotal snapshots. The associated inventory item is subsequently archived.',
    steps: ['Open the Orders page.', 'Expand the service details for the existing order in table or board view.', 'Review the add-on name, quantity, and subtotal.', 'Compare them with the saved order snapshot values.'],
    expected: 'The add-on appears under the correct service on that order, with its saved item name, quantity, and subtotal. Display does not depend on the current active service configuration or inventory label.',
  },
  {
    scenario: 'Remove a service add-on configuration used by an old order.', id: 'INV-ADD-05',
    description: 'Verify that removing a configuration preserves order snapshots and that the database rejects a combined unlink-and-edit.',
    preconditions: 'A test order has an order_item_addons record associated with a service_addon_items configuration. The test environment has migrations 20261003, 20261004, and 20261005 applied.',
    steps: ['Record the order add-on snapshot values and configuration link.', 'Delete the test service add-on configuration using the authorized database workflow.', 'Reload the order and inspect the saved add-on.', 'In a controlled database test, attempt to clear service_addon_item_id and change quantity in the same update.'],
    expected: 'Deleting the configuration sets the historical service_addon_item_id to NULL while preserving the inventory reference and all snapshot values; the old order still displays the add-on. The combined unlink-and-edit update is rejected. Do not physically delete the inventory item while historical rows reference it.',
  },
];

function table(rows) {
  const widths = [2400, 6960], total = 9360;
  const border = ['top','left','bottom','right','insideH','insideV'].map(side => `<w:${side} w:val="single" w:sz="6" w:color="B8C9D8"/>`).join('');
  let xml = `<w:tbl><w:tblPr><w:tblW w:w="${total}" w:type="dxa"/><w:tblLayout w:type="fixed"/><w:tblBorders>${border}</w:tblBorders><w:tblCellMar><w:top w:w="100" w:type="dxa"/><w:left w:w="120" w:type="dxa"/><w:bottom w:w="100" w:type="dxa"/><w:right w:w="120" w:type="dxa"/></w:tblCellMar></w:tblPr><w:tblGrid><w:gridCol w:w="${widths[0]}"/><w:gridCol w:w="${widths[1]}"/></w:tblGrid>`;
  rows.forEach(([label, value], index) => {
    xml += '<w:tr><w:trPr><w:cantSplit/></w:trPr>';
    [label, value].forEach((text, col) => {
      const fill = index % 2 ? 'F0F5F9' : 'FFFFFF';
      const content = String(text).split('\n').map((line, i) => `${i ? '<w:r><w:br/></w:r>' : ''}${run(line, col === 0)}`).join('');
      xml += `<w:tc><w:tcPr><w:tcW w:w="${widths[col]}" w:type="dxa"/><w:shd w:val="clear" w:fill="${fill}"/><w:vAlign w:val="top"/></w:tcPr><w:p>${content}</w:p></w:tc>`;
    });
    xml += '</w:tr>';
  });
  return `${xml}</w:tbl>${p('')}`;
}

const body = [p('I&C LAUNDRY', 'Kicker'), p('INVENTORY AND ADD-ON FUNCTIONAL TESTS', 'Title'), p('Archive behavior, service configuration, order creation, and historical order details', 'Subtitle'), p('Execute in a test environment. Record actual results and status during execution.'), ...cases.flatMap((test, index) => [
  p(`Example Scenario: ${test.scenario}`, 'Heading1', index > 0),
  table([
    ['Test Case ID', test.id],
    ['Test Description', test.description],
    ['Preconditions', test.preconditions],
    ['Steps to Execute', test.steps.map((step, i) => `${i + 1}. ${step}`).join('\n')],
    ['Expected Results', test.expected],
    ['Actual Results', 'To be filled during execution.'],
    ['Status', 'Not executed'],
    ['Remarks / Evidence', 'To be filled during execution.'],
  ]),
])].join('');

const styles = `<?xml version="1.0" encoding="UTF-8"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial"/><w:sz w:val="20"/></w:rPr></w:rPrDefault></w:docDefaults>${[
  ['Normal','<w:spacing w:after="120" w:line="260" w:lineRule="auto"/>','<w:sz w:val="20"/>'],
  ['Kicker','<w:jc w:val="center"/><w:spacing w:before="1200" w:after="120"/>','<w:b/><w:color w:val="1280A8"/><w:sz w:val="26"/>'],
  ['Title','<w:jc w:val="center"/><w:spacing w:after="120"/>','<w:b/><w:color w:val="173B5E"/><w:sz w:val="34"/>'],
  ['Subtitle','<w:jc w:val="center"/><w:spacing w:after="240"/>','<w:color w:val="5B7185"/><w:sz w:val="21"/>'],
  ['Heading1','<w:keepNext/><w:spacing w:before="200" w:after="100"/>','<w:b/><w:color w:val="173B5E"/><w:sz w:val="24"/>'],
].map(([id,ppr,rpr]) => `<w:style w:type="paragraph" w:styleId="${id}"${id==='Normal'?' w:default="1"':''}><w:name w:val="${id}"/><w:pPr>${ppr}</w:pPr><w:rPr>${rpr}</w:rPr></w:style>`).join('')}</w:styles>`;
const documentXml = `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="900" w:right="1080" w:bottom="900" w:left="1080"/></w:sectPr></w:body></w:document>`;
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
console.log(`Created ${output} with ${cases.length} functional test cases.`);
