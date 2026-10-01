# I&C Laundry manual UAT checklist

This is a browser-based acceptance test for the deployed site, performed as an
actual administrator, staff member, and public visitor. It is written for the
current three-stage workflow and the current administrator/staff account design.

## Live-server test run (use this first)

Open the deployed address in browser windows rather than running the local app.
Use test records whose names begin with `UAT -` so they can be identified and
removed afterward.

- [ ] Window A: normal browser profile signed in as a global administrator.
- [ ] Window B: Incognito/private profile signed in as Main-branch staff.
- [ ] Window C: separate browser/private profile signed in as Calzada-branch
  staff.
- [ ] Window D: Incognito/private profile with no sign-in, for the public site.
- [ ] Write the test order number, timestamp, and expected result beside every
  completed item. Screenshots are enough evidence.
- [ ] Begin with sections 2, 3, 4, 6, 9, 10, and 11: this follows the normal
  user journey from public site to login, order creation, processing, pickup,
  and tracking.
- [ ] Use only test email inboxes and test customer phone numbers. Do not send
  test OTPs or notifications to real customers.
- [ ] Do not run intentional rate-limit, repeated incorrect-password, expired
  OTP, or destructive delete tests against the live site during normal business
  hours. Run those in staging, or perform one controlled test after approval.
- [ ] Do not edit/delete real orders, customer records, staff accounts, or
  inventory while testing. Use the UAT records created for this run.

## 1. Prepare the test environment

- [ ] Before a production/UAT run, confirm the administrator has a database
  backup and that the deployed app is built from the intended commit.
- [ ] Confirm the Worker secrets exist: Supabase URL and service-role key,
  `PASSWORD_OTP_SECRET`, and the configured email delivery values.
- [ ] Run the migrations in `docs/migration-and-uat-checklist.md`, then also
  run `20260908_admin_global_accounts.sql` after the staff-provisioning
  migration.
- [ ] Run `20260907_verify_multi_branch_setup.sql`; investigate all unexpected
  non-zero data issues before sign-off.
- [ ] Create three test accounts: a global administrator, Main-branch staff,
  and Calzada-branch staff. Use three separate browsers/private windows.
- [ ] Prepare a real, accessible contact email for each test account. Do not
  use a real customer phone number while testing notifications.

Record the test date, build/commit ID, tester, account, branch, action,
expected outcome, actual outcome, and evidence (screenshot/order number).

## 2. Public website

- [ ] Open `/` in a private window. Confirm no dashboard data is visible.
- [ ] Check the public I&C Laundry name, contact details, working-hours data,
  images, and navigation on desktop and mobile.
- [ ] Submit the contact form with every required field blank. It must show
  validation and must not send a message.
- [ ] Submit a valid contact message. Confirm one success result and one
  branded email at the configured recipient. The email must have the I&C blue
  layout and the automated/no-reply footer.
- [ ] Search order tracking with blank, malformed, and unknown order numbers.
  It must not disclose whether any other order exists.
- [ ] Search using a real non-cancelled test order number. Confirm only the
  customer-safe fields appear: order number, service, weight, status, created
  date, and saved ETA. No staff, payment, branch inventory, email, or internal
  notes may appear.
- [ ] Cancel that order and repeat the public search. It must not be returned.

## 3. Authentication and session controls

- [ ] With an invalid password, login must fail without entering the dashboard.
- [ ] With a deleted/recycled account, login by username, account ID, or login email must fail with "Account does not exist." No session is returned.
- [ ] With a valid email and password, login must open the correct dashboard.
- [ ] Sign out, refresh, then revisit a protected URL such as
  `/dashboard/orders`. It must redirect to `/login`.
- [ ] Sign in as staff and manually enter an admin-only URL such as
  `/dashboard/staff`, `/dashboard/settings`, `/dashboard/analytics`, and
  `/dashboard/recycle-bin`. Each must redirect away or deny access.
- [ ] Sign in as an administrator and confirm the same pages are available.

### Identifier login check — current review item

- [ ] Attempt login with a staff username.
- [ ] Attempt login with the generated `IC-STAFF-...` account ID.
- [ ] Attempt login with the generated `IC-ADMIN-...` account ID.

