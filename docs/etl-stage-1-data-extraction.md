# I&C Laundry Daily Branch Reporting ETL
## Stage 1 - Data Extraction

### Objective

The goal of this stage is to extract data from an identified source system and prepare a documented, traceable, and validated dataset for the next stage of the data pipeline.

---

## 1. Data Source and Extraction Specification

### Source system

The source system is I&C Laundry's shared operational database for its Main, Calzada, and Nasugbu branches. The system records branch, customer, order, service-item, payment, service-catalog, and expense information used for branch-level reporting.

### Source database

- **Database:** I&C Laundry operational database
- **DBMS and hosting:** PostgreSQL on Supabase
- **Schema:** `public`
- **Access:** The extraction process uses an authorized read-only database identity. Store credentials in the job runtime's secret manager and do not include them in output data or logs.

Before a run, compare the selected tables and columns in Section 2 with the deployed database catalog. The extraction must stop if a required table or column is absent or incompatible.

### Extraction method

- **Mode:** Full-history extraction of all selected rows on each run. No incremental cursor or watermark is used. This allows a later run to include historical corrections and late-entered payments.
- **Consistency:** Read all selected tables in one read-only transaction using PostgreSQL `REPEATABLE READ` isolation so the extracts share one database snapshot. Record when the first source read establishes the snapshot. Do not join source transaction tables when producing the raw datasets.
- **Output:** Produce one raw dataset per selected source table, plus a manifest and validation results. Preserve source values, names, data types, and NULLs. Record the physical serialization format and its NULL/quoting rules in the manifest.
- **Filtering:** Extract cancelled orders, soft-deleted records, and rows with nullable references or dates. Do not apply business filters or alter source values in this stage.
- **Schedule:** Supabase Cron / `pg_cron` is the selected scheduler. Run daily at **01:00 Asia/Manila (UTC+08:00)**. If configured for UTC, use `0 17 * * *`. Verify the scheduler timezone and job configuration before enabling the schedule.
- **Extraction range:** Include all available history through the transaction snapshot. Date cutoffs, local business dates, exclusions, and reporting calculations are handled by Transformation.

### Extraction technology

- PostgreSQL / Supabase
- Supabase Cron / `pg_cron` for scheduled orchestration
- SQL `SELECT` queries and PostgreSQL transaction-local staging tables
- Reporting summary table: `analytics.daily_branch_summary` is the planned downstream target; it is outside this extraction stage

The scheduled job is identified as `ic_laundry_daily_reports` and invokes the planned SQL refresh function `analytics.refresh_daily_reports()`. The scheduler, function, staging tables, and reporting target must be verified in the deployed database before the pipeline is treated as operational.

### Extraction scope

Extract only the selected columns listed in Section 2 from `branches`, `customers`, `orders`, `order_items`, `payments`, `service_types`, and `expenses`. These fields support branch identification, order and service demand, payment collections, expense reporting, and customer activity. Customer names and contact details are excluded; retain customer identifiers and the minimum timestamps needed for customer activity.

### Source limitations and assumptions

- The extraction requires read access to all seven tables and a single PostgreSQL connection capable of holding a read-only `REPEATABLE READ` transaction.
- `orders.created_at` and `customers.created_at` are nullable in the expected schema. Preserve NULLs and report them; do not invent dates.
- `payments.paid_at` and `expenses.expense_date` are required by the expected schema. A NULL value in either field indicates a schema or data-integrity problem and must fail validation.
- Branch references on customers, orders, payments, and expenses may be NULL. Preserve and report such records for review. `order_items.branch_id` is required.
- Service-item snapshots preserve the service name and price components used when an order was placed. Use those snapshots for historical service reporting; current catalog prices must not replace historical values.
- Full-history reads grow as data accumulates. Monitor run duration and database load before changing to incremental extraction. An incremental design would require a tested change cursor and a policy for late-arriving or corrected records.

---

## 2. Source Tables and Column Specification

The selected columns below are the extraction contract. `NULL` denotes a nullable column in the expected schema. PostgreSQL `NUMERIC` values are retained exactly; their precision and scale are not constrained by this document. Primary keys and foreign-key relationships must be verified during schema preflight.

