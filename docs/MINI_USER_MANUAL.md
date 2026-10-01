# I&C Laundry Management System

## Mini User Manual

**Purpose:** This guide explains how staff and administrators use the system for customers, multi-service laundry orders, payments, inventory, reporting, and account management.

> The exact records visible to a user depend on their role and assigned branch. Administrators can work across all branches. Normal staff are limited to their assigned branch.

---

## 1. User roles

| Feature | Staff | Administrator |
|---|---:|---:|
| Branch dashboard | Yes, assigned branch | Yes, all branches |
| Garment orders | Assigned branch | All branches |
| Clients | Assigned branch | All branches |
| Inventory | Assigned branch | All branches |
| Analytics and reports | No | Yes |
| Service and pricing setup | No | Yes |
| Notifications | No | Yes |
| Staff accounts | No | Yes |
| Audit Log and restore | No | Yes |
| System settings | Account Security only | Yes |

## 2. Signing in

1. Open the system and select **Sign In**.
2. Enter the assigned username, Account ID, or email and password.
3. Select **Sign In**.
4. A newly created account must replace its temporary password during the first sign-in.
5. To recover a password, select **Forgot password**, request the email verification code, enter the six-digit code, and create a new password.

Keep passwords and verification codes private. Select **Sign Out** from the bottom of the navigation menu after using a shared computer.

## 3. Navigation

- **Dashboard** shows the current workload, order totals, low-stock alerts, forecasts, and recent activity.
- **Garment** creates and manages laundry orders.
- **Client** stores customer information and loyalty history.
- **Inventory** manages branch stock and restocking.
- **Account Security** lets staff change their password after email verification.
- **Analytics** provides administrator-only financial and operational reports.
- **Services** configures services, prices, automatic stock deductions, and add-ons.
- **Notifications** sends customer emails and quick order notifications.
- **Staff** creates and maintains user accounts.
- **Audit Log** displays important activity and restores archived records.
- **Settings** manages administrator security, appearance, ETA rules, and loyalty rules.

On a phone or narrow screen, use the menu button to open the navigation drawer. Wide tables can be scrolled horizontally.

---

## 4. Staff workflow

### 4.1 Review the branch dashboard

After signing in, staff see information for their assigned branch:

- active, in-process, and ready orders;
- low-stock items;
- the current work queue;
- an AI-assisted, read-only workload and revenue outlook; and
- a restock warning when an item reaches its minimum level.

Forecasts and recommendations are decision-support estimates. Staff should still consider actual walk-ins, machine availability, supplies, and staffing conditions.

### 4.2 Add or find a client

1. Open **Client**.
2. Search by name, phone number, or email before adding a new record.
3. Select **Add Customer** if no matching customer exists.
4. Enter the customer’s name, valid Philippine mobile number, and email.
5. Select **Add Customer**.

The order form can also find an existing customer using their phone number. Reuse that record to avoid duplicates.

### 4.3 Create a multi-service order

1. Open **Garment** and select **New Order**.
2. Enter the customer’s mobile number.
3. Select the existing customer or complete the required customer information.
4. In **Services**, select the first service and enter its weight.
5. Add another service when the same order contains different laundry services.
6. Enter the correct weight for each service separately.
7. Select any available add-ons and their quantities.
8. Review the **Price Breakdown**.
9. Enter the initial payment. At least **50% of the final total** is required.
10. Review the order and select **Create Order** once.

The system creates one order number containing all selected services. It also:

- calculates each service price;
- adds eligible add-ons;
- applies an eligible loyalty reward automatically;
- records the initial payment;
- deducts the required branch inventory; and
- assigns the initial status and estimated-ready time.

Do not refresh or close the page while the order is being submitted. Repeated submissions with the same request are protected against duplicate order creation and stock deduction.

### 4.4 How pricing works

Each service has its own:

- included kilograms per load;
- bundle or load price;
- excess-kilogram price; and
- processing type.

For each service, the current price calculation is:

`bundle price + rounded-up excess kilograms × excess-kilogram price`

The final order total is the sum of all service subtotals and selected add-ons, less any automatically applied loyalty reward.

The calculated **load count** is used for automatic inventory consumption:

`loads = weight ÷ kilograms included per load, rounded up`

### 4.5 View all services in an order

The Services column initially shows the first service and a `+number` indicator when more services exist.

