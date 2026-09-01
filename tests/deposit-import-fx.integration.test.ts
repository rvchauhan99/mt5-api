import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { bootstrapData } from "../src/shared/db/bootstrap";
import { UserModel } from "../src/modules/users/user.model";
import { BankModel } from "../src/modules/bank/bank.model";
import { ExchangeModel } from "../src/modules/exchange/exchange.model";
import { PlayerModel } from "../src/modules/player/player.model";
import { PlatformSettingsModel, PLATFORM_SETTINGS_KEY } from "../src/modules/settings/settings.model";
import { ExchangeRateModel } from "../src/modules/masters/exchange-rate.model";
import {
  DEPOSIT_IMPORT_CSV_HEADER_LIST,
  applyDepositImportRows,
  validateDepositImportRows,
  type DepositImportCommitRow,
} from "../src/modules/deposit/deposit.service";
import { DepositModel } from "../src/modules/deposit/deposit.model";

const HEADER = DEPOSIT_IMPORT_CSV_HEADER_LIST.join(",");

function csvRow(values: string[]): string {
  return values.map((v) => (v.includes(",") ? `"${v}"` : v)).join(",");
}

async function ensurePlatformCurrency(actorId: string, currency: "INR" | "USD" = "INR") {
  await PlatformSettingsModel.findOneAndUpdate(
    { key: PLATFORM_SETTINGS_KEY },
    {
      $set: {
        platformCurrency: currency,
        currencyLockedAt: new Date(),
        currencyLockedBy: new mongoose.Types.ObjectId(actorId),
      },
    },
    { upsert: true },
  );
}

