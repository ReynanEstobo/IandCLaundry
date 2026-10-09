import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Build the editable Word test document from the existing Orders-page case list.
const dir = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(dir, 'orders-page-test-cases.md'), 'utf8');
const output = path.join(dir, 'orders-page-test-cases.docx');
const width = 9360;
const parts = [];
const esc = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');

function run(text, { bold = false, color = '24364B', size = 20 } = {}) {
  return `<w:r><w:rPr>${bold ? '<w:b/>' : ''}<w:color w:val="${color}"/><w:sz w:val="${size}"/></w:rPr><w:t xml:space="preserve">${esc(text)}</w:t></w:r>`;
}
function para(text, style = 'Normal', { pageBreak = false, keepNext = false, ...opts } = {}) {
  return `<w:p><w:pPr><w:pStyle w:val="${style}"/>${pageBreak ? '<w:pageBreakBefore/>' : ''}${keepNext ? '<w:keepNext/>' : ''}</w:pPr>${run(text, opts)}</w:p>`;
}
function add(text, style = 'Normal', opts = {}) { parts.push(para(text, style, opts)); }
function heading(text, level = 1, pageBreak = false) { add(text, `Heading${level}`, { keepNext: true, pageBreak }); }
function table(headers, rows, widths) {
  const borders = ['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map(side => `<w:${side} w:val="single" w:sz="6" w:color="B8C9D8"/>`).join('');
  let xml = `<w:tbl><w:tblPr><w:tblW w:w="${width}" w:type="dxa"/><w:tblLayout w:type="fixed"/><w:tblBorders>${borders}</w:tblBorders><w:tblCellMar><w:top w:w="100" w:type="dxa"/><w:left w:w="120" w:type="dxa"/><w:bottom w:w="100" w:type="dxa"/><w:right w:w="120" w:type="dxa"/></w:tblCellMar></w:tblPr><w:tblGrid>${widths.map(n => `<w:gridCol w:w="${n}"/>`).join('')}</w:tblGrid>`;
  [headers, ...rows].forEach((row, index) => {
    xml += `<w:tr><w:trPr><w:cantSplit/>${index === 0 ? '<w:tblHeader/>' : ''}</w:trPr>`;
    row.forEach((cell, col) => {
      const fill = index === 0 ? '174A6E' : (index % 2 ? 'F0F5F9' : 'FFFFFF');
      const color = index === 0 ? 'FFFFFF' : '24364B';
      const content = String(cell).split('\n').map((line, lineIndex) => `${lineIndex ? '<w:r><w:br/></w:r>' : ''}${run(line, { bold: index === 0 || (index > 0 && col === 0), color, size: 20 })}`).join('');
      xml += `<w:tc><w:tcPr><w:tcW w:w="${widths[col]}" w:type="dxa"/><w:shd w:val="clear" w:fill="${fill}"/><w:vAlign w:val="top"/></w:tcPr><w:p><w:pPr><w:pStyle w:val="TableText"/></w:pPr>${content}</w:p></w:tc>`;
    });
    xml += '</w:tr>';
  });
  parts.push(`${xml}</w:tbl>${para('', 'AfterTable')}`);
}

const caseBlocks = source.split(/^###\s+/m).slice(1).filter(block => /^ORD-\d{3}/.test(block));
const cases = caseBlocks.map(block => {
  const lines = block.split(/\r?\n/);
  const titleMatch = lines[0].match(/^(ORD-\d{3})\s*-\s*(.*)$/);
  const value = label => {
    const line = lines.find(candidate => candidate.startsWith(`- **${label}:**`));
    return line ? line.slice(`- **${label}:**`.length).trim() : '';
  };
  return {
    id: titleMatch?.[1] ?? 'ORD-???',
    title: titleMatch?.[2] ?? 'Untitled test case',
    type: value('Type'),
    preconditions: value('Preconditions'),
    steps: value('Steps'),
    expected: value('Expected result'),
  };
});
if (cases.length !== 17 || cases.some(test => !test.preconditions || !test.steps || !test.expected)) {
  throw new Error(`Expected 17 complete Orders test cases; parsed ${cases.length}.`);
}

add('I&C LAUNDRY', 'Kicker');
add('ORDERS PAGE TEST CASES', 'Title');
add('Each case uses the Week 4 sample fields. Actual results are completed during execution.', 'Subtitle');

const scenarios = [
  ['Testing the Orders page display and finding orders.', cases.slice(0, 6)],
  ['Testing order creation and customer lookup.', cases.slice(6, 10)],
  ['Testing an order edit.', cases.slice(10, 11)],
  ['Testing order status changes.', cases.slice(11, 12)],
  ['Testing order release.', cases.slice(12, 14)],
  ['Testing additional payment recording.', cases.slice(14, 15)],
  ['Testing order cancellation.', cases.slice(15, 16)],
  ['Testing staff and administrator branch access.', cases.slice(16, 17)],
];

for (const [scenario, scenarioCases] of scenarios) {
  heading(`Example Scenario: ${scenario}`, 1);
  for (const test of scenarioCases) {
    const steps = test.steps.split(/;\s*/).map(step => step.trim()).filter(Boolean);
    const numberedSteps = steps.map((step, index) => `${index + 1}. ${step}`).join('\n');
    table(['Test Case Field', 'Test Case Details'], [
      ['Test Case ID', test.id],
      ['Test Description', test.title],
      ['Preconditions', test.preconditions],
      ['Steps to Execute', numberedSteps],
      ['Expected Results', test.expected],
      ['Actual Results', '(To be filled during execution.)'],
    ], [2400, 6960]);
  }
}

heading('Template:', 1, true);
table(['Test Case Field', 'Test Case Details'], [
  ['Test Case ID', '____________________________________________'],
  ['Test Description', '____________________________________________'],
  ['Preconditions', '____________________________________________'],
  ['Steps to Execute', '1. __________________________________________\n2. __________________________________________\n3. __________________________________________'],
  ['Expected Results', '____________________________________________'],
  ['Actual Results', '(To be filled during execution.)'],
], [2400, 6960]);

const styleDefs = [
  ['Normal', '', '<w:jc w:val="both"/><w:ind w:firstLine="0"/><w:spacing w:after="150" w:line="270" w:lineRule="auto"/>', '<w:sz w:val="22"/>'],
  ['Kicker', 'Normal', '<w:jc w:val="center"/><w:ind w:firstLine="0"/><w:spacing w:before="1500" w:after="120"/>', '<w:b/><w:color w:val="1280A8"/><w:sz w:val="28"/>'],
  ['Title', 'Normal', '<w:jc w:val="center"/><w:ind w:firstLine="0"/><w:spacing w:after="100"/>', '<w:b/><w:color w:val="173B5E"/><w:sz w:val="38"/>'],
  ['Subtitle', 'Normal', '<w:jc w:val="center"/><w:ind w:firstLine="0"/><w:spacing w:after="450"/>', '<w:color w:val="5B7185"/><w:sz w:val="23"/>'],
  ['Heading1', 'Normal', '<w:jc w:val="left"/><w:ind w:firstLine="0"/><w:keepNext/><w:outlineLvl w:val="0"/><w:spacing w:before="220" w:after="100"/>', '<w:b/><w:color w:val="173B5E"/><w:sz w:val="24"/>'],
  ['TableText', 'Normal', '<w:jc w:val="left"/><w:spacing w:after="0" w:line="250" w:lineRule="auto"/>', '<w:sz w:val="20"/>'],
  ['AfterTable', 'Normal', '<w:ind w:firstLine="0"/><w:spacing w:after="90" w:line="50" w:lineRule="exact"/>', '<w:sz w:val="4"/>'],
];
const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial"/><w:color w:val="24364B"/><w:sz w:val="22"/><w:lang w:val="en-PH"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:widowControl/></w:pPr></w:pPrDefault></w:docDefaults>${styleDefs.map(([id, base, pPr, rPr]) => `<w:style w:type="paragraph" w:styleId="${id}"${id === 'Normal' ? ' w:default="1"' : ''}><w:name w:val="${id}"/>${base ? `<w:basedOn w:val="${base}"/>` : ''}<w:pPr>${pPr}</w:pPr><w:rPr>${rPr}</w:rPr></w:style>`).join('')}</w:styles>`;
const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${parts.join('')}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1080" w:right="1440" w:bottom="1080" w:left="1440" w:header="540" w:footer="540"/><w:cols w:space="720"/></w:sectPr></w:body></w:document>`;
const rel = (id, type, target) => `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}" Target="${target}"/>`;
const files = [
  ['[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>'],
  ['_rels/.rels', `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rel('rIdDoc', 'officeDocument', 'word/document.xml')}<Relationship Id="rIdCore" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>`],
  ['docProps/core.xml', '<?xml version="1.0" encoding="UTF-8"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>I&amp;C Laundry Orders Page Test Cases</dc:title><dc:creator>I&amp;C Laundry Project</dc:creator><dc:description>Orders page test cases in the Week 4 sample format, plus a blank practice template.</dc:description></cp:coreProperties>'],
  ['word/document.xml', documentXml],
  ['word/styles.xml', styles],
  ['word/_rels/document.xml.rels', `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rel('rIdStyles', 'styles', 'styles.xml')}</Relationships>`],
];
const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
function crc32(bytes) { let c = 0xffffffff; for (const b of bytes) c = crcTable[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function zip(entries) {
  const chunks = [], directory = [];
  let offset = 0;
  for (const [name, value] of entries) {
    const filename = Buffer.from(name), data = Buffer.isBuffer(value) ? value : Buffer.from(value), crc = crc32(data);
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6); local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(filename.length, 26);
    chunks.push(local, filename, data);
    const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x800, 8); central.writeUInt32LE(crc, 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(filename.length, 28); central.writeUInt32LE(offset, 42); directory.push(central, filename); offset += local.length + filename.length + data.length;
  }
  const centralDirectory = Buffer.concat(directory), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(centralDirectory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, centralDirectory, end]);
}

fs.writeFileSync(output, zip(files));
console.log(JSON.stringify({ output, cases: cases.length, exampleScenarios: scenarios.length, bytes: fs.statSync(output).size }, null, 2));
