# Multi-Service UAT Checklist

Write **Pass** or **Fail** beside every item after testing it in the actual system.

## Staff POV — Daily garment operations

Perform items 1–30 while signed in as a normal staff member assigned to a test branch.

1. Check if an order can be created with multiple services. It should succeed and create only one order number.  
   Result: __________

2. Check if every selected service appears inside the created order. All selected services should be displayed.  
   Result: __________

3. Check if each service accepts its own weight. The entered weight should be saved under the correct service.  
   Result: __________

4. Check if each service uses its own bundle weight, bundle price, and excess-kilogram price. The displayed total should match the configured prices.  
   Result: __________

5. Check if the prices of all selected services are added only once. The final order total should be correct and should not contain duplicate charges.  
   Result: __________

6. Check if an add-on can be selected for a service. It should appear in the order and its price should be added to the total.  
   Result: __________

7. Check if add-on prices use the Philippine peso sign (`₱`). No dollar sign should appear.  
   Result: __________

8. Check if the system requires the customer's name, Philippine mobile number, and email address. The order should not be created when any required field is missing or invalid.  
   Result: __________

9. Check if an existing customer is found using their phone number. Their correct name and email should be displayed without creating a duplicate customer.  
   Result: __________

10. Check if the system requires at least 50% payment when creating an order. A payment below 50% should be rejected.  
    Result: __________

11. Check if a payment equal to or greater than 50% is accepted. The payment status should be `Partial` or `Paid`, depending on the amount.  
    Result: __________

12. Check if the initial cash payment is recorded in the payment history. It should appear once with the correct amount and `Cash` payment method.  
    Result: __________

13. Check if automatic inventory items are deducted for every service. The deduction should equal the configured quantity per load multiplied by the service's number of loads.  
    Result: __________

14. Check if selected add-ons are deducted from inventory. The deducted quantity should equal the quantity selected in the order.  
    Result: __________

15. Check if the same inventory item is used by multiple services or as both an automatic item and add-on. The system should deduct the correct combined quantity.  
    Result: __________

16. Check if an order is rejected when inventory is insufficient. No order, payment, or partial inventory deduction should be created.  
    Result: __________

17. Check if clicking the Create Order button repeatedly creates duplicates. Only one order should be created, and inventory should be deducted only once.  
    Result: __________

18. Check if a newly created order starts in `Received`. All service items should also start in `Received`.  
    Result: __________

19. Check if an order can move from `Received` to `On Process`. The parent order and its service items should update correctly.  
    Result: __________

20. Check if an order can move from `On Process` to `Ready`. All unfinished service items should become completed before the parent order becomes Ready.  
    Result: __________

21. Check if a staff member can move an order backward and provide a correction reason. The order and its service items should return to the previous stage, and the reason should be recorded.  
    Result: __________

22. Check if an order stage can be moved backward without a correction reason. The system should reject it.  
    Result: __________

23. Check if an additional payment can be recorded. The paid amount and remaining balance should update correctly, and a separate payment entry should be created.  
    Result: __________

24. Check if the system rejects a payment greater than the remaining balance. The order and payment history should remain unchanged.  
    Result: __________

25. Check if a Ready order with an unpaid balance can be released. The system should require collection of the remaining balance first.  
    Result: __________

26. Check if a fully paid Ready order can be released. Its status should become `Released`, and the pickup time should be recorded.  
    Result: __________

27. Check if an active order can be cancelled with a cancellation reason. The parent order and all service items should become `Cancelled`.  
    Result: __________

28. Check if cancelling an order returns its automatic-deduction and add-on inventory. Every deducted quantity should be returned exactly once.  
    Result: __________

29. Check if the same cancelled order can be cancelled again. The system should reject it and should not return inventory a second time.  
    Result: __________

30. Check if a Released order can be cancelled. The system should reject the cancellation.  
    Result: __________

## Admin POV — Configuration, security, and monitoring

Perform items 31–46 while signed in as an administrator. For the staff-permission checks, the administrator should also use test staff accounts from two different branches.

31. Check if cancellation appears in the Audit Log. It should show the order, cancellation reason, staff member, branch, date, and before-and-after information.  
    Result: __________

32. Check if forward and backward stage changes appear in the order history. The correct staff member, statuses, date, and correction reason should be recorded.  
    Result: __________

33. Check if normal staff can see and process only orders from their assigned branch. Orders from another branch should not be visible or editable.  
    Result: __________

34. Check if normal staff can see only inventory items and add-ons from their assigned branch. Another branch's configuration should not be available.  
    Result: __________

35. Check if an administrator can create an order for a selected branch. Inventory should be deducted only from the selected branch.  
    Result: __________

36. Check if inactive or deleted services and inventory items can be selected. They should not appear as available choices.  
    Result: __________

37. Check if the Inventory page shows automatic-deduction item names and units clearly. It should use the term `Item`, not `Recipe`.  
    Result: __________

38. Check if the Inventory page has no Category and Cost/Unit fields. These fields should not appear in the form or table.  
    Result: __________

39. Check if the Dashboard's Today's Revenue uses the Philippine peso sign (`₱`).  
    Result: __________

40. Check if Analytics Cash Received uses the Philippine peso sign (`₱`) and includes initial and additional payments on their payment dates.  
    Result: __________

41. Check if low-stock alerts, restock alerts, suggestions, and alerts use the intended matching colors.  
    Result: __________

42. Check if a percentage loyalty discount works on a multi-service order. The displayed total and saved total should be the same.  
    Result: __________

43. Check if a free-load loyalty reward removes only the first service's bundle price. Other services, excess kilograms, and add-ons should remain payable.  
    Result: __________

44. Check if refreshing the Garment, Inventory, Dashboard, and Analytics pages keeps the saved information correct. No duplicate order, payment, or inventory deduction should appear.  
    Result: __________

45. Check if an administrator can create or edit a service with its own bundle weight, bundle price, excess-kilogram price, and processing type. The values should save correctly and remain correct after refreshing.  
    Result: __________

46. Check if an administrator can configure branch-specific automatic-deduction Items and add-ons for each service. The selected inventory Item, unit, quantity per load, and add-on price should save under the correct branch and service.  
    Result: __________

## Final result

- Total passed: __________
- Total failed: __________
- Tested by: ______________________________
- Date tested: ______________________________
- Overall result: ☐ Accepted ☐ Needs fixes ☐ Rejected
- Notes: ________________________________________________________________
