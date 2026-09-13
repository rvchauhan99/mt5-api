# Implementation Plan

[Overview]
Full frontend-only UI/UX redesign of the Balance Sheet view (`/reports/balance-sheet` in `mt5-web`), adding a visual overview with composition charts, a compact collapsible filter bar with a proper date-range picker, skeleton loaders, a polished tree with proportion bars, and an upgraded drilldown drawer.

The current page (`mt5-web/src/modules/reports/components/BalanceSheetClient.tsx` + siblings) is functional but utilitarian: a tall always-open filter card with native `<input type="date">` and `<select>` elements, a plain 3-card KPI strip, dense text-only trees, a bare "Loading balance sheet…" text placeholder, and a minimal drilldown panel. The redesign keeps every existing capability (URL-synced filters via `useListingQueryStateReference`, compare modes, movement columns, compact density, summary-only, snapshot, Excel/print export, movements tabs) and all API contracts unchanged — no `mt5-api` changes are required. All enhancements reuse libraries already in `mt5-web/package.json`: `recharts` (used by dashboard), `react-day-picker` via the existing `shadcn/calendar.jsx`, `@radix-ui` popover, `@tabler/icons-react`, Tailwind v4, and existing hooks (`useFormatMoney`, `useExport`, `useListingQueryStateReference`).

High-level approach: introduce three new presentational components (overview charts, skeleton, date-range picker), rewrite the filters into a compact single-row bar with an "Advanced" collapsible section, restyle the KPI strip (4 cards + composition ratio bar + balanced status), enrich the tree rows (percent-of-section bars, zebra striping, totals footer, delta chips), and upgrade the drilldown into a polished drawer with summary stat chips and direction badges. `BalanceSheetClient.tsx` is updated to orchestrate these (new `showCharts` URL filter key, skeleton during load, charts section above the trees).

[Types]
Extend the existing filter value interface and add small presentational prop types; no API/type contract changes.

1. `mt5-web/src/modules/reports/components/BalanceSheetFilters.tsx`
   - Extend `BalanceSheetFilterValues` with one new field:
     ```ts
     export interface BalanceSheetFilterValues {
       // ...existing fields unchanged...
       showCharts: boolean; // NEW — toggles overview charts section (default true)
     }
     ```
2. `mt5-web/src/modules/reports/components/BalanceSheetOverviewCharts.tsx` (new)
   ```ts
   interface BalanceSheetOverviewChartsProps {
     assets: BalanceSheetGroupNode[];
     liabilities: BalanceSheetGroupNode[];
     equity: BalanceSheetGroupNode[];
     totals: BalanceSheetTotals;
   }
   interface CompositionSlice { name: string; value: number; fill: string; }
   ```
3. `mt5-web/src/modules/reports/components/BalanceSheetSkeleton.tsx` (new)
   ```ts
   interface BalanceSheetSkeletonProps { showCharts?: boolean; }
   ```
4. `mt5-web/src/modules/reports/components/BalanceSheetDateRangePicker.tsx` (new)
   ```ts
   interface BalanceSheetDateRangePickerProps {
     fromDate: string; // YYYY-MM-DD
     toDate: string;   // YYYY-MM-DD
     onChange: (range: { fromDate: string; toDate: string }) => void;
   }
   ```
5. `mt5-web/src/modules/reports/components/BalanceSheetTree.tsx`
   - Extend `BalanceSheetTreeProps` with:
     ```ts
     accent?: "emerald" | "rose" | "indigo"; // section tint for header/progress bars (default "emerald")
     ```
   No changes to `mt5-web/src/types/balanceSheet.ts` — all data shapes stay as-is.

[Files]
Three new component files; five existing files modified; nothing deleted.

New files (all under `mt5-web/src/modules/reports/components/`):
1. `BalanceSheetOverviewCharts.tsx` — "Overview" card row rendered above the trees on the Statement tab:
   - Left card: **Assets composition** donut (recharts `PieChart`) — slices = leaf asset groups with non-zero totals (e.g., Bank Accounts, Cash in Hand, Receivables, Exchange Float, Fixed Assets); custom tooltip matching `DashboardPLDonut` style; center label = Total Assets.
   - Middle card: **Liabilities & Equity composition** donut — slices = leaf liability groups + equity groups.
   - Right card: **Balance equation bar** — horizontal stacked `BarChart` (2 rows: "Assets" vs "Liabilities + Equity") visualizing the accounting equation, plus Gross/Net P&L stat lines beneath.
   - Empty-value slices filtered out; graceful "No data to chart" fallback per card. Chart palette: emerald scale for assets, rose scale for liabilities, indigo/slate for equity (fixed arrays, cycled).
2. `BalanceSheetSkeleton.tsx` — full-page pulse skeleton mirroring final layout: 4 KPI card blocks, status bar block, optional 3 chart card blocks (`showCharts`), and two tree card blocks with 8 shimmering rows each. Uses `animate-pulse` + `bg-slate-100/200` divs (same pattern as `DashboardPLDonut` loading state).
3. `BalanceSheetDateRangePicker.tsx` — popover range picker:
   - Trigger: bordered button showing `DD MMM YYYY → DD MMM YYYY` with `IconCalendar`.
   - Content: `Popover`/`PopoverContent` from `@/components/ui/shadcn/popover` wrapping `Calendar` from `@/components/ui/shadcn/calendar` in `mode="range"` with `numberOfMonths={2}`; internal `DateRange` state seeded from props; "Apply"/"Cancel" footer inside popover; converts via local `toLocalYmd`.
   - Closes on apply; only fires `onChange` with a complete range.

Modified files:
1. `mt5-web/src/modules/reports/components/BalanceSheetFilters.tsx` — rewrite into compact collapsible bar (see [Functions]).
2. `mt5-web/src/modules/reports/components/BalanceSheetKpiStrip.tsx` — 4-card layout + composition ratio bar (see [Functions]).
3. `mt5-web/src/modules/reports/components/BalanceSheetTree.tsx` — proportion bars, zebra rows, totals footer, accent tints, delta chips.
4. `mt5-web/src/modules/reports/components/BalanceSheetDrilldown.tsx` — polished drawer header, stat chips, direction/status badges, animation.
5. `mt5-web/src/modules/reports/components/BalanceSheetClient.tsx` — wire new components, `showCharts` filter key, skeleton usage.

Unchanged: `BalanceSheetMovementsTab.tsx`, `reportService.ts`, `types/balanceSheet.ts`, all of `mt5-api`. Optional 1-line change: swap the Suspense fallback in `mt5-web/src/app/(app)/reports/balance-sheet/page.tsx` to `BalanceSheetSkeleton`.