| Source table | Purpose | Selected columns and data types | Primary key and relationships | Reason for inclusion |
|---|---|---|---|---|
| `public.branches` | Branch reference data | `id UUID`; `branch_name TEXT`; `name TEXT NULL`; `code TEXT NULL`; `status TEXT`; `is_active BOOLEAN NULL` | PK: `id`. Referenced by customers, orders, order items, payments, and expenses. | Resolves branch IDs and supplies the branch label and branch status. |
| `public.customers` | Customer reference and activity | `id UUID`; `branch_id UUID NULL`; `created_at TIMESTAMPTZ NULL`; `deleted_at TIMESTAMPTZ NULL` | PK: `id`; `branch_id` references `branches.id`. Referenced by `orders.customer_id`. | Supports distinct-customer and customer-activity measures without exporting names, phone numbers, email addresses, or addresses. |
| `public.orders` | Order-level transactions and status | `id UUID`; `order_number TEXT`; `customer_id UUID NULL`; `service_type_id UUID NULL`; `branch_id UUID NULL`; `created_at TIMESTAMPTZ NULL`; `status TEXT`; `payment_status TEXT`; `weight_kg NUMERIC`; `total_price NUMERIC` | PK: `id`; unique identifier: `order_number`; `customer_id` references `customers.id`; `service_type_id` references `service_types.id`; `branch_id` references `branches.id`. | Supports order counts, branch assignment, customer activity, order status, overall order weight, and order value. Retain every status, including cancelled orders. |
| `public.order_items` | Service-level detail for each order | `id UUID`; `order_id UUID`; `branch_id UUID`; `service_type_id UUID NULL`; `service_name_snapshot TEXT`; `pricing_type_snapshot TEXT`; `bundle_kg_snapshot NUMERIC`; `bundle_price_snapshot NUMERIC`; `excess_kg_price_snapshot NUMERIC`; `processing_type_snapshot TEXT`; `weight_kg NUMERIC`; `quantity NUMERIC`; `loads INTEGER`; `unit_price_snapshot NUMERIC`; `subtotal NUMERIC`; `status TEXT`; `processing_started_at TIMESTAMPTZ NULL`; `completed_at TIMESTAMPTZ NULL`; `created_at TIMESTAMPTZ` | PK: `id`; `order_id` references `orders.id`; `branch_id` references `branches.id`; `service_type_id` references `service_types.id`. | Provides service-level demand, item status, processing dates, and historical price snapshots without multiplying order-level rows. |
| `public.payments` | Payment ledger | `id UUID`; `order_id UUID`; `branch_id UUID NULL`; `amount NUMERIC`; `payment_method TEXT`; `payment_status TEXT`; `paid_at TIMESTAMPTZ`; `source TEXT` | PK: `id`; `order_id` references `orders.id`; `branch_id` references `branches.id`. | Supports collections by payment date and branch. Preserve individual ledger rows and historical payment methods/statuses. |
| `public.service_types` | Service reference | `id UUID` | PK: `id`; referenced by `orders.service_type_id` and `order_items.service_type_id`. | Allows validation of service references. Historical service names and prices are taken from `order_items` snapshots. |
| `public.expenses` | Branch expense records | `id UUID`; `branch_id UUID NULL`; `category TEXT`; `amount NUMERIC`; `expense_date DATE`; `deleted_at TIMESTAMPTZ NULL` | PK: `id`; `branch_id` references `branches.id`. | Supports expense reporting by branch, category, and expense date. Retain soft-deleted records for downstream rules. |

### Row grain

Each output dataset preserves one source row per row in its corresponding table. Keep order-level records (`orders`), service-level records (`order_items`), and payment-ledger records (`payments`) separate. Do not join one-to-many tables into the raw extracts because that would duplicate source rows and distort counts or amounts.

---

## 3. Extraction Validation and Data Quality Checks

These checks determine whether the source snapshot was extracted completely and faithfully. They do not clean, standardize, filter, or transform business data.

