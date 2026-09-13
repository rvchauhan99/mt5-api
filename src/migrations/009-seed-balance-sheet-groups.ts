import type { Db } from "mongodb";
import { logger } from "../shared/logger";

const GROUPS_COLLECTION = "balancesheetgroups";

const GROUP_DEFS: Array<{
  code: string;
  name: string;
  parentCode: string | null;
  side: "asset" | "liability";
  level: number;
  sortOrder: number;
}> = [
  { code: "fixed_assets", name: "Fixed Assets", parentCode: null, side: "asset", level: 0, sortOrder: 10 },
  { code: "current_assets", name: "Current Assets", parentCode: null, side: "asset", level: 0, sortOrder: 20 },
  { code: "bank_accounts", name: "Bank Accounts", parentCode: "current_assets", side: "asset", level: 1, sortOrder: 21 },
  { code: "cash_in_hand", name: "Cash in Hand", parentCode: "current_assets", side: "asset", level: 1, sortOrder: 22 },
  { code: "receivables", name: "Receivables", parentCode: "current_assets", side: "asset", level: 1, sortOrder: 23 },
  { code: "exchange_float", name: "Exchange Float", parentCode: "current_assets", side: "asset", level: 1, sortOrder: 24 },
  { code: "capital_reserves", name: "Capital & Reserves", parentCode: null, side: "liability", level: 0, sortOrder: 10 },
  { code: "exchange_capital", name: "Exchange Capital", parentCode: "capital_reserves", side: "liability", level: 1, sortOrder: 11 },
  { code: "retained_earnings", name: "Retained Earnings", parentCode: "capital_reserves", side: "liability", level: 1, sortOrder: 12 },
  { code: "current_liabilities", name: "Current Liabilities", parentCode: null, side: "liability", level: 0, sortOrder: 20 },
  { code: "bank_overdrafts", name: "Bank Overdrafts", parentCode: "current_liabilities", side: "liability", level: 1, sortOrder: 21 },
  { code: "payables", name: "Payables", parentCode: "current_liabilities", side: "liability", level: 1, sortOrder: 22 },
  { code: "pending_withdrawals", name: "Pending Withdrawals", parentCode: "current_liabilities", side: "liability", level: 1, sortOrder: 23 },
  { code: "expenses_payable", name: "Expenses Payable", parentCode: "current_liabilities", side: "liability", level: 1, sortOrder: 24 },
  { code: "ib_commissions", name: "IB Commissions", parentCode: "current_liabilities", side: "liability", level: 1, sortOrder: 25 },
];

export const migration009SeedBalanceSheetGroups = {
  id: "009_seed_balance_sheet_groups" as const,

  async up(db: Db): Promise<void> {
    const groups = db.collection(GROUPS_COLLECTION);
    await groups.createIndex({ code: 1 }, { unique: true });
    await groups.createIndex({ parentGroupId: 1, sortOrder: 1 });
    await groups.createIndex({ side: 1, level: 1, sortOrder: 1 });

    const now = new Date();
    let upserted = 0;

    for (const def of GROUP_DEFS) {
      const result = await groups.updateOne(
        { code: def.code },
        {
          $set: {
            name: def.name,
            parentCode: def.parentCode,
            side: def.side,
            level: def.level,
            sortOrder: def.sortOrder,
            isSystem: true,
            isActive: true,
            updatedAt: now,
          },
          $setOnInsert: {
            code: def.code,
            parentGroupId: null,
            createdAt: now,
          },
        },
        { upsert: true },
      );
      if (result.upsertedCount > 0) upserted += 1;
    }

    const all = await groups.find({}).toArray();
    const byCode = new Map(all.map((g) => [String(g.code), g]));
    for (const def of GROUP_DEFS) {
      const parent = def.parentCode ? byCode.get(def.parentCode) : null;
      await groups.updateOne(
        { code: def.code },
        { $set: { parentGroupId: parent?._id ?? null, updatedAt: now } },
      );
    }

    logger.info(
      {
        migrationId: migration009SeedBalanceSheetGroups.id,
        totalGroups: GROUP_DEFS.length,
        newlyInserted: upserted,
      },
      "balance sheet groups seed summary",
    );
  },
};
