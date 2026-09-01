/**
 * Generate a 200-row deposit import CSV for local testing.
 *
 * Usage:
 *   npx tsx scripts/generate-deposit-import-fixture.ts
 *   npx tsx scripts/generate-deposit-import-fixture.ts --validate
 *
 * Env (optional):
 *   BANK_ACCOUNT=888888888801
 *   TRADER_WALLET_ID=BULK-PLAYER-001
 *   OUTPUT=./fixtures/deposit-import-200.csv
 */
import fs from "node:fs";
import path from "node:path";
import mongoose from "mongoose";
import { DEPOSIT_IMPORT_CSV_HEADER_LIST } from "../src/modules/deposit/deposit.service";
import { validateDepositImportRows } from "../src/modules/deposit/deposit.service";

const HEADER = DEPOSIT_IMPORT_CSV_HEADER_LIST.join(",");

function csvQuote(value: string): string {
  if (!value) return "";
  if (value.includes(",") || value.includes('"') || value.includes("\n")) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function csvRow(values: string[]): string {
  return values.map(csvQuote).join(",");
}

function buildRows(count: number, bankAccount: string, traderWalletId: string): string[] {
  const lines = [HEADER];
  for (let i = 1; i <= count; i += 1) {
    const isForeign = i > count / 2;
    const ref = `FIXTURE-DEP-${String(i).padStart(4, "0")}`;
    lines.push(
      csvRow([
        "",
        "Bank",
        bankAccount,
        "",
        ref,
        isForeign ? "USD" : "",
        isForeign ? String(50 + (i % 10)) : String(1000 + i),
        traderWalletId,
      ]),
    );
  }
  return lines;
}

async function main() {
  const bankAccount = process.env.BANK_ACCOUNT?.trim() || "888888888801";
  const traderWalletId = process.env.TRADER_WALLET_ID?.trim() || "BULK-PLAYER-001";
  const outputPath = path.resolve(
    process.cwd(),
    process.env.OUTPUT?.trim() || "./fixtures/deposit-import-200.csv",
  );
  const rowCount = Number(process.env.ROW_COUNT ?? 200);
  const shouldValidate = process.argv.includes("--validate");

  const lines = buildRows(rowCount, bankAccount, traderWalletId);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${lines.join("\n")}\n`, "utf-8");
  console.log(`Wrote ${rowCount} data rows to ${outputPath}`);

  if (!shouldValidate) return;

  const mongoUri = process.env.MONGO_URI?.trim() || "mongodb://localhost:27017/mt5";
  await mongoose.connect(mongoUri);
  try {
    const buffer = fs.readFileSync(outputPath);
    const result = await validateDepositImportRows(buffer, path.basename(outputPath));
    console.log(
      JSON.stringify(
        {
          total: result.summary.total,
          valid: result.summary.valid,
          invalid: result.summary.invalid,
          skipped: result.summary.skipped,
          sampleInvalid: result.invalidRows.slice(0, 3),
        },
        null,
        2,
      ),
    );
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