1. Select the service name or `+number` indicator.
2. Review every service’s name, weight, loads, subtotal, add-ons, and current service status.
3. Select the same control again to collapse the details.

This works in both table and board views.

### 4.6 How ETA works for different services

The system estimates each service using its branch, service type, and weight. When enough comparable completed history exists, it uses the historical average plus the configured safety buffer. Otherwise, it uses the default processing time plus the buffer.

For a multi-service order, the order’s displayed ETA uses the **longest service estimate**, not the sum of all estimates.

Example:

| Service | Estimate |
|---|---:|
| Wash and Fold | 90 minutes |
| Comforter | 180 minutes |
| Air Dry | 120 minutes |
| **Displayed order ETA** | **180 minutes** |

This assumes the services can be processed in parallel. If a stage is corrected backward, the system can revise the order ETA.

### 4.7 Process an order

The parent order follows this lifecycle:

`Received → On Process → Ready for Pick-Up → Released`

Service items follow:

`Received → On Process → Completed`

To advance the current order:

1. In **Garment**, locate the order using search or a status filter.
2. From `Received`, select the forward arrow to start processing.
3. From `On Process`, select the forward arrow to mark the services completed and the order Ready.
4. Verify the payment before releasing the order.
5. From `Ready`, select the release action after pickup.

The current Garment screen advances the unfinished service items together. The database records a status for every service, and the parent order becomes Ready only when all non-cancelled service items are completed.

### 4.8 Correct an incorrect status

1. Select the backward or correction button beside the order.
2. Enter a clear correction reason.
3. Confirm the correction.

The parent order and affected service items return to the earlier stage. The correction and reason are recorded in the activity history. A backward correction does not deduct or return inventory.

### 4.9 Record another payment

1. Find an order with an unpaid balance.
2. Select **Record additional payment**.
3. Choose the payment method and enter the amount.
4. Confirm the payment.

The new payment becomes a separate auditable entry. It does not replace the initial payment, and it cannot exceed the remaining balance.

When releasing a Ready order with a remaining balance, the system asks for the exact outstanding amount before release.

### 4.10 Cancel an order

1. Select the cancel action on an active order.
2. Enter the required cancellation reason.
3. Select **Cancel Order & Restore Stock**.

The order and its service items become Cancelled. Automatic deductions and add-on stock are returned exactly once. Payment records remain for accountability; any refund must be handled separately. Released orders cannot be cancelled.

---

## 5. Inventory

### 5.1 Read the inventory table

- **Stock** is the current branch quantity and unit.
- **Min Level** is the threshold used for low-stock warnings.
- **Status** becomes Low when current stock is at or below the minimum.
- **Forecast** estimates days remaining from recorded usage when sufficient data is available.

### 5.2 Add an inventory item

1. Open **Inventory** and select **Add Item**.
2. Enter the item name, unit, starting stock, and minimum stock level.
3. Administrators also select the assigned branch.
4. Save the item.

### 5.3 Restock an item

1. Select the restock action beside the item.
2. Enter the quantity to add.
3. Optionally enter the total cost and supplier.
4. Select **Restock**.

Use the Restock action to increase existing stock. Order creation deducts stock automatically, and order cancellation restores it automatically.

Archiving an inventory item removes it from active stock checks and new orders. An administrator can restore it from the Audit Log.

---

## 6. Administrator workflow

### 6.1 Configure services and prices

1. Open **Services**.
2. Select **Add service**, or edit an existing service.
3. Enter the service name and optional description.
4. Set the kilograms included per load, price per load, and excess price per kilogram.
5. Choose **Full laundry service** or **Air-drying only**.
6. Keep **Available for new orders** selected when the service should appear in the order form.
7. Save the service.

Archived or inactive services cannot be selected for new orders. Existing orders retain their saved service names and prices.

### 6.2 Configure automatic deductions and add-ons

1. On **Services**, go to **Branch inventory checklist**.
2. Select the branch and service.
3. For an item consumed automatically, select **Deduct automatically** and enter the quantity used per load.
4. For an optional customer add-on, select **Offer as add-on** and enter its selling price per unit.
5. Select **Save inventory checklist**.

Configuration is specific to the selected branch and service. An order cannot consume another branch’s stock. If combined requirements exceed available stock, the whole order is rejected without partial deductions.

### 6.3 Review Analytics

