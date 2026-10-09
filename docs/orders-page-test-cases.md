# Orders Page Test Cases

## Purpose and scope

This document defines manual test cases for the Orders page: order listing, search and status filters, pagination, table/board views, order creation and editing, service details, payment collection, status changes, cancellation, and release. Run mutation tests only in a dedicated Supabase staging project.

## Test setup

- Use the deployed test build connected to a non-production Supabase project.
- Prepare one admin account and staff accounts assigned to two different branches.
- Prepare test customers with valid Philippine mobile numbers and required email addresses.
- Prepare active services, branch inventory/add-ons, and orders in each order status. Include orders with multiple service items, partial payment, full payment, and a legacy unpaid balance.
- Record starting order/payment rows and inventory quantities so changes can be checked and test data cleaned up afterward.
- Use a test email/SMS provider or disable delivery. Do not send test notifications to real customers.

## Test cases

### ORD-001 - Load the Orders page

- **Type:** Positive / system
- **Preconditions:** User is signed in and has access to the Orders page.
- **Steps:** Open Orders and wait for data loading to finish.
- **Expected result:** The page displays the order list, status filters, search field, view controls, and New Order button. Loaded rows show their order number, customer, service, status, ETA, payment state, amount, and date. A load failure is reported with a retry option rather than leaving a partial list.
- **Actual result / status:** ____________________

### ORD-002 - Filter by order status

- **Type:** Positive
- **Preconditions:** Staging data includes orders in `received`, `on_process`, `ready`, `released`, and `cancelled` states.
- **Steps:** Select each status filter, then select **All**.
- **Expected result:** Each selected filter shows only orders with that order-level status; **All** shows all accessible statuses. Changing filters updates the order area without navigating away from the page.
- **Actual result / status:** ____________________

### ORD-003 - Search by order number and customer name

- **Type:** Positive / negative
- **Preconditions:** Staging data includes known order numbers and customer names, including an order not on the current page.
- **Steps:** Search using a full and partial order number; repeat with a full and partial customer name; search for a value with no match; clear the search.
- **Expected result:** Matching accessible orders are found by order number or customer name, including records beyond the current page. No-match search displays an empty result state and a way to clear the search.
- **Actual result / status:** ____________________

### ORD-004 - Combine search with a status filter

- **Type:** Integration / negative
- **Preconditions:** The same customer has test orders in at least two different statuses.
- **Steps:** Select one status filter and search for that customer.
- **Expected result:** Results match both the selected status and the search term. Record any result that matches the search but not the selected status as a defect for review.
- **Actual result / status:** ____________________

### ORD-005 - Paginate the order table

- **Type:** Positive / boundary
- **Preconditions:** At least 11 accessible orders exist; ideally include enough rows for three or more pages.
- **Steps:** Use first, next, previous, last, and a page-number control. Repeat after selecting a status filter. Search for an order and observe pagination.
- **Expected result:** Each page shows the correct range and no more than 10 rows. Controls are disabled at the first/last page. Pagination reflects the selected status results; it is hidden while searching.
- **Actual result / status:** ____________________

### ORD-006 - Switch between table and board views; expand service details

- **Type:** Positive
- **Preconditions:** At least one order has multiple service items.
- **Steps:** Switch between table and board view. Expand the service details for an order, then collapse them.
- **Expected result:** Both views show the applicable orders and statuses. Expanded details list each service item and its status, weight, loads, and subtotal; collapsing hides the detail without changing the order.
- **Actual result / status:** ____________________

### ORD-007 - Create an order for a new customer

- **Type:** Positive
- **Preconditions:** Admin or staff account is signed in; selected branch has an active service and required stock. Use a phone number not already registered in staging.
- **Steps:** Select **New Order**; enter a valid 11-digit `09` phone number, customer name, email, service, required weight/quantity, and (for admin) branch. Enter a payment equal to or above the displayed 50% minimum, then create the order.
- **Expected result:** The customer check identifies a new customer. One order and customer are created, the order starts as `received`, the correct branch/services/total/payment status are saved, and the new order appears in the list. No duplicate order is created by a repeated click.
- **Actual result / status:** ____________________

### ORD-008 - Create another order for an existing customer

- **Type:** Positive / integration
- **Preconditions:** A customer with a known phone number already exists in staging.
- **Steps:** Start a new order and enter that customer's phone number. Wait for lookup to finish, complete any required fields, add a valid service and qualifying payment, and submit.
- **Expected result:** The existing customer is identified and linked to the new order; a duplicate customer record is not created. The order is saved under the selected/assigned branch.
- **Actual result / status:** ____________________

### ORD-009 - Reject invalid or incomplete order details

