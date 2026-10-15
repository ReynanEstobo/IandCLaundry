# System testing guide

## Run the local automated system check

From the project root, use PowerShell's `.cmd` shim if script execution policy
blocks `npm.ps1`:

```powershell
npm.cmd run test:system
```

The command runs three checks in sequence:

1. `npm test` runs the automated Node test suite.
2. `npm run build` verifies the frontend production build.
3. `npx wrangler deploy --dry-run` checks Worker packaging without deploying.

The automated tests exercise representative behavior across authentication and
sessions, role and branch authorization, customers, orders and payments,
inventory and service/add-on configuration, analytics and exports, forecasts,
notifications, public pages, and request security. Database-dependent cases
use test databases or mocks; this command does not mutate the live Supabase
project or send real messages.

All three checks must finish successfully for the local smoke check to pass.
Fix failures and rerun the command. A successful run is not proof of 100%
coverage or correctness: it does not deploy the app or fully exercise the live
browser, production database, Cloudflare environment, email/SMS providers, or
every role/branch and failure combination.

## Run browser UAT in staging

Use a dedicated Supabase staging project and follow
[`manual-uat-checklist.md`](manual-uat-checklist.md). Cover public visitor,
administrator, and staff workflows, including one staff account per branch.
Use disposable UAT records, test inboxes, and test phone numbers. Do not run
mutating tests against production data.

Record the build/commit, environment, tester, account/role/branch, test case,
expected result, actual result, status, and evidence. Leave results unclaimed
until each test has actually been executed. Stage destructive, rate-limit,
OTP-expiry, and brute-force scenarios only in staging.

## Before release

- Automated system check passes.
- Browser UAT applicable cases pass with evidence.
- Any failures have a corrective action and a passing retest.
- Database migrations and required secrets are verified in staging.
- A production smoke check is performed after deployment without using
  destructive test data.