| Check name | Target | Purpose | Validation criteria |
|---|---|---|---|
| Source connection and accessibility | PostgreSQL connection and all seven selected tables | Confirm the job reaches the expected database and can read its inputs. | **PASS:** read-only probes succeed for every table. **FAIL:** wrong database, timeout, authentication/permission error, or inaccessible table. |
| Required tables and columns | Selected tables and fields in Section 2 | Detect schema drift before extraction. | **PASS:** all required tables and columns exist with compatible types. **FAIL:** any required table/column is missing or incompatible; stop the run. |
| Required identifiers | Primary keys and required identifiers in each selected table | Ensure rows can be traced and related. | **PASS:** primary keys are non-NULL and required identifiers such as `order_number` are present. **FAIL:** any required identifier is NULL. |
| Key uniqueness | `id` in each selected table and `orders.order_number` | Detect duplicate source keys or output duplication. | **PASS:** distinct `id` count equals row count per table and `order_number` is unique. **FAIL:** either condition fails. |
| Foreign-key coverage | Selected branch, customer, order, and service references | Find unresolved relationships without changing or dropping rows. | **PASS:** every non-NULL reference matches a key in its extracted reference dataset. **WARNING:** a nullable reference is NULL; retain and report the row. **FAIL:** a non-NULL reference has no matching key. |
| Required date availability | `payments.paid_at`, `expenses.expense_date`, `order_items.created_at`, and nullable `orders.created_at` / `customers.created_at` | Identify records whose dates are needed for downstream reporting. | **PASS:** required dates are present and valid. **WARNING:** a nullable order/customer creation date is NULL; retain and report it. **FAIL:** a required payment, expense, or order-item date is NULL or invalid. |
| Record-count completeness | Source snapshot and output dataset for each table | Confirm all rows visible in the snapshot were emitted. | **PASS:** source and output row counts match for every table. **FAIL:** any mismatch, missing dataset, or truncated output. Record unusual count changes for review. |
| Extraction errors and interruption | Run status and all output datasets | Prevent partial output from being accepted. | **PASS:** every query, serialization, write, and validation completes and the run receives a completion record. **FAIL:** any operation fails or the run remains incomplete; isolate its partial outputs. |
| Snapshot consistency | Transaction metadata for all seven tables | Ensure datasets represent the same source view. | **PASS:** all reads use the same `REPEATABLE READ` transaction snapshot. **FAIL:** a table was read outside that snapshot or snapshot metadata is missing. |
| Value serialization | Selected UUID, NUMERIC, DATE, TIMESTAMPTZ, text, and boolean fields | Detect loss or corruption in output packaging. | **PASS:** values round-trip without changing exact numeric values, NULLs, or timestamp instants/offsets. **FAIL:** a value is malformed, lost, rounded, or changed. |

Record check results and affected-row counts at both table and run level. Warnings do not authorize changing or deleting source rows.

---

## 4. Extraction Metadata and Log Specification

Create one run record and one table-level record for each selected table. Store operational metadata separately from the raw dataset. Do not place credentials or customer contact information in logs.

| Field | Purpose | Example value or format |
|---|---|---|
| `pipeline_run_id` | Links all table outputs, checks, and handover records to one run. | UUID, e.g. `7d1e...` |
| `pipeline_name` | Identifies the extraction process. | `ic_laundry_daily_branch_reporting` |
| `source_system` | Identifies the operational source. | `I&C Laundry Supabase PostgreSQL` |
| `table_name` | Identifies the table-level extraction. | `public.order_items` |
| `snapshot_started_at` | Records when the first source read established the transaction snapshot. | ISO 8601 timestamp with timezone |
| `extraction_started_at` | Records when a run/table read began. | ISO 8601 timestamp with timezone |
| `extraction_ended_at` | Records when a run/table read ended. | ISO 8601 timestamp with timezone |
| `extraction_status` | Records the current or final result. | `RUNNING`, `PASS`, `WARNING`, or `FAIL` |
| `records_read` | Number of source rows read in the snapshot. | Non-negative integer, e.g. `1250` |
| `records_extracted` | Number of rows written to the raw dataset. | Non-negative integer, e.g. `1250` |
| `records_rejected` | Number withheld under a documented extraction rule; current design retains rows, so this should be `0`. | Non-negative integer, e.g. `0` |
| `extraction_window` | Describes the history included. | `all available rows through snapshot_started_at` |
| `validation_results` | Stores named check results and affected counts. | JSON, e.g. `{"pk_unique":"PASS","orders_null_created_at":"WARNING:2"}` |
| `error_code` | Provides a stable category for a failure. | `SOURCE_TIMEOUT`, `SCHEMA_MISMATCH`, or `NULL` |
| `error_message` | Gives operators a sanitized diagnostic. | `Read of public.payments timed out`, or `NULL` |
| `duration_ms` | Measures extraction duration. | Non-negative integer, e.g. `8420` |
| `output_reference` | Locates a table dataset in the run package. | Controlled path, URI, or package ID |
| `source_row_count` | Records the count read from the source snapshot. | Non-negative integer, e.g. `1250` |
| `output_checksum` | Helps verify output integrity. | SHA-256 hex digest |

