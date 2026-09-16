import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Generates the requested document without changing the application or database.
const dir = path.dirname(fileURLToPath(import.meta.url));
const output = path.resolve(dir, '..', 'I-and-C-Laundry-ETL-Technical-Metadata.docx');
const W = 9890;
const esc = text => String(text).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
let tableCount = 0;
const parts = [];
function run(text, options = {}) {
  return `<w:r><w:rPr>${options.bold ? '<w:b/>' : ''}${options.color ? `<w:color w:val="${options.color}"/>` : ''}${options.size ? `<w:sz w:val="${options.size}"/>` : ''}</w:rPr><w:t xml:space="preserve">${esc(text)}</w:t></w:r>`;
}
function p(text, style = 'Normal', options = {}) {
  return `<w:p><w:pPr><w:pStyle w:val="${style}"/>${options.pageBreak ? '<w:pageBreakBefore/>' : ''}${options.keepNext ? '<w:keepNext/>' : ''}</w:pPr>${run(text, options)}</w:p>`;
}
function addP(text, style, options) { parts.push(p(text, style, options)); }
function heading(text, pageBreak = false) { addP(text, 'Heading1', { pageBreak }); }
function subheading(text) { addP(text, 'Heading2'); }
function table(headers, rows, widths = [2500, 1700, 5690]) {
  tableCount++;
  const all = [headers, ...rows];
  let xml = `<w:tbl><w:tblPr><w:tblW w:w="${W}" w:type="dxa"/><w:tblLayout w:type="fixed"/><w:tblBorders><w:top w:val="single" w:sz="4" w:color="D5E1E8"/><w:left w:val="single" w:sz="4" w:color="D5E1E8"/><w:bottom w:val="single" w:sz="4" w:color="D5E1E8"/><w:right w:val="single" w:sz="4" w:color="D5E1E8"/><w:insideH w:val="single" w:sz="4" w:color="D5E1E8"/><w:insideV w:val="single" w:sz="4" w:color="D5E1E8"/></w:tblBorders><w:tblCellMar><w:top w:w="80" w:type="dxa"/><w:left w:w="110" w:type="dxa"/><w:bottom w:w="80" w:type="dxa"/><w:right w:w="110" w:type="dxa"/></w:tblCellMar></w:tblPr><w:tblGrid>${widths.map(width => `<w:gridCol w:w="${width}"/>`).join('')}</w:tblGrid>`;
  all.forEach((row, index) => {
    xml += `<w:tr><w:trPr><w:cantSplit/>${index === 0 ? '<w:tblHeader/>' : ''}</w:trPr>`;
    row.forEach((cell, col) => {
      const fill = index === 0 ? '163A50' : index % 2 === 0 ? 'F2F7FA' : 'FFFFFF';
      xml += `<w:tc><w:tcPr><w:tcW w:w="${widths[col]}" w:type="dxa"/><w:shd w:val="clear" w:fill="${fill}"/><w:vAlign w:val="center"/></w:tcPr><w:p><w:pPr><w:pStyle w:val="TableText"/>${index === 0 ? '<w:keepNext/>' : ''}</w:pPr>${String(cell).split('\n').map((line, i) => `${i ? '<w:r><w:br/></w:r>' : ''}${run(line, { bold: index === 0, color: index === 0 ? 'FFFFFF' : '243D4C' })}`).join('')}</w:p></w:tc>`;
    });
    xml += '</w:tr>';
  });
  parts.push(xml + '</w:tbl>' + p('', 'AfterTable'));
}
function image(file, id, name, alt, maxHeight) {
  const bytes = fs.readFileSync(path.join(dir, file));
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  const inches = Math.min(W / 1440, maxHeight * width / height);
  const cx = Math.round(inches * 914400);
  const cy = Math.round(inches * height / width * 914400);
  parts.push(`<w:p><w:pPr><w:jc w:val="center"/><w:keepNext/><w:spacing w:after="70"/></w:pPr><w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="${id}" name="${esc(name)}" descr="${esc(alt)}"/><wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="${id}" name="${esc(file)}"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="rIdImage${id}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`);
}

