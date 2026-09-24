import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Branch-only Lab 2 revision: six sections, two diagrams, three editable tables.
// This generates documentation only; it does not deploy the proposed pipeline.
const dir = path.dirname(fileURLToPath(import.meta.url));
const output = path.resolve(dir, '..', 'I-and-C-Laundry-ETL-Technical-Metadata-Branch-Only.docx');
const W = 9360; // US Letter, one-inch margins.
const parts = [];
const images = [];
let tableCount = 0;
const esc = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
function run(text, { bold = false, color = '000000', size } = {}) {
  return `<w:r><w:rPr>${bold ? '<w:b/>' : ''}<w:color w:val="${color}"/>${size ? `<w:sz w:val="${size}"/>` : ''}</w:rPr><w:t xml:space="preserve">${esc(text)}</w:t></w:r>`;
}
function paragraph(text, style = 'Normal', { pageBreak = false, keepNext = false, ...options } = {}) {
  return `<w:p><w:pPr><w:pStyle w:val="${style}"/>${pageBreak ? '<w:pageBreakBefore/>' : ''}${keepNext ? '<w:keepNext/>' : ''}</w:pPr>${run(text, options)}</w:p>`;
}
function p(text, style, options) { parts.push(paragraph(text, style, options)); }
function heading(text, pageBreak = false) { p(text, 'Heading1', { pageBreak }); }
function table(headers, rows, widths, { lineage = false, labelColumn = false, size = 22 } = {}) {
  tableCount++;
  const borders = ['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map(side => `<w:${side} w:val="single" w:sz="6" w:color="000000"/>`).join('');
  let xml = `<w:tbl><w:tblPr><w:tblW w:w="${W}" w:type="dxa"/><w:tblLayout w:type="fixed"/><w:tblBorders>${borders}</w:tblBorders><w:tblCellMar><w:top w:w="100" w:type="dxa"/><w:left w:w="110" w:type="dxa"/><w:bottom w:w="100" w:type="dxa"/><w:right w:w="110" w:type="dxa"/></w:tblCellMar></w:tblPr><w:tblGrid>${widths.map(width => `<w:gridCol w:w="${width}"/>`).join('')}</w:tblGrid>`;
  [headers, ...rows].forEach((row, index) => {
    xml += `<w:tr><w:trPr><w:cantSplit/>${index === 0 ? '<w:tblHeader/>' : ''}</w:trPr>`;
    row.forEach((cell, col) => {
      const fill = lineage ? (index === 0 ? '000000' : index % 2 === 1 ? 'D9D9D9' : 'FFFFFF') : 'FFFFFF';
      const text = String(cell).split('\n').map((line, i) => `${i ? '<w:r><w:br/></w:r>' : ''}${run(line, { bold: index === 0 || (labelColumn && col === 0), color: lineage && index === 0 ? 'FFFFFF' : '000000', size })}`).join('');
      xml += `<w:tc><w:tcPr><w:tcW w:w="${widths[col]}" w:type="dxa"/><w:shd w:val="clear" w:fill="${fill}"/><w:vAlign w:val="top"/></w:tcPr><w:p><w:pPr><w:pStyle w:val="TableText"/>${index === 0 ? '<w:keepNext/>' : ''}</w:pPr>${text}</w:p></w:tc>`;
    });
    xml += '</w:tr>';
  });
  parts.push(xml + '</w:tbl>' + paragraph('', 'AfterTable'));
}
function image(file, name, alt) {
  const bytes = fs.readFileSync(path.join(dir, file));
  const id = images.length + 1;
  images.push({ file, bytes, id });
  const cx = W * 635;
  const cy = Math.round(cx * bytes.readUInt32BE(20) / bytes.readUInt32BE(16));
  parts.push(`<w:p><w:pPr><w:jc w:val="center"/><w:ind w:firstLine="0"/><w:spacing w:before="90" w:after="120"/></w:pPr><w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="${id}" name="${esc(name)}" descr="${esc(alt)}"/><wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="${id}" name="${esc(file)}"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="rIdImage${id}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`);
}

heading('1.  Pipeline Overview');
p('The proposed I&C Laundry Daily Branch Reporting ETL Pipeline will extract operational records from the shared Supabase PostgreSQL database used by the Main, Calzada, and Nasugbu branches. Its purpose is to prepare consistent information for sales monitoring, payment collection reporting, laundry-demand analysis, branch comparisons, and daily customer activity. The design retains the previously selected stack: PostgreSQL / Supabase, Supabase Cron / pg_cron, SQL, and Reporting Summary Tables.');
p('The pipeline will validate and standardize committed records, calculate daily measures, and load one reporting table in the same database. Order value will be reported on the order creation date, cash received on the payment collection date, and expenses on the recorded expense date. These measures will support historical dashboards and reports and can provide inputs for forecasting; forecast generation itself is outside this pipeline. Source definitions follow the database schema supplied by the project owner. The scheduled ETL function, staging tables, reporting table, and application integration remain proposed, not confirmed as deployed.');
heading('2.  Pipeline Architecture');
image('branch-reporting-architecture.png', 'Proposed ETL technology architecture', 'One shared Supabase PostgreSQL operational database flows through SQL extraction, SQL validation and cleaning, SQL transformation, and one daily branch summary table. Supabase Cron with pg_cron schedules the SQL pipeline. Dashed arrows represent orchestration; solid arrows represent data flow.');
p('All processing and storage remain in PostgreSQL. Solid arrows show data movement between stages; dashed arrows show scheduled orchestration of the SQL refresh. The reporting table would be read through the application’s authorized reporting layer.', 'Small');

heading('3.  Pipeline Metadata', true);
table(['Metadata', 'Description'], [
  ['Pipeline Name', 'I&C Laundry Daily Branch Reporting ETL Pipeline'],
  ['Purpose', 'Extract, validate, clean, transform, and load daily measures for branch operations, laundry demand, order value, received payments, expenses, and customer activity.'],
  ['Technologies / Tools Used', 'PostgreSQL / Supabase; Supabase Cron / pg_cron; SQL; Reporting Summary Tables.'],
  ['Data Source', 'Five tables from the supplied schema: public.orders, public.payments, and public.expenses, with public.branches and public.customers as references. Use branch IDs for grouping and branches.branch_name for labels.'],
  ['Destination / Storage', 'One proposed analytics.daily_branch_summary table in the existing Supabase PostgreSQL database.'],
  ['Ingestion Tool', 'PostgreSQL SQL SELECT statements copy source records into transaction-local staging tables. No external ingestion server is introduced.'],
  ['Transformation Tool', 'SQL performs validation, timezone conversion, joins, filtering, independent aggregation, and reconciliation before publishing results.'],
  ['Orchestration Tool', 'Supabase Cron / pg_cron invokes the proposed analytics.refresh_daily_reports() function. Job name: ic_laundry_daily_reports.'],
  ['Data Storage', 'Operational records stay in public tables. The proposed reporting table is stored in analytics. Temporary staging data exists only during the refresh transaction.'],
  ['Schedule', 'Daily at 01:00 Asia/Manila (UTC+08:00). With the scheduler configured for UTC, the cron expression is 0 17 * * *. Process business dates earlier than the local date at run start.'],
  ['Dependency', 'Source tables matching the supplied schema; valid branch and order references; missing required reporting dates or branch assignments resolved. Verify pg_cron, the proposed function and target, and authorized source-read/target-write permissions before deployment.'],
  ['Configurations', 'PHP currency; Asia/Manila business dates; exact NUMERIC arithmetic; one consistent source snapshot and run timestamp; transaction-scoped advisory lock to prevent overlapping runs. Rebuild completed-day history to include corrections and late collections. A failed validation rolls back publication; inspect job history before rerunning.'],
  ['Connections Between Technologies', 'Supabase Cron invokes SQL in PostgreSQL. SQL reads the shared operational tables, stages and groups records, then writes the branch reporting table in one transaction. Authorized application queries consume the published summaries.'],
  ['Pipeline Steps', '1. Source operational records.\n2. Ingest a consistent snapshot.\n3. Validate keys, dates, and amounts.\n4. Clean and standardize staged data.\n5. Transform into daily metrics.\n6. Load and store reconciled summaries.'],
], [3900, 5460], { labelColumn: true });

heading('4.  Data Lineage', true);
p('The diagram follows one scheduled ETL run. Its six stages describe the sequence of transformations, not their execution duration. Source records are preserved; cleaning takes place in the staged copy.', 'Normal');
image('branch-reporting-lineage.png', 'Six-stage data-lineage timeline', 'Source records flow to SQL ingestion, data validation, cleaning, transformation, then loading and storage. Orders, payments, and expenses retain their own business dates and are aggregated separately before publication in one branch reporting table.');
table(['Stage', 'Input', 'Process', 'Output'], [
  ['Source', 'I&C Laundry operations across three branches.', 'The application records orders, payment-ledger entries, expenses, and reference data in the shared Supabase PostgreSQL database.', 'Committed operational records.'],
  ['Ingestion', 'Source tables and related branch and customer IDs.', 'Cron invokes SQL. Capture one transaction snapshot and run timestamp; copy relevant history into temporary stages. Retain invalid or missing dates for validation.', 'Raw staged records at their original row grain.'],
  ['Data Validation', 'Staged orders, payments, and expenses.', 'Check IDs, dates, branches, order links, allowed statuses, and amounts. Nullable source branches and order dates must resolve before publishing. Invalid records stop the refresh.', 'Validated source records.'],
  ['Cleaning', 'Validated staged records.', 'Derive local dates from orders.created_at and payments.paid_at; retain expenses.expense_date. Join branches by ID and use branch_name for labels.', 'Consistently dated and related datasets.'],
  ['Transformation', 'Clean datasets through yesterday.', 'Aggregate orders, cash collections, and expenses independently by their own dates and branch. Merge aggregate keys without multiplying detail rows.', 'Daily branch metrics.'],
  ['Loading and Storage', 'Reconciled aggregate datasets.', 'Check totals against each staged source using the same dates and filters. Replace the target table atomically and set refreshed_at. Roll back on failure; repeat runs do not append duplicates.', 'Published daily branch summary table.'],
], [1900, 1970, 3440, 2050], { lineage: true, labelColumn: true, size: 21 });

heading('5.  Schema Metadata', true);
p('Source definitions follow the owner-supplied 21-table schema, not a direct database inspection. This table lists the five sources and selected columns used by the ETL, followed by one proposed target; it is not a full application data dictionary. PK means primary key; FK means foreign key. “NULL” marks nullable columns; other listed columns are NOT NULL. Source NUMERIC fields have no declared precision or scale.', 'Small');
table(['Database Table', 'Columns and Data Types', 'Primary Key', 'Foreign Keys and Relationships'], [
  ['public.branches\n(existing source)', 'id — UUID\nbranch_name — TEXT\nname — TEXT (NULL)\ncode — TEXT (NULL)', 'id', 'One branch has many orders, payments, expenses, and reporting rows. branch_name supplies the label; name and code are optional.'],
  ['public.customers\n(existing reference)', 'id — UUID', 'id', 'Referenced by orders.customer_id. A customer can have many orders. Contact details are not extracted.'],
  ['public.orders\n(existing source)', 'id — UUID\nbranch_id — UUID (NULL)\ncustomer_id — UUID (NULL)\ncreated_at — TIMESTAMPTZ (NULL)\nstatus — TEXT\nweight_kg — NUMERIC\ntotal_price — NUMERIC', 'id', 'branch_id → branches.id\ncustomer_id → customers.id\nOne order can have many payment entries.'],
  ['public.payments\n(existing ledger)', 'id — UUID\norder_id — UUID\nbranch_id — UUID (NULL)\namount — NUMERIC\npaid_at — TIMESTAMPTZ\nsource — TEXT', 'id', 'order_id → orders.id\nbranch_id → branches.id\nEach collection is a separate ledger row linked to its order and branch.'],
  ['public.expenses\n(existing source)', 'id — UUID\nbranch_id — UUID (NULL)\namount — NUMERIC\nexpense_date — DATE\ndeleted_at — TIMESTAMPTZ (NULL)', 'id', 'branch_id → branches.id\nInclude only non-deleted expenses. A missing branch must be resolved before publication.'],
  ['analytics.\ndaily_branch_\nsummary\n(proposed target)', 'report_date — DATE\nbranch_id — UUID\norder_count — BIGINT\nreleased_order_count — BIGINT\nunique_customer_count — BIGINT\ntotal_weight_kg — NUMERIC(14,2)\norder_value_php — NUMERIC(14,2)\npayment_count — BIGINT\ncash_received_php — NUMERIC(14,2)\nexpense_total_php — NUMERIC(14,2)\nrefreshed_at — TIMESTAMPTZ', 'Composite:\nreport_date,\nbranch_id', 'branch_id → public.branches.id\nOne row per date and branch. Merge order, payment, and expense aggregates using the union of their keys.'],
], [1910, 3530, 1470, 2450], { size: 20 });
p('Schema interpretation and ETL rules', 'Heading2', { pageBreak: true });
p('Source versus ETL requirements. The source permits NULL branch IDs in orders, payments, and expenses, and NULL orders.created_at. The proposed refresh requires resolved branches and dates before publication; it must not silently discard these rows or invent values. This reporting rule does not change the source constraints.', 'Small');
p('Staging: proposed pg_temp.etl_orders_stage, pg_temp.etl_payments_stage, and pg_temp.etl_expenses_stage retain their source IDs and selected fields and add report_date DATE. They exist only for one refresh and are dropped at transaction end.', 'Small');
p('Metric rules. Order counts, weight, and order value exclude cancelled orders and use the local creation date. Released-order counts describe current status within that creation-date group, not daily releases. Customer counts use distinct non-null IDs within a date and branch; do not sum them to infer distinct customers over a wider period.', 'Small');
p('Cash rules. cash_received_php is SUM(payments.amount), dated by paid_at, with one count per ledger row. Later collections belong to the later date, not the order date. Do not also sum orders.amount_paid. This proposed metric retains recorded collections after cancellation, which is not evidence of a refund. It is gross cash, not net income; net collections require an approved refund ledger. Legacy backfill timestamps are best-available estimates, not exact historical collection times.', 'Small');
p('Grouping and integrity. Branch summary keys include dates with only payments or expenses. Missing measures are zero. All target columns are required, and the composite primary key is (report_date, branch_id). Enforce unique keys, nonnegative totals, and valid branch references. Reconcile each metric against its staged source using the same dates and filters. Any discrepancy aborts the refresh.', 'Small');
p('Source definitions. The five source tables and the selected column types, nullability, and relationships are based on the supplied database schema. Only fields required for this reporting pipeline are documented; this is not a complete application schema. Cash received is derived from payments.amount and payments.paid_at, not the order payment summary.', 'Small');
p('Scope and limitations. This pipeline covers completed-day, branch-level reporting for orders, payment collections, expenses, and customer activity across the three branches. It uses orders, payments, expenses, branches, and customer identifiers to prepare analytics.daily_branch_summary. Live transaction processing, inventory, loyalty, audit monitoring, authentication, and forecast generation remain outside its scope. Customer contact details and credentials are not extracted. The scheduled refresh and summary table are proposed components, not verified deployments.', 'Small');

heading('6.  Technology Justification', true);
p('PostgreSQL / Supabase', 'Heading2');
p('The system already uses Supabase PostgreSQL for shared operational data. Keeping extraction and reporting storage in the same database fits the existing relational structure and avoids an additional data-transfer component. Keys support consistent relationships, and a transactional publication step can preserve the last successful summaries when a refresh fails. The job should run off-peak and its runtime should be monitored so analytical processing does not disrupt branch transactions.');
p('Supabase Cron / pg_cron', 'Heading2');
p('This is the selected scheduler for the proposed daily SQL refresh. It provides an in-database trigger for the pipeline and job history for operational review, without introducing Apache Airflow or another scheduling platform. The configured scheduler timezone must be checked before enabling the 01:00 Asia/Manila schedule. An advisory lock in the refresh function prevents simultaneous runs from publishing conflicting results.');
p('SQL', 'Heading2');
p('SQL is selected for ingestion, validation, cleaning, transformation, and loading because the required data is relational. The same proposed function can apply date rules, validate references, aggregate separate transaction streams, and reconcile final totals. Independent aggregation is important: directly joining orders to multiple payments and expenses could multiply rows and overstate the results. Centralizing these rules also makes the proposed calculations easier to review and test.');
p('Reporting Summary Tables', 'Heading2');
p('This is the selected reporting storage approach, not an additional software product. The proposed analytics.daily_branch_summary table stores reusable measures at the date-and-branch level. It reduces repeated aggregation and separates order value from collected cash. Reports would display refreshed_at and identify the completed-day cutoff; live order tracking would continue to use operational records. This separation supports consistent historical reporting without presenting scheduled summaries as real-time transaction data.');

const styleDefinitions = [
  ['Normal', '', '<w:jc w:val="both"/><w:ind w:firstLine="540"/><w:spacing w:after="180" w:line="276" w:lineRule="auto"/>', '<w:sz w:val="24"/>'],
  ['Heading1', 'Normal', '<w:jc w:val="left"/><w:ind w:firstLine="0"/><w:keepNext/><w:outlineLvl w:val="0"/><w:spacing w:before="200" w:after="180"/>', '<w:b/><w:sz w:val="26"/>'],
  ['Heading2', 'Normal', '<w:jc w:val="left"/><w:ind w:firstLine="0"/><w:keepNext/><w:outlineLvl w:val="1"/><w:spacing w:before="160" w:after="90"/>', '<w:b/><w:sz w:val="24"/>'],
  ['Small', 'Normal', '<w:ind w:firstLine="0"/><w:spacing w:after="130" w:line="260" w:lineRule="auto"/>', '<w:sz w:val="21"/>'],
  ['TableText', 'Normal', '<w:jc w:val="left"/><w:ind w:firstLine="0"/><w:spacing w:before="0" w:after="0" w:line="245" w:lineRule="auto"/>', '<w:sz w:val="22"/>'],
  ['AfterTable', 'Normal', '<w:ind w:firstLine="0"/><w:spacing w:after="30" w:line="30" w:lineRule="exact"/>', '<w:sz w:val="2"/>'],
];
const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:cs="Arial"/><w:color w:val="000000"/><w:sz w:val="24"/><w:lang w:val="en-PH"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:widowControl/></w:pPr></w:pPrDefault></w:docDefaults>${styleDefinitions.map(([id, base, pp, rp]) => `<w:style w:type="paragraph" w:styleId="${id}"${id === 'Normal' ? ' w:default="1"' : ''}><w:name w:val="${id}"/>${base ? `<w:basedOn w:val="${base}"/>` : ''}<w:pPr>${pp}</w:pPr><w:rPr>${rp}</w:rPr></w:style>`).join('')}</w:styles>`;
const ns = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"';
const section = '<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720"/><w:cols w:space="720"/></w:sectPr>';
const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${ns}><w:body>${parts.join('')}${section}</w:body></w:document>`;
const rel = (id, type, target) => `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}" Target="${target}"/>`;
const docRels = `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rel('rIdStyles', 'styles', 'styles.xml')}${rel('rIdSettings', 'settings', 'settings.xml')}${images.map(({id, file}) => rel(`rIdImage${id}`, 'image', `media/${file}`)).join('')}</Relationships>`;
const contentTypes = `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/>${['document', 'styles', 'settings'].map(name => `<Override PartName="/word/${name}.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.${name === 'document' ? 'document.main' : name}+xml"/>`).join('')}<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>`;
const files = [
  ['[Content_Types].xml', contentTypes],
  ['_rels/.rels', `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rel('rIdDoc', 'officeDocument', 'word/document.xml')}<Relationship Id="rIdCore" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>`],
  ['docProps/core.xml', '<?xml version="1.0" encoding="UTF-8"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>I&amp;C Laundry - Branch Reporting ETL Technical Metadata</dc:title><dc:creator>I&amp;C Laundry Project</dc:creator><dc:description>Source metadata follows the owner-supplied 21-table database schema; format and diagrams follow lab-2.pdf. Retains PostgreSQL / Supabase, Supabase Cron / pg_cron, SQL, and Reporting Summary Tables.</dc:description></cp:coreProperties>'],
  ['word/document.xml', document], ['word/styles.xml', styles], ['word/_rels/document.xml.rels', docRels],
  ['word/settings.xml', '<?xml version="1.0" encoding="UTF-8"?><w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:zoom w:percent="100"/><w:defaultTabStop w:val="720"/><w:autoHyphenation w:val="false"/></w:settings>'],
  ...images.map(({file, bytes}) => [`word/media/${file}`, bytes]),
];
const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
function crc32(bytes) { let c = 0xffffffff; for (const b of bytes) c = crcTable[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function zip(entries) {
  const chunks = [], directory = []; let offset = 0;
  for (const [name, input] of entries) {
    const filename = Buffer.from(name), data = Buffer.isBuffer(input) ? input : Buffer.from(input), crc = crc32(data);
    const header = Buffer.alloc(30); header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x800, 6); header.writeUInt32LE(crc, 14); header.writeUInt32LE(data.length, 18); header.writeUInt32LE(data.length, 22); header.writeUInt16LE(filename.length, 26);
    chunks.push(header, filename, data);
    const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x800, 8); central.writeUInt32LE(crc, 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(filename.length, 28); central.writeUInt32LE(offset, 42); directory.push(central, filename); offset += header.length + filename.length + data.length;
  }
  const centralBuffer = Buffer.concat(directory), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(centralBuffer.length, 12); end.writeUInt32LE(offset, 16); return Buffer.concat([...chunks, centralBuffer, end]);
}
if (tableCount !== 3 || images.length !== 2) throw new Error('Lab 2 revision must have exactly three tables and two diagrams.');
fs.writeFileSync(output, zip(files));
console.log(JSON.stringify({ output, tables: tableCount, figures: images.length, bytes: fs.statSync(output).size }, null, 2));