Expected: all three identifiers work when paired with the correct password.
Current code note: `Login.jsx` calls Supabase directly, whereas account-ID and
username resolution exists only in the server `login` controller. If username
or account-ID fails, mark this **FAIL / release blocker**; do not claim the
feature is live until the login UI uses the server resolver or an equivalent
safe mechanism.

## 4. Provision, activation, and account lifecycle

- [ ] As an administrator, create a staff account with name, username, contact
  email, role, and Main branch.
- [ ] Confirm the generated credentials dialog contains an `IC-STAFF-...`
  account ID, username, temporary password, and Main branch. Save them once;
  the temporary password should not be retrievable later.
- [ ] Create an administrator account with a valid contact email.
- [ ] Confirm its credentials use `IC-ADMIN-...`, its role is Administrator,
  and no branch is shown or stored.
- [ ] Edit the administrator and confirm no branch assignment is required.
- [ ] Edit a staff member and confirm a valid branch remains required.
- [ ] Sign in using the temporary credentials. The account must be routed to
  activation and blocked from normal dashboard routes until activation ends.
- [ ] Set a 10+ character password twice. Confirm a fresh usable session and
  normal dashboard access after activation.
- [ ] Reset staff credentials as administrator. Confirm the old password no
  longer works, the new temporary credentials work, and activation is required
  again.
- [ ] Move the account to Recycle Bin. Confirm login fails and its data remains
  historically attributed.
- [ ] Restore it from Recycle Bin, then confirm login/activation behavior is
  intentional and documented for the restored record.

## 5. Password recovery and password change

### Forgot password (logged out)

- [ ] On `/forgot-password`, submit an unknown username/email/account ID.
  The page must show "Account does not exist." Repeat for a recycled account's username, account ID, login email, and recovery email; no OTP should be sent.
- [ ] Request a recovery code, then delete the account before using it. Password reset must show "Account does not exist."
- [ ] An account signed in before deletion cannot make protected API requests afterward. Restoring the account permits normal login again.
- [ ] Submit a known account with a contact email. Confirm one OTP email,
  branded I&C layout, masked destination in the UI, and no secret in browser
  logs.
- [ ] Enter a malformed OTP, a wrong OTP, and then a correct OTP. Wrong values
  must be rejected; correct value must permit a 10+ character matching password.
- [ ] After reset, confirm the old password fails, new password works, and the
  OTP cannot be reused.
- [ ] Request six wrong codes. The challenge must lock/expire after five
  attempts; request a fresh code and confirm the new one works.
- [ ] Wait ten minutes (or temporarily use a short expiry in staging). Confirm
  the expired OTP is rejected.

### Password change while logged in — current review item

- [ ] As staff, request an OTP from **Account Security**, enter an incorrect
  code, and attempt the change.
- [ ] As admin, repeat from **Settings > Account Security**.
- [ ] In both cases, enter the correct code and confirm the new password is
  accepted exactly once, a success dialog appears, and the old password fails
  on the next login.

Expected: both screens call `PATCH /api/auth/password`, which validates and
consumes the stored OTP. Current review found both screens call
`supabase.auth.updateUser({ password, otp })` directly after requesting a
server OTP. That means the server OTP verification/consumption path is not
used. Treat any incorrect-code acceptance, unused OTP, or failure to change as
a **FAIL / release blocker** and fix this before production sign-off.

## 6. Role and branch isolation

- [ ] Main staff creates a customer and order in Main.
- [ ] In the Calzada staff window, search customer/orders using the exact Main
  data. The Main order must not be listed, editable, cancellable, transitioned,
  or restocked by ID.
- [ ] Try direct API calls only in staging with Calzada staff session tokens;
  requests targeting a Main order/inventory item must return 403.
- [ ] Confirm Main staff sees the Main branch in the header and only Main
  branch lists.
- [ ] Confirm global administrator has no branch badge/assignment, can select
  a branch while creating an order/customer, and can view all branch data.
- [ ] Confirm changing a staff profile branch changes future access scope and
  does not turn the account into a global administrator.

## 7. Customers

- [ ] Add a customer with empty name/phone; it must be rejected.
- [ ] Add a valid customer as Main staff. Confirm they appear only in Main's
  staff directory and in the administrator master directory.
- [ ] Add/order the same normalized phone from Calzada. Confirm one central
  customer identity and associations in both branches; do not create duplicate
  people.