addP('TECHNICAL METADATA DOCUMENTATION', 'Eyebrow');
addP('I&C Laundry\u00a0|\u00a0Proposed ETL Pipeline', 'Title');
addP('AI-Assisted Business Analytics and Decision Support System for I&C Laundry Shop', 'Subtitle');
heading('1. Pipeline Overview');
addP('The proposed Daily Branch and Service Reporting ETL Pipeline prepares completed-day order data for business analytics across I&C Laundry’s three branches. It extracts records from the existing shared Supabase PostgreSQL database, cleans and summarizes them using SQL, and loads reporting summary tables on a daily Supabase Cron schedule.');
addP('The pipeline addresses repeated report calculations and inconsistent grouping of dates, branches, and services. Its outputs support sales monitoring, branch workload comparisons, service-demand analysis, and daily customer activity. Prepared daily totals can also supply historical inputs to the system’s forecasting features. Forecast generation itself is outside this ETL pipeline.');
addP('Design status: The source tables are based on the project’s SQL schema and migrations. The scheduled function, temporary stage, summary tables, and dashboard connection described here are proposed; this document does not claim that they are already deployed.', 'Note');
heading('2. Pipeline Architecture');
image('architecture.png', 1, 'Pipeline architecture', 'Three branch operations feed one shared Supabase PostgreSQL database. Supabase Cron starts SQL extraction, cleaning and aggregation; SQL loads reporting summary tables in that same database. The application API reads those summaries for dashboards and reports.', 5.0);
addP('Figure 1. Proposed pipeline architecture using the four selected ETL technologies.', 'Caption');
addP('Supabase Cron supplies the trigger; SQL performs the processing; PostgreSQL holds both operational data and prepared reporting tables. Application access to the summaries would use the existing authenticated backend.', 'Small');

heading('3. Pipeline Metadata', true);
addP('Table 1. Pipeline definition, schedule, dependencies, configurations, and connections.', 'Caption');
table(['Metadata', 'Description'], [
  ['Pipeline name', 'I&C Laundry Daily Branch and Service Reporting ETL Pipeline'],
  ['Purpose', 'Prepare consistent historical totals for sales, order demand, branch workload, service performance, and daily customer activity.'],
  ['Technologies / tools', 'PostgreSQL / Supabase; Supabase Cron / pg_cron; SQL; Reporting Summary Tables.'],
  ['Data source', 'Existing public.orders, public.branches, and public.service_types in one shared Supabase database. Customer activity uses orders.customer_id, which references public.customers.id.'],
  ['Destination / storage', 'Proposed analytics.daily_branch_summary and analytics.daily_service_summary tables in the same PostgreSQL database.'],
  ['Schedule', 'Daily at 01:00 Asia/Manila (UTC+08:00). With cron.timezone set to UTC/GMT, use cron expression 0 17 * * *. Verify the scheduler timezone before enabling the job.'],
  ['Run configuration', 'Job name: ic_laundry_daily_reports. Function: analytics.refresh_daily_reports(). One run at a time, protected by a transaction-scoped advisory lock.'],
  ['Data window / refresh', 'Full historical rebuild for order creation dates earlier than the local date at run start. Rebuilding previous dates captures late payments, cancellations, and corrections. Current-day transactions remain available from operational screens.'],
  ['Dependencies', 'Required source columns and foreign keys; enabled pg_cron extension; deployed SQL function and target tables; a database role permitted to read all three branches and update summaries.'],
  ['Processing settings', 'Business timezone: Asia/Manila. Currency: PHP. Exact NUMERIC arithmetic. Capture one run timestamp and one source snapshot. Proposed statement timeout: 5 minutes; revisit after measuring real data volume.'],
  ['Connections', 'pg_cron → SQL function: in-database invocation. SQL → public tables: SELECT/JOIN. SQL → analytics tables: transactional writes. Backend → summaries: authorized database reads for reports. No external ETL server is required.'],
  ['Pipeline steps', '1 Read saved orders → 2 Extract a snapshot → 3 Validate and clean → 4 Aggregate → 5 Publish both summaries → 6 Read results in reports.'],
  ['Failure handling', 'Validation errors raise an exception and roll back the refresh; the previous published summaries remain available. Review cron.job_run_details, correct the cause, and rerun. No automatic retry is assumed.'],
  ['Publication / access', 'Publish both tables in one transaction. Replace prior summary rows rather than appending duplicate totals. Display refreshed_at as the report’s data timestamp; retain the backend’s existing authorization and branch restrictions.'],
], [2450, 7440]);
addP('All scheduling and processing values above are proposed configuration choices. Supabase Cron documents SQL-function scheduling and run-history monitoring; the database timezone used for business dates is distinct from the scheduler’s timezone. [1]', 'Small');

