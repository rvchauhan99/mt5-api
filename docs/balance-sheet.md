# Balance Sheet Module

Tally-style hierarchical Balance Sheet for MT5 CRM.

## Permissions

| Permission | Key | Purpose |
|---|---|---|
| View | `reports.balance_sheet` | Load sheet, summary, groups, drilldown, Excel export |
| Admin | `reports.balance_sheet_admin` | Create period-end snapshots |

Superadmin receives both automatically via bootstrap (`Object.values(PERMISSIONS)`).

## API

Base path: `/api/reports/balance-sheet` (auth required).

| Method | Path | Permission | Description |
|---|---|---|---|
| GET | `/` | `reports.balance_sheet` | Full hierarchical sheet |
| GET | `/summary` | `reports.balance_sheet` | Totals only |
| GET | `/export` | `reports.balance_sheet` | Multi-sheet Excel |
| GET | `/groups` | `reports.balance_sheet` | Group hierarchy |
| GET | `/drilldown` | `reports.balance_sheet` | Ledger movements |
| POST | `/snapshot` | `reports.balance_sheet_admin` | Persist snapshot |

### Query parameters (GET `/`)

- `fromDate`, `toDate` — required `YYYY-MM-DD`
- `exchangeId` — optional 24-char ObjectId
- `showZeroBalances` — `true`/`false` (default false)
- `compare` — `none` | `prior_period` | `yoy` | `qoq`
- `groupId` / `groupCode` — optional drill into one group
- `currency` — display hint (platform amounts are stored in base currency)

### Response shape

```json
{
  "success": true,
  "data": {
    "meta": { "isBalanced": true, "difference": 0, "fromDate": "...", "toDate": "..." },
    "totals": { "totalAssets": 0, "totalLiabilities": 0, "totalEquity": 0, "grossPL": 0, "netPL": 0 },
    "assets": [ /* group tree */ ],
    "liabilities": [ /* group tree */ ],
    "equity": [ /* capital & reserves tree */ ]
  }
}
```

## Group hierarchy (seeded)

Migration `009_seed_balance_sheet_groups` inserts:

**Assets:** Fixed Assets, Current Assets → Bank Accounts, Cash in Hand, Receivables, Exchange Float

**Liabilities:** Current Liabilities → Bank Overdrafts, Payables, Pending Withdrawals, Expenses Payable, IB Commissions

**Equity:** Capital & Reserves → Exchange Capital, Retained Earnings (period net P&L)

Groups auto-seed on first API call if the collection is empty (`ensureDefaultGroups`).

## Calculation notes

- **Banks:** Same statement logic as dashboard / bank closing (deposits +, withdrawals −, expenses −, transfers, settlements, settled IB).
- **Persons:** Positive closing → Receivables (asset); negative → Payables (liability).
- **Exchange float:** Period opening/closing from deposits, withdrawals, topups.
- **Retained earnings:** Period net P&L = verified deposits − approved withdrawals − approved expenses − IB accruals.
- Sheet may show a small **difference** when operational sources are not full double-entry; `isBalanced` is true when `|difference| ≤ 0.01`.

## Frontend

- Route: `/reports/balance-sheet`
- Nav: Reports → Balance Sheet
- Components under `mt5-web/src/modules/reports/components/`

## Ops

After deploy, ensure migrations run (app boot or `run-migrations-once`). Existing admins get new permission keys on next bootstrap/superadmin sync; grant `reports.balance_sheet` to sub-admins via Sub Admin permission grid.