Use the metadata to monitor scheduled runs, troubleshoot errors, support audits and recovery, and reconcile source and output counts. A retry receives a new `pipeline_run_id`; incomplete output must not be marked approved.

---

## 5. Log Retention and Access

- **Retention period:** Retain operational extraction logs for at least **one year**. This supports run monitoring, troubleshooting, and recovery over time.
- **Storage location:** Store run and table logs in a restricted ETL operations metadata store, separate from raw data. Record its deployed database/schema or storage path in the job configuration before production runs.
- **Access permissions:** The extraction identity may write run metadata. ETL operators and designated data owners may read logs and validation results. Restrict source credentials to the job runtime and authorized database administrators.
- **Archiving:** Archive logs when required for an audit or recovery. Preserve run IDs, timestamps, table names, validation outcomes, counts, and sanitized errors with equivalent access controls.
- **Deletion rules:** An authorized ETL or database administrator may delete operational logs only after the retention period has passed and they are no longer needed for troubleshooting, auditing, or recovery. Record the scope, date, and responsible role. Do not delete logs early to free storage.
- **Operational and audit records:** The one-year retention applies to operational extraction logs. Separate audit records follow any longer organizational retention requirement.

---

## 6. Extraction Data Contract and Naming Convention

### Required schema

The handover contains one raw dataset for each table in Section 2, with only the selected columns shown there. Preserve source table/column names, row grain, primary keys, foreign keys, declared PostgreSQL types, and NULL values. Do not substitute defaults for missing values or convert exact `NUMERIC` values through floating point.

### Naming convention

- Preserve source table and column names in lowercase `snake_case`.
- Do not abbreviate or rename source fields in the raw extraction.
- Preserve primary keys as `id` and foreign keys with their source names, such as `branch_id`, `customer_id`, `order_id`, and `service_type_id`.
- Serialize UUID, NUMERIC, DATE, TIMESTAMPTZ, TEXT, BOOLEAN, and NULL values without loss. Document the output format and its NULL/quoting conventions in the manifest.

### Source-to-extract field mapping

Stage 1 does not create standardized target names or apply transformations. Each selected source column maps to an identically named output column with the same type and value. This is an identity mapping, not a source-to-standardized transformation.

| Source column | Extracted column | Source type | Target type | Mapping type |
|---|---|---|---|---|
| `orders.order_number` | `order_number` | `TEXT` | `TEXT` | Preserve |
| `orders.created_at` | `created_at` | `TIMESTAMPTZ NULL` | `TIMESTAMPTZ NULL` | Preserve |
| `order_items.service_name_snapshot` | `service_name_snapshot` | `TEXT` | `TEXT` | Preserve |
| `order_items.subtotal` | `subtotal` | `NUMERIC` | `NUMERIC` | Preserve |
| `payments.paid_at` | `paid_at` | `TIMESTAMPTZ` | `TIMESTAMPTZ` | Preserve |
| `expenses.expense_date` | `expense_date` | `DATE` | `DATE` | Preserve |

The same identity mapping applies to every selected field listed in Section 2. Cleaning, standardization, local-date derivation, business filtering, and aggregation belong to Transformation.

### Schema consistency

Compare the live source catalog with this contract before extraction. Stop if a required table or column is missing, renamed, or incompatible in type. Report nullability, key, or relationship changes for review before accepting the run. Ignore unselected source columns unless the contract is formally updated. Do not guess casts, defaults, or replacement fields.

---

## 7. Extraction Acceptance and Handover Rules

| Validation condition | Acceptance criteria | Pipeline action | Decision and responsible role |
|---|---|---|---|
| Critical checks pass for every table | Source access, schema, required IDs, primary-key uniqueness, snapshot consistency, row counts, serialization, and output completion all pass. | Mark package `APPROVED` and pass it to Transformation. | Automatic pipeline decision. |
| Critical checks pass but reviewable warnings remain | Nullable `orders.created_at` or `customers.created_at`, nullable branch/customer references, or an unusual but complete row-count change is reported. | Hold package from automatic transformation until review is recorded. | `MANUAL REVIEW` by ETL operator or designated data owner. |
| Any critical check fails | Source/table unavailable, required schema mismatch, missing required ID, duplicate primary key, unmatched non-NULL foreign key, count mismatch, invalid required date, inconsistent snapshot, or incomplete/corrupt output. | Mark run `REJECTED`/`FAIL`; quarantine partial output and stop handover. Retry only transient failures, using a new run ID. | Automatic stop; ETL operator resolves the failure. |