heading('4. Data Lineage', true);
addP('The timeline shows the sequence of one scheduled run. Each stage consumes the preceding stage’s output; it is not a measurement of execution time.', 'Normal');
image('lineage-timeline.png', 2, 'Data lineage timeline', 'In order: saved source orders; extraction at 01:00 Asia/Manila; validation and cleaning; branch and service aggregation; atomic loading of summaries; dashboard and report use. A failed validation stops publication and preserves the previous summaries.', 4.0);
addP('Figure 2. Data-lineage timeline for the proposed daily ETL run.', 'Caption');
addP('Table 2. Inputs, transformations, and outputs at each stage.', 'Caption');
table(['Stage', 'Input', 'Process / transformation', 'Output'], [
  ['1. Source', 'Orders from all three branches; branch and service lookups.', 'Operational transactions save order IDs, payment totals, status, weight, and related IDs in PostgreSQL.', 'Committed operational records.'],
  ['2. Extract', 'public.orders, branches, and service_types.', 'Read one joined snapshot into a temporary SQL stage. Retain invalid rows for validation, including null timestamps. Capture the run timestamp once.', 'One staged row per order.'],
  ['3. Validate / clean', 'Staged source rows.', 'Check unique IDs, branch/service references, timestamps, statuses, and nonnegative values. Reject null timestamps before date filtering. Derive report_date in Asia/Manila.', 'Validated, consistently dated order rows.'],
  ['4. Transform', 'Validated rows.', 'Keep dates through yesterday; exclude cancelled orders. Group by date/branch and date/branch/service. Count orders, sum weight/value/payments, and count distinct customers for date/branch only.', 'Two sets of grouped summary rows.'],
  ['5. Load', 'Branch and service summaries.', 'Validate reconciliation totals; replace both reporting tables in one transaction and set refreshed_at. Any error rolls back the replacement.', 'Published reporting summary tables.'],
  ['6. Use', 'Last successful summaries.', 'Backend reads by date, branch, or service for dashboards/reports. Show the refresh timestamp; fill missing chart dates with zero.', 'Consistent historical report data.'],
], [1300, 2100, 4050, 2440]);
addP('A duplicate order ID or an unresolved non-null branch/service reference stops the batch. Customer references rely on the source foreign key. A missing branch is an error; a genuinely null service or customer ID is handled using the rules in Section 5.', 'Small');