1. Open **Analytics**.
2. Select a branch or **All Branches**.
3. Choose Weekly, Monthly, or Yearly, or enter a custom date range.
4. Review Cash Received, Expenses, Net Profit, Total Orders, service demand, branch performance, staff productivity, repeat customers, and turnaround time.
5. Review the revenue forecast and AI-assisted decision-support recommendations.
6. Use **Regenerate AI outputs** when a fresh analysis is required.
7. Use **Export CSV** or **Print / PDF** for reporting.

Important interpretation:

- **Cash Received** is based on payment entries on their payment dates.
- **Total Orders** and branch order counts are based on unique orders, so an order is not counted twice merely because it has multiple payments.
- Service demand counts service requests; one multi-service order can therefore contribute to several services.
- Forecasts and AI recommendations support—not replace—managerial judgment.

### 6.4 Send notifications

Open **Notifications** to:

- compose an email using a recipient, subject, and message; or
- use **Quick Notify** to send a prepared order-related message to an eligible customer.

Confirm the customer’s email address before sending. A successful message appears in the notification history/status area.

### 6.5 Manage staff accounts

1. Open **Staff** and select **Add Account**.
2. Enter the employee name, phone, contact email, and position.
3. For staff, select the assigned branch.
4. Select the Staff or Administrator role.
5. Create the account.
6. Copy the generated Account ID, username, and temporary password immediately; the temporary password is shown once.
7. Give the credentials to the account holder securely.

Administrators are global users and should be created only for trusted owners or managers. The credential-reset action invalidates the previous password and generates another temporary password.

### 6.6 Use the Audit Log

The Audit Log contains:

- **Archived records**, which can be restored; and
- **Activity history**, showing important actions, actor, branch, and time.

Customers, staff, inventory items, services, and other supported archived records can be restored. Orders and payments remain permanent for accountability.

### 6.7 Configure system settings

In **Settings**, an administrator can:

- change the bound email or password using email verification;
- enable dark mode and action notifications;
- set the fallback processing time;
- set the staff undo window;
- set the ETA safety buffer;
- set the minimum historical sample required for ETA calculations; and
- enable and configure loyalty milestones, discount percentage, free-load milestone, and reward expiry.

Loyalty qualification is based on fully paid, released orders across branches. Eligible rewards are applied automatically during checkout.

---

## 7. Customer order tracking

Customers do not need a dashboard account to check an order.

1. Open the public I&C Laundry website.
2. Go to **Track Your Garment**.
3. Enter the complete order number.
4. Select **Track**.

The page displays the service summary, weight, order stage, date placed, and estimated-ready time when applicable.

## 8. Daily closing checks

Before ending a shift:

1. Confirm all physically received orders exist in Garment.
2. Confirm service selections and weights are correct.
3. Confirm all received payments appear against the correct order.
4. Confirm completed orders have the correct status.
5. Review Ready orders awaiting pickup.
6. Review low-stock warnings and record completed restocks.
7. Report failed submissions, incorrect balances, or unexpected stock differences to an administrator.
8. Sign out.

## 9. Common problems

| Problem | What to check |
|---|---|
| Cannot create an order | Required customer fields, valid email/mobile number, at least one service, positive weights, 50% payment, and sufficient stock |
| Service or add-on is missing | It may be inactive, archived, assigned to another branch, or not configured for that service |
| Order cannot be released | The order must be Ready and fully paid |
| Order cannot be cancelled | Released and already-cancelled orders are locked |
| Stock is incorrect | Check service quantities per load, selected add-ons, cancellation history, and restock entries |
| ETA looks unusual | Check default ETA settings, safety buffer, service weight, and available historical data |
| Staff cannot see a record | Confirm the staff member’s assigned branch and the record’s branch |
| Verification code is not received | Confirm the bound contact email, check spam, wait for the cooldown, then request another code |

## 10. Status reference

| Order status | Meaning |
|---|---|
| Received | Order has been accepted but processing has not started |
| On Process | At least one service is being processed |
| Ready for Pick-Up | All non-cancelled service items are completed |
| Released | Fully paid order has been handed to the customer |
| Cancelled | Order was cancelled with a reason; deducted stock was restored |

| Payment status | Meaning |
|---|---|
| Partial | Some payment was recorded, but a balance remains |
| Paid | Recorded payments cover the final order total |

---

**Document owner:** I&C Laundry  
**Recommended use:** Staff orientation, administrator training, and UAT reference