### Automatic approval

Approve only when every critical check passes for all seven tables and the complete datasets, manifest, and validation results are available.

### Manual review

Require review for non-critical nullable values or unusual counts that do not compromise extraction integrity. The reviewer records the affected table/check, count, decision, rationale, role, and timestamp. Review does not permit editing raw values.

### Rejection, retry, and quarantine

Do not hand off a failed or partial run. Isolate partial outputs with operator-only access. Apply bounded retries to transient connection/time-out errors; remediate schema and permission failures before retrying. Start each retry with a new run ID and never silently omit a table.

### Handover

Pass to Transformation:

1. Seven complete raw datasets, one per selected source table.
2. A manifest with the run ID, source tables, snapshot and extraction timestamps, full-history window, output references and format, row counts, and checksums.
3. Table-level and overall validation results, warnings, rejected counts, and sanitized errors.
4. The extraction-contract version and overall acceptance decision.

The receiving stage acknowledges the run ID and acceptance status. Transformation performs any cleaning, standardization, business filtering, local-date derivation, and reporting calculations.

---

## 8. Common Extraction Problems and Mitigation

| Problem | Possible cause | Impact on extraction | Proposed mitigation |
|---|---|---|---|
| PostgreSQL/Supabase connection failure | Network interruption, unavailable database, or invalid endpoint | One or more source reads cannot complete; the snapshot cannot be accepted. | Apply bounded retries for transient failures, alert the operator, and reject incomplete output. |
| Read permission failure | Expired credentials, rotated secret, or changed database grants | Required tables may be inaccessible and the package incomplete. | Probe read access to all seven tables before extraction; restore least-privilege access and start a new run. |
| Required schema drift | A selected table/column is renamed, removed, or changes type/nullability | Queries may fail or output may violate the data contract. | Run schema preflight, stop on incompatible changes, review and version the contract, then retry. |
| Snapshot isolation is not maintained | Reads use separate connections or `READ COMMITTED` statements | Tables may reflect different source moments, weakening count and relationship checks. | Use one read-only `REPEATABLE READ` transaction for all selected table reads and record its snapshot metadata. |
| Extraction or output write is interrupted | Worker restart, timeout, connection loss, or storage error | Partial datasets may be mistaken for a complete run. | Track completion per table, quarantine partial output, mark the run failed, and repeat under a new run ID. |
| Source/output counts differ | Truncated transfer, serialization defect, or incorrect query | Rows may be missing or duplicated in the handover. | Compare per-table counts and checksums; reject mismatches and investigate before retrying. |
| Missing or duplicate IDs / unresolved references | Source integrity issue or output defect | Rows cannot be reliably traced or related to branches, orders, customers, or services. | Validate IDs and relationships per table; retain affected data for diagnosis and stop acceptance for critical failures. |
| Nullable reporting dates or required date is absent | Legacy record has no order/customer creation date, or required payment/expense/item date is invalid | Nullable dates may limit downstream analysis; invalid required dates violate the source contract. | Preserve nullable dates and flag them for review. Fail validation for missing/invalid required dates; do not impute values. |
| Late payment or historical correction | A payment is entered later or an old source row is corrected | A date-window-only incremental run could miss a prior-period change. | Extract full history each run. If volume requires incremental mode, define and test a change cursor and correction/lookback policy first. |
| Data serialization changes a value | Floating-point conversion, timestamp conversion, or ambiguous NULL encoding | Raw output no longer faithfully represents the source. | Preserve exact decimals and timestamp semantics, document NULL encoding, and run round-trip checks before approval. |
| Scheduler uses the wrong timezone | Scheduler is configured in UTC while the target time is Manila local time | The run starts at an unintended time or is missed. | Verify scheduler timezone and run history; use `0 17 * * *` UTC for 01:00 Asia/Manila when the scheduler is UTC. |
| Full-history extraction grows too large | Historical tables grow or extraction overlaps busy database usage | Longer runs or increased source load may affect operations. | Monitor duration and database load; schedule off-peak and assess an incremental design only with a correction/lookback policy. |

---

## Expected Output

Stage 1 produces seven raw datasets (`branches`, `customers`, `orders`, `order_items`, `payments`, `service_types`, and `expenses`) plus a manifest, run metadata, validation results, and an acceptance decision. The package preserves selected source values and row grain for handover to Transformation. It does not clean, standardize, apply business filters, derive reporting dates, or calculate business measures.