heading('5. Schema Metadata', true);
subheading('5.1 Operational source tables — selected columns');
addP('Only fields used by this pipeline are listed. PK means primary key; FK means foreign key. These definitions come from the repository’s schema and migrations, not a live-database inspection. The three branches share these tables.', 'Small');
addP('Table 3. public.orders — one row per laundry order.', 'Caption');
table(['Column', 'Data type', 'Key / meaning'], [
  ['id', 'UUID', 'PK; stable order identifier and staging uniqueness key.'],
  ['branch_id', 'UUID', 'Nullable FK → public.branches.id; must resolve for reporting.'],
  ['customer_id', 'UUID', 'Nullable FK → public.customers.id; used for distinct-customer counts.'],
  ['service_type_id', 'UUID', 'Nullable FK → public.service_types.id; null means Unspecified.'],
  ['created_at', 'TIMESTAMPTZ', 'Source creation timestamp; required to derive the report date.'],
  ['status', 'TEXT', 'Order state: received, on_process, ready, released, or cancelled.'],
  ['payment_status', 'TEXT', 'Payment state: unpaid, partial, or paid.'],
  ['weight_kg', 'NUMERIC(10,2)', 'Recorded order weight; nonnegative.'],
  ['total_price', 'NUMERIC(10,2)', 'Final order value after any applied loyalty discount.'],
  ['amount_paid', 'NUMERIC(10,2)', 'Cumulative recorded payment for the order; normally NOT NULL.'],
]);
addP('Table 4. Reference tables — fields used for joins and labels.', 'Caption');
table(['Table / column', 'Data type', 'Key / meaning'], [
  ['public.branches.id', 'UUID', 'PK in declared schema; uniquely identifies a branch.'],
  ['public.branches.name', 'TEXT', 'Branch label; declared NOT NULL and unique.'],
  ['public.branches.code', 'TEXT', 'Unique branch code; may be null.'],
  ['public.service_types.id', 'UUID', 'PK; identifies a recorded service category.'],
  ['public.service_types.name', 'TEXT', 'NOT NULL; service label. Preserve historical lookup records.'],
  ['public.customers.id', 'UUID', 'PK referenced by orders.customer_id. Names, phone numbers, and emails are not needed for these summaries.'],
], [3150, 1500, 5240]);
addP('Temporary stage: pg_temp.etl_orders_stage copies the selected orders columns above, joined to lookup records for key validation, and adds report_date DATE. It enforces one row per order ID and is dropped at transaction end. It is transient working data, not an additional reporting destination.', 'Small');
addP('Source basis: supabase_schema.sql; 20260906_multi_branch_reporting.sql; 20260908_three_stage_order_eta.sql; 20260909_cross_branch_loyalty_program.sql. Existing analytics behavior was checked in frontend/src/pages/Analytics.jsx.', 'Small');

subheading('5.2 Proposed reporting summary tables');
// Explicit break keeps the two proposed destination schemas together.
parts[parts.length - 1] = p('5.2 Proposed reporting summary tables', 'Heading2', { pageBreak: true });
addP('All target columns are NOT NULL unless stated otherwise. No individual customer contact details are stored in these summaries.', 'Small');
addP('Table 5. analytics.daily_branch_summary — one row per date and branch.', 'Caption');
table(['Column', 'Data type', 'Key / calculation'], [
  ['report_date', 'DATE', 'Composite PK, part 1; local order creation date.'],
  ['branch_id', 'UUID', 'Composite PK, part 2; FK → public.branches.id.'],
  ['order_count', 'BIGINT', 'COUNT(*) for non-cancelled orders in the group.'],
  ['released_order_count', 'BIGINT', 'Count of those orders whose current status is released.'],
  ['unique_customer_count', 'BIGINT', 'COUNT(DISTINCT customer_id); null customer IDs excluded.'],
  ['total_weight_kg', 'NUMERIC(14,2)', 'SUM(weight_kg).'],
  ['order_value_php', 'NUMERIC(14,2)', 'SUM(total_price); use recorded final values.'],
  ['recorded_payments_php', 'NUMERIC(14,2)', 'SUM(normalized amount_paid), attributed to report_date.'],
  ['refreshed_at', 'TIMESTAMPTZ', 'Timestamp captured at the start of the successful run.'],
]);
addP('Table 6. analytics.daily_service_summary — one row per date, branch, and service key.', 'Caption');
table(['Column', 'Data type', 'Key / calculation'], [
  ['report_date', 'DATE', 'Composite PK, part 1; local order creation date.'],
  ['branch_id', 'UUID', 'Composite PK, part 2; FK → public.branches.id.'],
  ['service_key', 'TEXT', 'Composite PK, part 3; service UUID as text, or unspecified.'],
  ['service_type_id', 'UUID', 'Nullable FK → public.service_types.id; null for Unspecified.'],
  ['order_count', 'BIGINT', 'COUNT(*) for the non-cancelled orders in this group.'],
  ['total_weight_kg', 'NUMERIC(14,2)', 'SUM(weight_kg).'],
  ['order_value_php', 'NUMERIC(14,2)', 'SUM(total_price).'],
  ['recorded_payments_php', 'NUMERIC(14,2)', 'SUM(normalized amount_paid), attributed to report_date.'],
  ['refreshed_at', 'TIMESTAMPTZ', 'Same run timestamp as the branch summary.'],
]);
addP('Constraints and relationships: Each branch has many source orders and summary rows; each service has many orders and service-summary rows. Each customer can have many orders. The target composite keys prevent duplicate groups. Enforce service_key = COALESCE(service_type_id::text, \'unspecified\'); use nonnegative checks on counts and totals. Reject numeric overflow rather than rounding away an error.', 'Small');

