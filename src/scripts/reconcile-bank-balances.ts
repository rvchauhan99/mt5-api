import "dotenv/config";
import mongoose, { Types } from "mongoose";
import { connectDb } from "../shared/db/connect";
import { logger } from "../shared/logger";
import { BankModel } from "../modules/bank/bank.model";
import { computeClosingBalanceActualByBankIds } from "../modules/bank/bankClosingBalance";

type ReconcileRow = {
  bankId: string;
  accountNumber: string;
  bankName: string;
  holderName: string;
  previousCurrentBalance: number;
  closingBalanceActual: number;
  delta: number;
  changed: boolean;
};

function parseArgs() {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const onlyChanged = args.includes("--only-changed");
  return { apply, onlyChanged };
}

async function main() {
  const { apply, onlyChanged } = parseArgs();
  await connectDb();

  const banks = await BankModel.find({})
    .select({ _id: 1, accountNumber: 1, bankName: 1, holderName: 1, openingBalance: 1, currentBalance: 1 })
    .lean();
  const bankIds = banks.map((bank) => new Types.ObjectId(String(bank._id)));
  const closingByBankId = await computeClosingBalanceActualByBankIds(bankIds);

  const report: ReconcileRow[] = banks.map((bank) => {
    const bankId = String(bank._id);
    const previousCurrentBalance = Number(bank.currentBalance ?? bank.openingBalance ?? 0);
    const closingBalanceActual = Number(closingByBankId.get(bankId) ?? bank.openingBalance ?? 0);
    const delta = closingBalanceActual - previousCurrentBalance;
    return {
      bankId,
      accountNumber: bank.accountNumber,
      bankName: bank.bankName,
      holderName: bank.holderName,
      previousCurrentBalance,
      closingBalanceActual,
      delta,
      changed: Math.abs(delta) > 0.000001,
    };
  });

  const rowsToShow = onlyChanged ? report.filter((row) => row.changed) : report;
  logger.info(
    {
      mode: apply ? "apply" : "dry-run",
      totalBanks: report.length,
      changedBanks: report.filter((row) => row.changed).length,
      unchangedBanks: report.filter((row) => !row.changed).length,
    },
    "bank balance reconciliation summary",
  );

  for (const row of rowsToShow) {
    logger.info(
      {
        bankId: row.bankId,
        accountNumber: row.accountNumber,
        bankName: row.bankName,
        holderName: row.holderName,
        previousCurrentBalance: row.previousCurrentBalance,
        closingBalanceActual: row.closingBalanceActual,
        delta: row.delta,
      },
      "bank balance reconciliation row",
    );
  }

  if (apply) {
    const changedRows = report.filter((row) => row.changed);
    for (const row of changedRows) {
      await BankModel.updateOne(
        { _id: new Types.ObjectId(row.bankId) },
        { $set: { currentBalance: row.closingBalanceActual } },
      );
    }
    logger.info({ updatedCount: changedRows.length }, "bank currentBalance sync complete");
  }

  await mongoose.disconnect();
}

main().catch(async (error) => {
  logger.error({ error }, "bank balance reconciliation failed");
  await mongoose.disconnect();
  process.exit(1);
});
