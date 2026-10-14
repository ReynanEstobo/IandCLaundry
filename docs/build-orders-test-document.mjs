import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Builds the Word test document for the three selected system workflows.
const dir = path.dirname(fileURLToPath(import.meta.url));
const output = path.join(dir, 'system-test-cases.docx');
const pageWidth = 9360;
const parts = [];
const esc = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');

function run(text, { bold = false, color = '24364B', size = 20 } = {}) {
  return `<w:r><w:rPr>${bold ? '<w:b/>' : ''}<w:color w:val="${color}"/><w:sz w:val="${size}"/></w:rPr><w:t xml:space="preserve">${esc(text)}</w:t></w:r>`;
}
function paragraph(text, style = 'Normal', { pageBreak = false, keepNext = false, ...opts } = {}) {
  return `<w:p><w:pPr><w:pStyle w:val="${style}"/>${pageBreak ? '<w:pageBreakBefore/>' : ''}${keepNext ? '<w:keepNext/>' : ''}</w:pPr>${run(text, opts)}</w:p>`;
}
function add(text, style = 'Normal', opts = {}) { parts.push(paragraph(text, style, opts)); }
function heading(text, pageBreak = false) { add(text, 'Heading1', { pageBreak, keepNext: true }); }
function table(headers, rows, widths) {
  const borders = ['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map(side => `<w:${side} w:val="single" w:sz="6" w:color="B8C9D8"/>`).join('');
  let xml = `<w:tbl><w:tblPr><w:tblW w:w="${pageWidth}" w:type="dxa"/><w:tblLayout w:type="fixed"/><w:tblBorders>${borders}</w:tblBorders><w:tblCellMar><w:top w:w="100" w:type="dxa"/><w:left w:w="120" w:type="dxa"/><w:bottom w:w="100" w:type="dxa"/><w:right w:w="120" w:type="dxa"/></w:tblCellMar></w:tblPr><w:tblGrid>${widths.map(value => `<w:gridCol w:w="${value}"/>`).join('')}</w:tblGrid>`;
  [headers, ...rows].forEach((row, index) => {
    xml += `<w:tr><w:trPr><w:cantSplit/>${index === 0 ? '<w:tblHeader/>' : ''}</w:trPr>`;
    row.forEach((cell, col) => {
      const fill = index === 0 ? '174A6E' : (index % 2 ? 'F0F5F9' : 'FFFFFF');
      const color = index === 0 ? 'FFFFFF' : '24364B';
      const contents = String(cell).split('\n').map((line, lineIndex) => `${lineIndex ? '<w:r><w:br/></w:r>' : ''}${run(line, { bold: index === 0 || (index > 0 && col === 0), color, size: 20 })}`).join('');
      xml += `<w:tc><w:tcPr><w:tcW w:w="${widths[col]}" w:type="dxa"/><w:shd w:val="clear" w:fill="${fill}"/><w:vAlign w:val="top"/></w:tcPr><w:p><w:pPr><w:pStyle w:val="TableText"/></w:pPr>${contents}</w:p></w:tc>`;
    });
    xml += '</w:tr>';
  });
  parts.push(`${xml}</w:tbl>${paragraph('', 'AfterTable')}`);
}

const cases = [
  {
    scenario: 'Testing login with valid credentials.',
    id: 'TC001',
    type: 'Functional testing — positive test; black-box, system-level.',
    description: 'Verify that an active user can sign in with valid account credentials.',
    preconditions: 'The user is signed out. An active staff or administrator account exists, and any required temporary-password setup has already been completed.',
    steps: [
      'Navigate to the Login page.',
      'Enter the account ID or username and its valid password.',
      'Leave Remember me unchecked for this test.',
      'Select Sign In.',
    ],
    expected: 'The user is authenticated and redirected to the dashboard. The dashboard reflects the signed-in user’s permitted access.',
  },
  {
    scenario: 'Testing creation of an inventory item.',
    id: 'TC002',
    type: 'Functional testing — positive test; black-box, system-level.',
    description: 'Verify that an authorized user can add a new inventory item.',
    preconditions: 'The user is signed in and can access Inventory. Use a staging branch and an item name that does not already exist there.',
    steps: [
      'Open Inventory from the dashboard.',
      'Select Add Item.',
      'Enter a unique item name, select its unit, and enter the starting stock and minimum stock level.',
      'If signed in as administrator, select the branch for the item; as staff, use the assigned branch.',
      'Select Add Item to save.',
    ],
    expected: 'The item is saved once and appears in the inventory list with the entered name, unit, stock, minimum level, and correct branch assignment.',
  },
  {
    scenario: 'Testing creation of a laundry order.',
    id: 'TC003',
    type: 'Functional testing — positive test; black-box, integration/system-level.',
    description: 'Verify that a user can create an order for a new customer.',
    preconditions: 'The user is signed in and can access Orders. An active service and required stock are available in the staging branch. A valid, unused test phone number and email are prepared.',
    steps: [
      'Open Orders and select New Order.',
      'Enter the unused 11-digit Philippine mobile number beginning with 09, then enter the new customer’s name and email.',
      'Wait for customer lookup to identify the number as a new customer.',
      'Select an active service and enter the required weight or quantity.',
      'If signed in as administrator, select the order branch; as staff, use the assigned branch.',
      'Enter a cash payment equal to at least 50% of the displayed order total, then submit once.',
    ],
    expected: 'The customer and order are created without duplicates. The order is linked to the selected or assigned branch, begins in received status, and shows the correct services, total, and payment status. The order appears in the Orders list.',
  },
];

add('I&C LAUNDRY', 'Kicker');
add('SYSTEM TEST CASES', 'Title');
add('Login • Inventory Creation • Order Creation', 'Subtitle');
add('Three positive, black-box workflow test cases. Record actual results during execution.', 'Intro');

for (const test of cases) {
  heading(`Example Scenario: ${test.scenario}`);
  table(['Test Case Field', 'Test Case Details'], [
    ['Test Case ID', test.id],
    ['Test Type', test.type],
    ['Test Description', test.description],
    ['Preconditions', test.preconditions],
    ['Steps to Execute', test.steps.map((step, index) => `${index + 1}. ${step}`).join('\n')],
    ['Expected Results', test.expected],
    ['Actual Results', '(To be filled during execution.)'],
  ], [2400, 6960]);
}

heading('Template:', true);
table(['Test Case Field', 'Test Case Details'], [
  ['Test Case ID', '____________________________________________'],
  ['Test Type', '____________________________________________'],
  ['Test Description', '____________________________________________'],
  ['Preconditions', '____________________________________________'],
  ['Steps to Execute', '1. __________________________________________\n2. __________________________________________\n3. __________________________________________'],
  ['Expected Results', '____________________________________________'],
  ['Actual Results', '(To be filled during execution.)'],
], [2400, 6960]);

const styleDefinitions = [
  ['Normal', '', '<w:jc w:val="both"/><w:ind w:firstLine="0"/><w:spacing w:after="150" w:line="270" w:lineRule="auto"/>', '<w:sz w:val="22"/>'],
  ['Kicker', 'Normal', '<w:jc w:val="center"/><w:ind w:firstLine="0"/><w:spacing w:before="1500" w:after="120"/>', '<w:b/><w:color w:val="1280A8"/><w:sz w:val="28"/>'],
  ['Title', 'Normal', '<w:jc w:val="center"/><w:ind w:firstLine="0"/><w:spacing w:after="100"/>', '<w:b/><w:color w:val="173B5E"/><w:sz w:val="38"/>'],
  ['Subtitle', 'Normal', '<w:jc w:val="center"/><w:ind w:firstLine="0"/><w:spacing w:after="180"/>', '<w:color w:val="5B7185"/><w:sz w:val="23"/>'],
  ['Intro', 'Normal', '<w:jc w:val="center"/><w:ind w:firstLine="0"/><w:spacing w:after="350"/>', '<w:color w:val="5B7185"/><w:sz w:val="20"/>'],
  ['Heading1', 'Normal', '<w:jc w:val="left"/><w:ind w:firstLine="0"/><w:keepNext/><w:outlineLvl w:val="0"/><w:spacing w:before="240" w:after="130"/>', '<w:b/><w:color w:val="173B5E"/><w:sz w:val="25"/>'],
  ['TableText', 'Normal', '<w:jc w:val="left"/><w:spacing w:after="0" w:line="250" w:lineRule="auto"/>', '<w:sz w:val="20"/>'],
  ['AfterTable', 'Normal', '<w:ind w:firstLine="0"/><w:spacing w:after="100" w:line="50" w:lineRule="exact"/>', '<w:sz w:val="4"/>'],
];
const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial"/><w:color w:val="24364B"/><w:sz w:val="22"/><w:lang w:val="en-PH"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:widowControl/></w:pPr></w:pPrDefault></w:docDefaults>${styleDefinitions.map(([id, base, pPr, rPr]) => `<w:style w:type="paragraph" w:styleId="${id}"${id === 'Normal' ? ' w:default="1"' : ''}><w:name w:val="${id}"/>${base ? `<w:basedOn w:val="${base}"/>` : ''}<w:pPr>${pPr}</w:pPr><w:rPr>${rPr}</w:rPr></w:style>`).join('')}</w:styles>`;
const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${parts.join('')}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1080" w:right="1440" w:bottom="1080" w:left="1440" w:header="540" w:footer="540"/><w:cols w:space="720"/></w:sectPr></w:body></w:document>`;
const relationship = (id, type, target) => `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}" Target="${target}"/>`;
const files = [
  ['[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>'],
  ['_rels/.rels', `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${relationship('rIdDoc', 'officeDocument', 'word/document.xml')}<Relationship Id="rIdCore" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>`],
  ['docProps/core.xml', '<?xml version="1.0" encoding="UTF-8"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>I&amp;C Laundry System Test Cases</dc:title><dc:creator>I&amp;C Laundry Project</dc:creator><dc:description>Three test cases covering login, inventory item creation, and laundry order creation.</dc:description></cp:coreProperties>'],
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

if (cases.length !== 3) throw new Error('The document must contain exactly three test cases.');
fs.writeFileSync(output, zip(files));
console.log(JSON.stringify({ output, testCases: cases.length, bytes: fs.statSync(output).size }, null, 2));