- [ ] Test lookup from the new-order form with formats such as `0917...` and
  `+63 917...`; confirm the known customer data is hydrated safely.
- [ ] Edit name and email; confirm intended values persist.
- [ ] Delete a customer, confirm the recycle-bin prompt, then restore as admin.

## 8. Inventory and expenses

- [ ] Add category/item with required values; verify its branch, unit, initial
  stock, minimum stock, cost, and usage-per-load display correctly.
- [ ] Add an item with initial stock and cost. Confirm one matching inventory
  expense is created.
- [ ] As staff, try choosing another branch in the UI and via a crafted request.
  It must not create or modify another branch's stock.
- [ ] Restock a Main item with quantity, total cost, and supplier. Confirm only
  Main stock changes, a restock log is created, and a matching expense exists.
- [ ] Attempt zero, negative, nonnumeric, or missing item restocks. All must
  fail without changing stock or creating an expense/log.
- [ ] Set stock at/below minimum and confirm the low-stock display is sensible.
- [ ] Delete and restore an inventory item as admin; confirm recycle-bin
  behavior and audit activity.

## 9. Create orders, payments, stock, and ETA

- [ ] As staff, open **New Order** and confirm the branch is locked to the
  staff branch. As admin, confirm branch selection is required.
- [ ] Validate missing customer name, phone, service (when services exist),
  branch (admin), zero weight, and less than 50% payment. None may create data.
- [ ] Create a valid paid order and a valid partial-payment order. Confirm each
  starts as **Received**, receives an `IC-...` number, stores service/weight,
  and displays one saved Estimated Ready time.
- [ ] Confirm default inventory usage-per-load and chosen add-ons are deducted
  once, only from the selected branch, with usage-log rows.
- [ ] Attempt an order requiring more stock than available. Confirm no order,
  inventory deduction, usage log, payment inconsistency, or customer-branch
  association is created.
- [ ] Confirm the received-order email/SMS only attempts delivery when a valid
  customer contact is available; inspect the email branding if delivered.
- [ ] Set a known fallback ETA in Settings. Create an order with fewer than the
  minimum completed comparable orders; expected ETA = default processing time
  plus buffer.
- [ ] Complete enough same-branch, same-service, same 4-kg weight-bucket
  orders. Create another comparable order; confirm it uses historical average
  plus buffer and exposes the appropriate ETA source/revised label.
- [ ] Change Settings later. Existing orders' saved ETA must not change.

## 10. Order management: list, table, and Kanban

- [ ] Test search, status filters, list/kanban switching, pagination, and
  responsive table overflow. Only the table should show a loading state during
  page changes; the page shell must not reload.
- [ ] Move one Received order to **On Process**. Confirm only that order shows
  a spinner until the new status is visible, then confirm
  `processing_started_at` is recorded.
- [ ] Move it to **Ready for Pickup**. Confirm `ready_at` and
  `actual_completion` are recorded and ready-notification delivery is attempted.
- [ ] Test the Kanban drag/drop path: drag only one stage forward. Skipping a
  stage or dropping onto a non-adjacent status must be disallowed.
- [ ] Test the row/card forward button; it must give the same result as drag/drop.
- [ ] Move On Process back to Received and Ready back to On Process. A reason
  must be required, the timeline must move back only one stage, the ETA must be
  revised, and a correction history record must exist.
- [ ] As the same staff member, undo the latest advance within the configured
  undo window. It should succeed only once and only for their own latest action.
- [ ] Let the undo window expire, or use another staff account. It must be
  denied; an administrator may correct the active order with a reason.
- [ ] Try to move released/cancelled orders. Both must be locked from stage
  changes and cancelled orders must have no edit action.
- [ ] Cancel an active order with a nonempty reason. Confirm its status becomes
  Cancelled, inventory is restored once, and it becomes unavailable from public
  tracking.

## 11. Payment completion and release

- [ ] Attempt to release a Ready order with a balance. It must open payment
  completion / reject release until the full amount is paid.
- [ ] Enter an amount smaller than the balance. Release must remain blocked.
- [ ] Complete the exact remaining balance. Confirm amount paid equals total,
  payment status is Paid, then the order becomes Released with `picked_up_at`.
- [ ] Confirm a released order cannot be moved backwards, cancelled, or edited
  as an active garment.

