/**
 * Lightweight smoke checklist for Balance Sheet critical flows.
 * Run manually after API + web are up (or wire into Playwright later).
 *
 * Prerequisites:
 * - Superadmin (or user with reports.balance_sheet) logged in
 * - Seeded banks / deposits / withdrawals for the selected month
 *
 * Checklist:
 * 1. Navigate to /reports/balance-sheet — page loads without error toast
 * 2. Default "This Month" range shows Assets / Liabilities / Equity trees
 * 3. KPI strip shows Total Assets, Total Liabilities, Equity, balanced badge
 * 4. Expand Current Assets → Bank Accounts → click a bank ledger → drilldown opens
 * 5. Change Compare to "Prior period" → Delta columns appear
 * 6. Export → Excel downloads balance-sheet-*.xlsx
 * 7. Export → Print / PDF opens print dialog with print container visible
 * 8. User without reports.balance_sheet cannot open route (redirect / denied)
 * 9. Snapshot POST /reports/balance-sheet/snapshot requires reports.balance_sheet_admin
 */
describe("balance sheet e2e checklist", () => {
  it("documents critical user flows", () => {
    expect(true).toBe(true);
  });
});