- **Type:** Negative / boundary
- **Preconditions:** New Order form is open.
- **Steps:** Try to submit with each of these conditions: missing phone, malformed phone (not 11 digits beginning `09`), missing customer name, missing email, no valid service/weight/quantity, customer lookup still in progress or failed, missing admin branch, and payment below 50% of the calculated total.
- **Expected result:** Each invalid case is blocked with a useful message; no order, customer, or payment is created. Correcting the invalid value allows submission to continue.
- **Actual result / status:** ____________________

### ORD-010 - Verify initial payment boundary and payment status

- **Type:** Boundary
- **Preconditions:** New Order form has a valid service and calculated total greater than zero.
- **Steps:** Try an amount just below 50% of the total, exactly 50%, between 50% and the total, and equal to the total.
- **Expected result:** Below 50% is rejected. Exactly 50% and higher are accepted. Saved payment status is `partial` for an amount below the total and `paid` when it equals or exceeds the total. The payment method is cash.
- **Actual result / status:** ____________________

### ORD-011 - Edit an existing order without changing its payment history

- **Type:** Positive / negative
- **Preconditions:** An editable staging order exists, including an order with an existing payment-ledger row.
- **Steps:** Open Edit Order. Verify payment method and amount-paid fields are read-only. Attempt to change a service item on an order that already has service-item records, then try a permitted non-payment edit on a legacy order without service-item records.
- **Expected result:** Existing payment history cannot be overwritten. Service-item changes after placement are blocked with guidance to cancel and recreate the order. Any permitted edit saves without changing the original payment rows.
- **Actual result / status:** ____________________

### ORD-012 - Advance and correct an order's processing status

- **Type:** Positive / negative
- **Preconditions:** A test order is in `received` status; another is in `on_process` status.
- **Steps:** Advance the first order to `on_process`, then `ready`. Attempt to move it backward using the correction action, first without a reason and then with a reason.
- **Expected result:** Forward status changes follow `received` -> `on_process` -> `ready`. A backward correction requires a reason; with a reason, the status changes and the correction is recorded. Invalid transitions are rejected.
- **Actual result / status:** ____________________

### ORD-013 - Confirm release of a fully paid ready order

- **Type:** Positive / negative
- **Preconditions:** A `ready` order is fully paid.
- **Steps:** Select Release. In the confirmation dialog, choose **Keep as Ready**; reopen it and choose **Confirm Release**.
- **Expected result:** The first action leaves the order `ready`. The second records explicit confirmation, changes status to `released`, and records pickup time. The release confirmation appears even though the order is fully paid, and the released order cannot be cancelled.
- **Actual result / status:** ____________________

### ORD-014 - Settle the remaining balance before releasing

- **Type:** Positive / boundary
- **Preconditions:** A `ready` order has a positive remaining balance.
- **Steps:** Select Release and verify the displayed remaining amount. Cancel the dialog once. Reopen it and confirm payment/release.
- **Expected result:** Cancelling the dialog leaves status and ledger unchanged. Confirming collects exactly the remaining balance as a separate cash payment, updates payment status to `paid`, and releases the order. The order is not released without the settlement confirmation.
- **Actual result / status:** ____________________

### ORD-015 - Record an additional payment

- **Type:** Positive / negative / boundary
- **Preconditions:** An unreleased, uncancelled order has a positive balance.
- **Steps:** Open Record Payment. Try zero, a negative amount, an amount larger than the remaining balance, and then a valid amount equal to or less than the balance.
- **Expected result:** Invalid or excess amounts are rejected without a ledger change. A valid amount is recorded as a new cash payment; the prior payment record remains unchanged and the displayed balance/status updates.
- **Actual result / status:** ____________________

### ORD-016 - Cancel an order with a required reason

- **Type:** Positive / negative
- **Preconditions:** An active order with test inventory usage exists. Record its current inventory quantity and payment rows.
- **Steps:** Open Cancel Order. Attempt to confirm with a blank reason. Enter a reason and confirm. Reopen the order and inspect its status, inventory, and payment history.
- **Expected result:** Blank reason cannot be submitted. With a reason, the order becomes `cancelled`, used inventory is restored, and payment history remains recorded for audit. The cancelled order cannot be released or cancelled again.
- **Actual result / status:** ____________________

### ORD-017 - Verify staff branch access and admin branch assignment

- **Type:** Security / integration
- **Preconditions:** Orders exist in two branches; a staff account is assigned to one branch and an admin account is available.
- **Steps:** Sign in as staff and inspect/search orders and create an order. Sign in as admin and inspect the same orders and create an order with a selected branch.
- **Expected result:** Staff can access only the orders and customer information permitted for their branch, and new orders are assigned to their branch. Admin can access cross-branch orders and must be able to assign a new order to a branch.
- **Actual result / status:** ____________________

## Execution record

Record the tester, date, build/version, staging project, and browser/device before execution. For each failed case, file a defect with its test case ID, steps, expected result, actual result, evidence, and severity. Mark cases **Not Run** until executed; do not fill expected results into the actual-result field.