## 12. Notifications

- [ ] As an authenticated account, send a manual email with missing recipient,
  subject, or body. It must validate locally/server-side and not send.
- [ ] Send one valid manual email to a test inbox. Confirm I&C-branded HTML,
  readable plain text, subject/body, and automated/no-reply footer.
- [ ] Send a Ready-for-Pickup email from an order with customer email.
- [ ] Exercise SMS only if the provider is configured. Confirm no secrets or
  OTPs appear in messages/logs and failed delivery reports a safe error.

## 13. Administrator-only operations

- [ ] In Settings, save valid pricing, default ETA, ETA buffer, minimum
  historical sample count, and undo window; reload and confirm persistence.
- [ ] Save invalid values (zero/negative where disallowed) and confirm the
  UI/database handles them safely.
- [ ] Toggle dark mode and notifications, reload, and verify expected behavior.
- [ ] Open Staff management, edit staff/admin role and account details, reset
  credentials, delete, and restore records.
- [ ] Confirm a newly created global admin can access Dashboard, Orders,
  Customers, Inventory, Analytics, SMS, Staff, Settings, and Recycle Bin with
  no branch assignment.

## 14. Dashboard, analytics, DSS, and reporting

- [ ] As staff, confirm Staff Dashboard contains only the assigned branch's
  operations and the permitted DSS overview.
- [ ] As admin, change dashboard/analytics range and branch filters; figures,
  charts, recent orders, revenue, expense, and service counts must update
  consistently.
- [ ] Verify cancelled orders are excluded where the report states they should
  be excluded, and partial payments count only recorded paid amounts.
- [ ] Test Analytics **Export CSV**. Open the file and confirm it reflects the
  selected scope/range and contains no unrelated branch data.
- [ ] Test **Print / PDF** and confirm summary cards, service rows, branch rows,
  DSS insights, and generated date are readable.
- [ ] With Gemini configured, wait for forecast/DSS output. Confirm provider
  state is shown. With Gemini unavailable, confirm safe local fallback and no
  dashboard crash.

## 15. Recycle bin and audit trail

- [ ] As staff, direct navigation to Recycle Bin must not reveal records.
- [ ] As admin, delete one disposable customer, inventory item, category,
  service type, expense, and staff account (separately).
- [ ] Confirm each appears in Recycle Bin with type, name, branch, timestamp,
  and restore action.
- [ ] Restore each item and confirm it returns to active lists exactly once.
- [ ] Confirm recent delete/restore activity identifies action, table, record,
  actor, branch (where applicable), and timestamp.
- [ ] Inspect `order_stage_history` for create, advance, correction, release,
  and cancel events, including correction reason and ETA before/after.

## 16. Responsive, reliability, and security smoke tests

- [ ] Test at 320px, 375px, 768px, 1024px, and desktop widths. Check login,
  public tracking/contact, dashboard, orders list/Kanban, forms, modals,
  settings, analytics, and tables.
- [ ] On mobile, open/close the side nav, select every available navigation
  item, and tap outside to close. The page behind it must remain usable and the
  menu labels/icons must remain visible.
- [ ] Confirm loading an order transition, page change, restock, and modal save
  does not cause a full-browser page reload.
- [ ] Refresh during a normal session; access should restore safely. Refresh
  during account activation; it must remain possible to finish activation.
- [ ] In browser DevTools Network, confirm API error responses do not expose
  Supabase service-role keys, mail secrets, OTP plaintext, stack traces, or
  internal database details.
- [ ] Verify security headers on an API response: CSP, HSTS, frame denial,
  `nosniff`, referrer policy, and API `Cache-Control: no-store`.
- [ ] Trigger rate-limit limits only on staging: login (10/15 min), password
  OTP (5/15 min), forgot OTP (5/15 min), contact (3/15 min), and public
  tracking (30/min). Confirm 429 with a retry time, then normal recovery after
  the window.

## Sign-off

- [ ] Every applicable test is PASS with evidence attached.
- [ ] Every known review item above is fixed and retested; no release blockers
  remain.
- [ ] Database verification is clean and a backup/rollback point exists.
- [ ] Staging and production use the same required migrations and secrets.
- [ ] Production smoke test completed: login, order create, status advance,
  order tracking, one email, and sign out.