subheading('5.3 Metric and relationship rules');
parts[parts.length - 1] = p('5.3 Metric and relationship rules', 'Heading2', { pageBreak: true });
addP('Dates and recorded payments. report_date is (created_at AT TIME ZONE \'Asia/Manila\')::date. recorded_payments_php is the sum of cumulative order payments assigned to that order date, including partial payments. It is not a payment-date cash-flow total. A later balance payment updates the original order date’s summary during the next full refresh.');
addP('Legacy and status handling. Use amount_paid when present; only for legacy null values use total_price when payment_status is paid, otherwise zero. Preserve final order prices instead of recalculating from current rates. Cancelled orders stay in the operational data but are excluded from report totals; cancellation alone does not imply a refund. released_order_count groups orders by creation date, not release date.');
addP('Grouping and reconciliation. A null service stays in the Unspecified group, so summing service counts, weights, values, and recorded payments for a branch/date must match the branch summary. Store only groups with qualifying orders; report charts can fill date gaps with zero. Do not sum unique_customer_count across dates or branches to infer unique people: the same customer may appear in several groups. Recalculate a wider distinct count from source customer IDs when needed.');
addP('Job metadata. Scheduling definitions and outcomes remain in the extension-managed cron.job and cron.job_run_details tables. They are monitoring records, not additional business reporting tables. Failed validation raises an exception so the job history records failure. [1]');

heading('6. Technology Justification');
subheading('PostgreSQL / Supabase');
addP('Selected because the current system already stores relational operational data in Supabase PostgreSQL. The proposed pipeline can read source tables and store results within the same database, using keys and transactions to preserve consistency. Large analytical jobs can compete with live transactions, so this design proposes an off-peak schedule and a measured runtime limit. [2]');
subheading('Supabase Cron / pg_cron');
addP('Selected to start the SQL refresh on a recurring daily schedule and record job outcomes inside PostgreSQL. This fits a short database-processing job and avoids introducing a separate scheduler service. The schedule and job history can be managed through Supabase. [1]');
subheading('SQL');
addP('Selected for extraction, joins, validation, date conversion, grouping, and loading. SQL operates directly on the existing relational data and keeps calculation rules in one scheduled database function. The function makes the proposed stages repeatable and reviewable. [3]');
subheading('Reporting Summary Tables');
addP('Selected as the destination for prepared branch and service totals. They are ordinary PostgreSQL tables, not a separate software product. They reduce repeated dashboard aggregation while making the reporting grain explicit. Their figures reflect the latest successful scheduled refresh, so reports must show refreshed_at.');
addP('Technology sources', 'Heading2');
addP('[1] Supabase. (n.d.). Cron; Quickstart. https://supabase.com/docs/guides/cron and https://supabase.com/docs/guides/cron/quickstart', 'Reference');
addP('[2] Supabase. (n.d.). Database overview. https://supabase.com/docs/guides/database/overview', 'Reference');
addP('[3] PostgreSQL Global Development Group. (n.d.). The SQL Language. https://www.postgresql.org/docs/current/sql.html', 'Reference');