describe("deposit import FX", () => {
  let mongo: MongoMemoryServer;
  let actorId = "";
  let bankId = "";
  let playerMongoId = "";

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    await mongoose.connect(mongo.getUri());
    await bootstrapData();

    const actor = await UserModel.findOne({ username: "superadmin" }).select("_id").lean();
    actorId = String(actor!._id);
    await ensurePlatformCurrency(actorId, "INR");

    const bank = await BankModel.create({
      holderName: "Import FX Bank",
      bankName: "FX Bank",
      accountNumber: "777777777701",
      ifsc: "FXBK0000777",
      openingBalance: 100_000,
      currentBalance: 100_000,
      status: "active",
      createdBy: actorId,
    });
    bankId = String(bank._id);

    const exchange = await ExchangeModel.create({
      name: "FX Exchange",
      provider: "test",
      openingBalance: 0,
      currentBalance: 0,
      status: "active",
      createdBy: actorId,
      updatedBy: actorId,
    });
    const player = await PlayerModel.create({
      exchange: exchange._id,
      playerId: "FX-PLAYER-001",
      phone: "9000000001",
      userType: "trader",
      createdBy: actorId,
      updatedBy: actorId,
    });
    playerMongoId = String(player._id);

    await ExchangeRateModel.create({
      fromCurrency: "USD",
      toCurrency: "INR",
      rate: 83,
      isActive: true,
      createdBy: actorId,
      updatedBy: actorId,
    });
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongo.stop();
  });

  beforeEach(async () => {
    await DepositModel.deleteMany({});
  });

  function commitRow(overrides: Partial<DepositImportCommitRow> = {}): DepositImportCommitRow {
    const amount = overrides.amount ?? 1000;
    const operatedAmount = overrides.operatedAmount ?? amount;
    return {
      utr: `FX-UTR-${Math.random().toString(36).slice(2, 10)}`,
      amount,
      operatedCurrency: "INR",
      operatedAmount,
      exchangeRate: 1,
      settlementAccountType: "bank",
      bankId,
      playerMongoId,
      bonusAmount: 0,
      totalAmount: amount,
      ...overrides,
    };
  }

  it("imports platform currency rows with exchangeRate 1", async () => {
    const csv = [
      HEADER,
      csvRow(["", "Bank", "777777777701", "", "FX-REF-001", "", "5000", "FX-PLAYER-001"]),
    ].join("\n");

    const result = await validateDepositImportRows(Buffer.from(csv, "utf-8"), "import.csv");
    expect(result.summary.valid).toBe(1);
    expect(result.validRows[0]?.operatedCurrency).toBe("INR");
    expect(result.validRows[0]?.exchangeRate).toBe(1);
    expect(result.validRows[0]?.amount).toBe(5000);
    expect(result.validRows[0]?.bonusAmount).toBe(0);
    expect(result.validRows[0]?.totalAmount).toBe(5000);

    const commit = await applyDepositImportRows(
      [
        {
          utr: result.validRows[0]!.utr,
          amount: result.validRows[0]!.amount,
          operatedCurrency: result.validRows[0]!.operatedCurrency,
          operatedAmount: result.validRows[0]!.operatedAmount,
          exchangeRate: result.validRows[0]!.exchangeRate,
          settlementAccountType: "bank",
          bankId,
          playerMongoId,
          bonusAmount: 100,
          totalAmount: 5100,
        },
      ],
      actorId,
    );
    expect(commit.created).toBe(1);

    const doc = await DepositModel.findOne({ utr: "FX-REF-001" }).lean();
    expect(doc?.operatedCurrency).toBe("INR");
    expect(doc?.exchangeRate).toBe(1);
    expect(doc?.operatedAmount).toBe(5000);
    expect(doc?.amount).toBe(5000);
    expect(doc?.bonusAmount).toBe(0);
    expect(doc?.totalAmount).toBe(5000);
  });

  it("ignores legacy Bonus Amount column and stores bonus as 0", async () => {
    const legacyHeader = `${HEADER},Bonus Amount`;
    const csv = [
      legacyHeader,
      csvRow(["", "Bank", "777777777701", "", "FX-LEGACY-BONUS-001", "", "2500", "FX-PLAYER-001", "100"]),
    ].join("\n");

    const result = await validateDepositImportRows(Buffer.from(csv, "utf-8"), "import.csv");
    expect(result.summary.valid).toBe(1);
    expect(result.validRows[0]?.bonusAmount).toBe(0);
    expect(result.validRows[0]?.totalAmount).toBe(2500);
  });

  it("converts foreign currency using master exchange rate", async () => {
    const csv = [
      HEADER,
      csvRow(["", "Bank", "777777777701", "", "FX-REF-USD-001", "USD", "100", "FX-PLAYER-001"]),
    ].join("\n");

    const result = await validateDepositImportRows(Buffer.from(csv, "utf-8"), "import.csv");
    expect(result.summary.valid).toBe(1);
    expect(result.validRows[0]?.operatedCurrency).toBe("USD");
    expect(result.validRows[0]?.operatedAmount).toBe(100);
    expect(result.validRows[0]?.exchangeRate).toBe(83);
    expect(result.validRows[0]?.amount).toBe(8300);
  });

  it("accepts case-insensitive operated currency values", async () => {
    const csv = [
      HEADER,
      csvRow(["", "Bank", "777777777701", "", "FX-REF-USD-002", "usd", "50", "FX-PLAYER-001"]),
    ].join("\n");

    const result = await validateDepositImportRows(Buffer.from(csv, "utf-8"), "import.csv");
    expect(result.summary.valid).toBe(1);
    expect(result.validRows[0]?.operatedCurrency).toBe("USD");
    expect(result.validRows[0]?.amount).toBe(4150);
  });

  it("accepts legacy UTR and Date Time headers", async () => {
    const legacyHeader =
      "Date Time,Settlement Type,Bank,Liable Person Name,UTR,Operated currency,Amount,Trader Wallet Id";
    const csv = [
      legacyHeader,
      csvRow(["", "Bank", "777777777701", "", "FX-LEGACY-001", "", "2500", "FX-PLAYER-001"]),
    ].join("\n");

    const result = await validateDepositImportRows(Buffer.from(csv, "utf-8"), "import.csv");
    expect(result.summary.valid).toBe(1);
    expect(result.validRows[0]?.utr).toBe("FX-LEGACY-001");
  });

  it("fails when master exchange rate is missing", async () => {
    const csv = [
      HEADER,
      csvRow(["", "Bank", "777777777701", "", "FX-REF-EUR-001", "EUR", "100", "FX-PLAYER-001"]),
    ].join("\n");

    const result = await validateDepositImportRows(Buffer.from(csv, "utf-8"), "import.csv");
    expect(result.summary.valid).toBe(0);
    expect(result.invalidRows[0]?.errors.join(" ")).toMatch(/No master exchange rate/i);
  });

  it("persists FX snapshot on bulk commit and forces bonus to 0", async () => {
    const row = commitRow({
      utr: "FX-BULK-001",
      amount: 8300,
      operatedCurrency: "USD",
      operatedAmount: 100,
      exchangeRate: 83,
      bonusAmount: 50,
      totalAmount: 8350,
    });
    const result = await applyDepositImportRows([row], actorId);
    expect(result.created).toBe(1);

    const doc = await DepositModel.findOne({ utr: "FX-BULK-001" }).lean();
    expect(doc?.operatedCurrency).toBe("USD");
    expect(doc?.operatedAmount).toBe(100);
    expect(doc?.exchangeRate).toBe(83);
    expect(doc?.amount).toBe(8300);
    expect(doc?.bonusAmount).toBe(0);
    expect(doc?.totalAmount).toBe(8300);
  });

  it("validates 200 mixed-currency rows efficiently", async () => {
    const lines = [HEADER];
    for (let i = 1; i <= 200; i += 1) {
      const isForeign = i > 100;
      lines.push(
        csvRow([
          "",
          "Bank",
          "777777777701",
          "",
          `FX-200-${String(i).padStart(4, "0")}`,
          isForeign ? "USD" : "",
          isForeign ? "50" : String(1000 + i),
          "FX-PLAYER-001",
        ]),
      );
    }

    const started = Date.now();
    const result = await validateDepositImportRows(Buffer.from(lines.join("\n"), "utf-8"), "import-200.csv");
    const elapsed = Date.now() - started;

    expect(result.summary.valid).toBe(200);
    expect(result.summary.invalid).toBe(0);
    expect(elapsed).toBeLessThan(30_000);
    expect(result.validRows.some((row) => row.operatedCurrency === "USD" && row.exchangeRate === 83)).toBe(true);
    expect(result.validRows.some((row) => row.operatedCurrency === "INR" && row.exchangeRate === 1)).toBe(true);
  });
});