const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri"/><w:color w:val="243D4C"/><w:sz w:val="21"/><w:lang w:val="en-PH"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="110" w:line="260" w:lineRule="auto"/><w:widowControl/></w:pPr></w:pPrDefault></w:docDefaults>${[
  ['Normal', '', '<w:spacing w:after="110" w:line="260" w:lineRule="auto"/>', ''],
  ['Title', 'Normal', '<w:keepNext/><w:spacing w:before="50" w:after="90"/>', '<w:b/><w:color w:val="163A50"/><w:sz w:val="44"/>'],
  ['Subtitle', 'Normal', '<w:keepNext/><w:spacing w:after="170"/>', '<w:color w:val="526978"/><w:sz w:val="22"/>'],
  ['Eyebrow', 'Normal', '<w:keepNext/><w:spacing w:after="80"/>', '<w:b/><w:color w:val="087E8B"/><w:sz w:val="18"/>'],
  ['Heading1', 'Normal', '<w:keepNext/><w:outlineLvl w:val="0"/><w:spacing w:before="180" w:after="100"/>', '<w:b/><w:color w:val="163A50"/><w:sz w:val="30"/>'],
  ['Heading2', 'Normal', '<w:keepNext/><w:outlineLvl w:val="1"/><w:spacing w:before="130" w:after="65"/>', '<w:b/><w:color w:val="087E8B"/><w:sz w:val="23"/>'],
  ['Caption', 'Normal', '<w:keepNext/><w:spacing w:before="60" w:after="75"/>', '<w:i/><w:color w:val="526978"/><w:sz w:val="18"/>'],
  ['Note', 'Normal', '<w:spacing w:before="50" w:after="130"/><w:pBdr><w:left w:val="single" w:sz="14" w:space="9" w:color="087E8B"/></w:pBdr>', '<w:sz w:val="19"/>'],
  ['Small', 'Normal', '<w:spacing w:after="90" w:line="235" w:lineRule="auto"/>', '<w:sz w:val="18"/>'],
  ['Reference', 'Small', '<w:spacing w:after="55"/>', '<w:sz w:val="17"/><w:color w:val="526978"/>'],
  ['TableText', 'Normal', '<w:spacing w:after="0" w:before="0" w:line="220" w:lineRule="auto"/>', '<w:sz w:val="18"/>'],
  ['AfterTable', 'Normal', '<w:spacing w:after="20" w:line="30" w:lineRule="exact"/>', '<w:sz w:val="2"/>'],
].map(([id, base, pp, rp])=>`<w:style w:type="paragraph" w:styleId="${id}"${id==='Normal'?' w:default="1"':''}><w:name w:val="${id}"/>${base?`<w:basedOn w:val="${base}"/>`:''}<w:pPr>${pp}</w:pPr><w:rPr>${rp}</w:rPr></w:style>`).join('')}</w:styles>`;
const ns = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"';
const section = `<w:sectPr><w:headerReference w:type="default" r:id="rIdHeader"/><w:footerReference w:type="default" r:id="rIdFooter"/><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1008" w:right="1008" w:bottom="1008" w:left="1008" w:header="430" w:footer="430"/><w:cols w:space="720"/></w:sectPr>`;
const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${ns}><w:body>${parts.join('')}${section}</w:body></w:document>`;
const footer = `<?xml version="1.0" encoding="UTF-8"?><w:ftr ${ns}><w:p><w:pPr><w:tabs><w:tab w:val="right" w:pos="${W}"/></w:tabs><w:spacing w:before="70"/><w:pBdr><w:top w:val="single" w:sz="4" w:color="D5E1E8"/></w:pBdr></w:pPr>${run('I&C LAUNDRY  |  PROPOSED SQL ETL', {size:16,color:'526978'})}<w:r><w:tab/></w:r>${run('Page ',{size:16,color:'526978'})}<w:fldSimple w:instr="PAGE"><w:r><w:rPr><w:sz w:val="16"/></w:rPr><w:t>1</w:t></w:r></w:fldSimple></w:p></w:ftr>`;
const header = `<?xml version="1.0" encoding="UTF-8"?><w:hdr ${ns}><w:p><w:pPr><w:jc w:val="right"/><w:spacing w:after="0"/></w:pPr>${run('TECHNICAL METADATA DOCUMENTATION',{size:16,color:'6F8491'})}</w:p></w:hdr>`;
const rel = (id,type,target)=>`<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}" Target="${target}"/>`;
const docRels = `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rel('rIdStyles','styles','styles.xml')}${rel('rIdHeader','header','header1.xml')}${rel('rIdFooter','footer','footer1.xml')}${rel('rIdSettings','settings','settings.xml')}${rel('rIdImage1','image','media/architecture.png')}${rel('rIdImage2','image','media/lineage-timeline.png')}</Relationships>`;
const contentTypes = `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/><Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/><Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>`;
const files = [
  ['[Content_Types].xml', contentTypes],
  ['_rels/.rels', `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rel('rIdDoc','officeDocument','word/document.xml')}<Relationship Id="rIdCore" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>`],
  ['docProps/core.xml', `<?xml version="1.0" encoding="UTF-8"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>I&amp;C Laundry - ETL Technical Metadata Documentation</dc:title><dc:subject>Proposed data pipeline, architecture, lineage, and schema metadata</dc:subject><dc:creator>I&amp;C Laundry Project</dc:creator><dc:description>Prepared to follow lab-2 using PostgreSQL / Supabase, Supabase Cron / pg_cron, SQL, and Reporting Summary Tables.</dc:description></cp:coreProperties>`],
  ['word/document.xml', document], ['word/styles.xml', styles], ['word/_rels/document.xml.rels', docRels],
  ['word/settings.xml', '<?xml version="1.0" encoding="UTF-8"?><w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:zoom w:percent="100"/><w:defaultTabStop w:val="720"/><w:updateFields w:val="true"/></w:settings>'],
  ['word/header1.xml', header], ['word/footer1.xml', footer],
  ['word/media/architecture.png', fs.readFileSync(path.join(dir,'architecture.png'))],
  ['word/media/lineage-timeline.png', fs.readFileSync(path.join(dir,'lineage-timeline.png'))],
];
const crcTable = Array.from({length:256}, (_,n)=>{ let c=n; for(let k=0;k<8;k++) c=c&1?0xedb88320^(c>>>1):c>>>1; return c>>>0; });
function crc32(bytes){ let c=0xffffffff; for(const b of bytes) c=crcTable[(c^b)&255]^(c>>>8); return (c^0xffffffff)>>>0; }
function zip(entries){
  const chunks=[], directory=[]; let offset=0;
  for(const [name, input] of entries){
    const filename=Buffer.from(name), data=Buffer.isBuffer(input)?input:Buffer.from(input), crc=crc32(data);
    const header=Buffer.alloc(30); header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20,4); header.writeUInt16LE(0x800,6); header.writeUInt32LE(crc,14); header.writeUInt32LE(data.length,18); header.writeUInt32LE(data.length,22); header.writeUInt16LE(filename.length,26);
    chunks.push(header,filename,data);
    const central=Buffer.alloc(46); central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20,4); central.writeUInt16LE(20,6); central.writeUInt16LE(0x800,8); central.writeUInt32LE(crc,16); central.writeUInt32LE(data.length,20); central.writeUInt32LE(data.length,24); central.writeUInt16LE(filename.length,28); central.writeUInt32LE(offset,42); directory.push(central,filename); offset+=header.length+filename.length+data.length;
  }
  const centralBuffer=Buffer.concat(directory), end=Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length,8); end.writeUInt16LE(entries.length,10); end.writeUInt32LE(centralBuffer.length,12); end.writeUInt32LE(offset,16); return Buffer.concat([...chunks,centralBuffer,end]);
}
fs.writeFileSync(output,zip(files));
console.log(JSON.stringify({output,tables:tableCount,figures:2,bytes:fs.statSync(output).size},null,2));
