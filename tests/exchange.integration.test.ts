import request from "supertest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { createApp } from "../src/app";
import { DepositModel } from "../src/modules/deposit/deposit.model";
import { ExchangeTopupModel } from "../src/modules/exchange-topup/exchange-topup.model";
import { ExchangeModel } from "../src/modules/exchange/exchange.model";
import { PlayerModel } from "../src/modules/player/player.model";
import { PlayerImportJobModel } from "../src/modules/player/player-import-job.model";
import { UserModel } from "../src/modules/users/user.model";
import { WithdrawalModel } from "../src/modules/withdrawal/withdrawal.model";
import { bootstrapData } from "../src/shared/db/bootstrap";
import {
  PLAYER_IMPORT_CSV_COLUMNS,
  PLAYER_IMPORT_CSV_HEADER_LIST,
} from "../src/modules/player/player.service";

const PLAYER_IMPORT_CSV_HEADER = PLAYER_IMPORT_CSV_HEADER_LIST.join(",");

describe("Exchange API integration", () => {
  let mongo: MongoMemoryServer;
  const app = createApp();
  let accessToken = "";

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    await mongoose.connect(mongo.getUri());
    await bootstrapData();

    const loginRes = await request(app).post("/api/v1/auth/login").send({
      username: "superadmin",
      password: "SuperAdmin@123",
    });
    accessToken = loginRes.body.data.accessToken;
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongo.stop();
  });

  it("creates exchange successfully", async () => {
    const res = await request(app)
      .post("/api/v1/exchange")
      .set("Authorization", `Bearer ${accessToken}`)
      .send({
        name: "E2E",
        provider: "Provider A",
        openingBalance: 300,
        bonus: 0,
        status: "active",
      });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.name).toBe("E2E");
  });

  it("rejects duplicate exchange", async () => {
    const res = await request(app)
      .post("/api/v1/exchange")
      .set("Authorization", `Bearer ${accessToken}`)
      .send({
        name: "E2E",
        provider: "Provider A",
        openingBalance: 200,
        bonus: 0,
        status: "active",
      });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("business_rule_error");
  });

  it("lists exchanges with pagination", async () => {
    const res = await request(app)
      .get("/api/v1/exchange?page=1&pageSize=10&search=E2E")
      .set("Authorization", `Bearer ${accessToken}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.meta.page).toBe(1);
  });

  it("returns unauthorized without token", async () => {
    const res = await request(app).get("/api/v1/exchange");
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("auth_error");
  });

  it("returns validation error for bad payload", async () => {
    const res = await request(app)
      .post("/api/v1/exchange")
      .set("Authorization", `Bearer ${accessToken}`)
      .send({
        name: "",
        provider: "p",
        openingBalance: -1,
        bonus: -2,
        status: "active",
      });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("validation_error");
  });

  it("returns exchange statement with opposite perspective and net amounts", async () => {
    const actor = await UserModel.findOne({ username: "superadmin" }).select("_id").lean();
    expect(actor?._id).toBeDefined();
    const actorId = actor!._id;

    const exchange = await ExchangeModel.create({
      name: "E2E Statement",
      provider: "Provider S",
      openingBalance: 1000,
      bonus: 0,
      status: "active",
      createdBy: actorId,
      updatedBy: actorId,
    });

    const playerA = await PlayerModel.create({
      exchange: exchange._id,
      playerId: "PL-A",
      phone: "9000000001",
      regularBonusPercentage: 5,
      firstDepositBonusPercentage: 10,
      createdBy: actorId,
      updatedBy: actorId,
    });

    const playerB = await PlayerModel.create({
      exchange: exchange._id,
      playerId: "PL-B",
      phone: "9000000002",
      regularBonusPercentage: 5,
      firstDepositBonusPercentage: 10,
      createdBy: actorId,
      updatedBy: actorId,
    });

    await DepositModel.create({
      bankName: "Bank A",
      utr: "UTR-BEFORE-001",
      amount: 100,
      totalAmount: 120,
      bonusAmount: 20,
      status: "verified",
      createdBy: actorId,
      player: playerA._id,
      settledAt: new Date("2026-04-09T10:00:00.000Z"),
    });

    await DepositModel.create({
      bankName: "Bank A",
      utr: "UTR-IN-001",
      amount: 200,
      totalAmount: 220,
      bonusAmount: 20,
      status: "verified",
      createdBy: actorId,
      player: playerA._id,
      settledAt: new Date("2026-04-10T10:00:00.000Z"),
    });

    await WithdrawalModel.create({
      player: playerA._id,
      playerName: "PL-A",
      bankName: "Payout Bank",
      amount: 300,
      payableAmount: 250,
      reverseBonus: 50,
      status: "approved",
      createdBy: actorId,
      updatedAt: new Date("2026-04-10T12:00:00.000Z"),
      createdAt: new Date("2026-04-10T12:00:00.000Z"),
    });

    await WithdrawalModel.create({
      player: playerB._id,
      playerName: "PL-B",
      bankName: "Payout Bank",
      amount: 99,
      payableAmount: 99,
      reverseBonus: 0,
      status: "approved",
      createdBy: actorId,
      updatedAt: new Date("2026-04-10T14:00:00.000Z"),
      createdAt: new Date("2026-04-10T14:00:00.000Z"),
    });

    const res = await request(app)
      .get(`/api/v1/exchange/${exchange._id.toString()}/statement?fromDate=2026-04-10&toDate=2026-04-10&playerId=${playerA._id.toString()}`)
      .set("Authorization", `Bearer ${accessToken}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.periodOpeningBalance).toBe(880);
    expect(res.body.data.totalDebits).toBe(220);
    expect(res.body.data.totalCredits).toBe(250);
    expect(res.body.data.periodClosingBalance).toBe(910);
    expect(res.body.data.rows).toHaveLength(2);
    expect(res.body.data.rows[0].kind).toBe("deposit");
    expect(res.body.data.rows[0].direction).toBe("debit");
    expect(res.body.data.rows[0].amount).toBe(220);
    expect(res.body.data.rows[1].kind).toBe("withdrawal");
    expect(res.body.data.rows[1].direction).toBe("credit");
    expect(res.body.data.rows[1].amount).toBe(250);
  });

  it("creates topup, updates current balance and includes topup in statement", async () => {
    const actor = await UserModel.findOne({ username: "superadmin" }).select("_id").lean();
    expect(actor?._id).toBeDefined();
    const actorId = actor!._id;

    const exchange = await ExchangeModel.create({
      name: "E2E Topup",
      provider: "Provider T",
      openingBalance: 500,
      currentBalance: 500,
      bonus: 0,
      status: "active",
      createdBy: actorId,
      updatedBy: actorId,
    });

    const player = await PlayerModel.create({
      exchange: exchange._id,
      playerId: "PL-T",
      phone: "9000000003",
      regularBonusPercentage: 0,
      firstDepositBonusPercentage: 0,
      createdBy: actorId,
      updatedBy: actorId,
    });

    await DepositModel.create({
      bankName: "Bank T",
      utr: "UTR-T-DEP-1",
      amount: 100,
      totalAmount: 110,
      bonusAmount: 10,
      status: "verified",
      createdBy: actorId,
      player: player._id,
      settledAt: new Date("2026-04-12T09:00:00.000Z"),
    });
    await WithdrawalModel.create({
      player: player._id,
      playerName: "PL-T",
      bankName: "Payout Bank",
      amount: 80,
      payableAmount: 70,
      reverseBonus: 10,
      status: "approved",
      createdBy: actorId,
      updatedAt: new Date("2026-04-12T10:00:00.000Z"),
      createdAt: new Date("2026-04-12T10:00:00.000Z"),
    });

    const topupRes = await request(app)
      .post("/api/v1/exchange-topup")
      .set("Authorization", `Bearer ${accessToken}`)
      .send({
        exchangeId: exchange._id.toString(),
        amount: 40,
        remark: "Manual topup",
      });

    expect(topupRes.status).toBe(201);
    expect(topupRes.body.success).toBe(true);
    expect(topupRes.body.data.amount).toBe(40);
    expect(topupRes.body.data.currentBalance).toBe(500 - 110 + 70 + 40);

    const topupCount = await ExchangeTopupModel.countDocuments({ exchangeId: exchange._id });
    expect(topupCount).toBe(1);

    const refreshedExchange = await ExchangeModel.findById(exchange._id).lean();
    expect(refreshedExchange?.currentBalance).toBe(500 - 110 + 70 + 40);

    const statementRes = await request(app)
      .get(`/api/v1/exchange/${exchange._id.toString()}/statement`)
      .set("Authorization", `Bearer ${accessToken}`);

    expect(statementRes.status).toBe(200);
    expect(statementRes.body.data.exchange.currentBalance).toBe(500 - 110 + 70 + 40);
    expect(statementRes.body.data.totalTopUpCredits).toBe(40);
    expect(statementRes.body.data.totalCredits).toBe(110);
    expect(statementRes.body.data.totalDebits).toBe(110);
    expect(statementRes.body.data.periodClosingBalance).toBe(500);
    expect(statementRes.body.data.rows.map((r: { kind: string }) => r.kind)).toEqual([
      "deposit",
      "withdrawal",
      "topup",
    ]);
    const topupRow = statementRes.body.data.rows.find((r: { kind: string }) => r.kind === "topup");
    expect(topupRow.direction).toBe("credit");
    expect(topupRow.amount).toBe(40);
  });

  it("uses entryAt/requestedAt precedence for exchange statement event time", async () => {
    const actor = await UserModel.findOne({ username: "superadmin" }).select("_id").lean();
    expect(actor?._id).toBeDefined();
    const actorId = actor!._id;

    const exchange = await ExchangeModel.create({
      name: "E2E Event Time",
      provider: "Provider ET",
      openingBalance: 1000,
      currentBalance: 1000,
      bonus: 0,
      status: "active",
      createdBy: actorId,
      updatedBy: actorId,
    });

    const player = await PlayerModel.create({
      exchange: exchange._id,
      playerId: "PL-ET",
      phone: "9000000019",
      regularBonusPercentage: 0,
      firstDepositBonusPercentage: 0,
      createdBy: actorId,
      updatedBy: actorId,
    });

    await DepositModel.create({
      bankName: "Bank ET",
      utr: "UTR-ET-DEP-1",
      amount: 100,
      totalAmount: 100,
      bonusAmount: 0,
      status: "verified",
      createdBy: actorId,
      player: player._id,
      entryAt: new Date("2026-04-10T08:00:00.000Z"),
      settledAt: new Date("2026-04-12T08:00:00.000Z"),
    });

    await WithdrawalModel.create({
      player: player._id,
      playerName: "PL-ET",
      bankName: "Payout ET",
      amount: 50,
      payableAmount: 50,
      reverseBonus: 0,
      status: "approved",
      createdBy: actorId,
      requestedAt: new Date("2026-04-10T09:00:00.000Z"),
      updatedAt: new Date("2026-04-12T09:00:00.000Z"),
      createdAt: new Date("2026-04-12T09:00:00.000Z"),
    });

    const res = await request(app)
      .get(`/api/v1/exchange/${exchange._id.toString()}/statement?fromDate=2026-04-10&toDate=2026-04-10`)
      .set("Authorization", `Bearer ${accessToken}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    const kinds = (res.body.data.rows as Array<{ kind: string }>).map((row) => row.kind);
    expect(kinds).toEqual(["deposit", "withdrawal"]);
  });

  it("returns downloadable CSV when sync player import has invalid rows", async () => {
    const actor = await UserModel.findOne({ username: "superadmin" }).select("_id").lean();
    expect(actor?._id).toBeDefined();

    await ExchangeModel.create({
      name: "E2E Import Invalid Email",
      provider: "Provider Import",
      openingBalance: 100,
      bonus: 0,
      status: "active",
      createdBy: actor!._id,
      updatedBy: actor!._id,
    });

    const invalidCsv = [
      PLAYER_IMPORT_CSV_HEADER,
      `E2E Import Invalid Email,PLAYER-1,9000000001,invalid-email,trader,,`,
    ].join("\n");

    const res = await request(app)
      .post("/api/v1/players/import")
      .set("Authorization", `Bearer ${accessToken}`)
      .attach("file", Buffer.from(invalidCsv, "utf-8"), "players.csv");

    expect(res.status).toBe(400);
    expect(String(res.headers["content-type"] ?? "")).toContain("text/csv");
    expect(String(res.headers["content-disposition"] ?? "")).toContain("attachment");
    const body = Buffer.isBuffer(res.body) ? res.body.toString("utf-8") : String(res.text ?? "");
    expect(body).toContain("error_reason");
    expect(body).toContain("Email ID must be a valid email address");
    expect(body).toContain("PLAYER-1");
  });

  it("imports traders with email, IB referral, and referral percentage", async () => {
    const actor = await UserModel.findOne({ username: "superadmin" }).select("_id").lean();
    expect(actor?._id).toBeDefined();

    const exchange = await ExchangeModel.create({
      name: "E2E Import Happy",
      provider: "Provider Import",
      openingBalance: 100,
      bonus: 0,
      status: "active",
      createdBy: actor!._id,
      updatedBy: actor!._id,
    });

    await PlayerModel.create({
      exchange: exchange._id,
      playerId: "IB-IMPORT-001",
      phone: "9111111111",
      userType: "ib",
      regularBonusPercentage: 0,
      firstDepositBonusPercentage: 0,
      createdBy: actor!._id,
      updatedBy: actor!._id,
    });

    const validCsv = [
      PLAYER_IMPORT_CSV_HEADER,
      `E2E Import Happy,TRADER-IMPORT-001,9222222222,trader@import.test,trader,IB-IMPORT-001,12.5`,
    ].join("\n");

    const res = await request(app)
      .post("/api/v1/players/import")
      .set("Authorization", `Bearer ${accessToken}`)
      .attach("file", Buffer.from(validCsv, "utf-8"), "players.csv");

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.created).toBe(1);

    const created = await PlayerModel.findOne({ exchange: exchange._id, playerId: "TRADER-IMPORT-001" })
      .populate("referredByPlayerId", "playerId")
      .lean();
    expect(created?.email).toBe("trader@import.test");
    expect(created?.referralPercentage).toBe(12.5);
    expect(created?.regularBonusPercentage).toBe(0);
    expect(created?.firstDepositBonusPercentage).toBe(0);
    const referrer = created?.referredByPlayerId as { playerId?: string } | null | undefined;
    expect(referrer?.playerId).toBe("IB-IMPORT-001");
  });

  it("rejects import when ib_player_id is not found", async () => {
    const actor = await UserModel.findOne({ username: "superadmin" }).select("_id").lean();
    expect(actor?._id).toBeDefined();

    await ExchangeModel.create({
      name: "E2E Import Missing IB",
      provider: "Provider Import",
      openingBalance: 100,
      bonus: 0,
      status: "active",
      createdBy: actor!._id,
      updatedBy: actor!._id,
    });

    const invalidCsv = [
      PLAYER_IMPORT_CSV_HEADER,
      `E2E Import Missing IB,TRADER-IMPORT-002,9333333333,,trader,MISSING-IB,5`,
    ].join("\n");

    const res = await request(app)
      .post("/api/v1/players/import")
      .set("Authorization", `Bearer ${accessToken}`)
      .attach("file", Buffer.from(invalidCsv, "utf-8"), "players.csv");

    expect(res.status).toBe(400);
    const body = Buffer.isBuffer(res.body) ? res.body.toString("utf-8") : String(res.text ?? "");
    expect(body).toContain(`No ${PLAYER_IMPORT_CSV_COLUMNS.ib} found`);
  });

  it("rejects import when ib_player_id refers to a trader not IB", async () => {
    const actor = await UserModel.findOne({ username: "superadmin" }).select("_id").lean();
    expect(actor?._id).toBeDefined();

    const exchange = await ExchangeModel.create({
      name: "E2E Import Not IB",
      provider: "Provider Import",
      openingBalance: 100,
      bonus: 0,
      status: "active",
      createdBy: actor!._id,
      updatedBy: actor!._id,
    });

    await PlayerModel.create({
      exchange: exchange._id,
      playerId: "NOT-IB-001",
      phone: "9444444444",
      userType: "trader",
      regularBonusPercentage: 0,
      firstDepositBonusPercentage: 0,
      createdBy: actor!._id,
      updatedBy: actor!._id,
    });

    const invalidCsv = [
      PLAYER_IMPORT_CSV_HEADER,
      `E2E Import Not IB,TRADER-IMPORT-003,9555555555,,trader,NOT-IB-001,5`,
    ].join("\n");

    const res = await request(app)
      .post("/api/v1/players/import")
      .set("Authorization", `Bearer ${accessToken}`)
      .attach("file", Buffer.from(invalidCsv, "utf-8"), "players.csv");

    expect(res.status).toBe(400);
    const body = Buffer.isBuffer(res.body) ? res.body.toString("utf-8") : String(res.text ?? "");
    expect(body).toContain(`No ${PLAYER_IMPORT_CSV_COLUMNS.ib} found`);
  });

  it("ignores legacy bonus and old_player columns during import", async () => {
    const actor = await UserModel.findOne({ username: "superadmin" }).select("_id").lean();
    expect(actor?._id).toBeDefined();

    const exchange = await ExchangeModel.create({
      name: "E2E Import Legacy",
      provider: "Provider Import",
      openingBalance: 100,
      bonus: 0,
      status: "active",
      createdBy: actor!._id,
      updatedBy: actor!._id,
    });

    const legacyCsv = [
      "exchange_name,player_id,phone,bonus_percentage,first_deposit_bonus_percentage,old_player",
      "E2E Import Legacy,TRADER-LEGACY-001,9666666666,25,30,yes",
    ].join("\n");

    const res = await request(app)
      .post("/api/v1/players/import")
      .set("Authorization", `Bearer ${accessToken}`)
      .attach("file", Buffer.from(legacyCsv, "utf-8"), "players.csv");

    expect(res.status).toBe(200);
    expect(res.body.data.created).toBe(1);

    const created = await PlayerModel.findOne({ exchange: exchange._id, playerId: "TRADER-LEGACY-001" }).lean();
    expect(created?.regularBonusPercentage).toBe(0);
    expect(created?.firstDepositBonusPercentage).toBe(0);
    expect(created?.isMigratedOldUser).toBe(false);
  });

  it("downloads async player import job error CSV after job failure", async () => {
    const actor = await UserModel.findOne({ username: "superadmin" }).select("_id").lean();
    expect(actor?._id).toBeDefined();

    const failedJob = await PlayerImportJobModel.create({
      status: "failed",
      fileName: "players.csv",
      fileSize: 256,
      fileMimeType: "text/csv",
      fileBuffer: Buffer.from("x"),
      createdBy: actor!._id,
      failureReason: "Import failed",
      progress: {
        totalRows: 1,
        processedRows: 1,
        successRows: 0,
        failedRows: 1,
        skippedRows: 0,
      },
      errorSample: [
        {
          row: 2,
          message: "Phone Number is required",
          reason: "Phone Number is required",
          rowData: {
            [PLAYER_IMPORT_CSV_COLUMNS.exchange]: "E2E",
            [PLAYER_IMPORT_CSV_COLUMNS.traderId]: "PLAYER-2",
            [PLAYER_IMPORT_CSV_COLUMNS.phoneNumber]: "(empty)",
            [PLAYER_IMPORT_CSV_COLUMNS.emailId]: "",
            [PLAYER_IMPORT_CSV_COLUMNS.userType]: "trader",
            [PLAYER_IMPORT_CSV_COLUMNS.ib]: "",
            [PLAYER_IMPORT_CSV_COLUMNS.referralPercentageForIb]: "0",
          },
        },
      ],
      errorRows: [
        {
          row: 2,
          message: "Phone Number is required",
          reason: "Phone Number is required",
          rowData: {
            [PLAYER_IMPORT_CSV_COLUMNS.exchange]: "E2E",
            [PLAYER_IMPORT_CSV_COLUMNS.traderId]: "PLAYER-2",
            [PLAYER_IMPORT_CSV_COLUMNS.phoneNumber]: "(empty)",
            [PLAYER_IMPORT_CSV_COLUMNS.emailId]: "",
            [PLAYER_IMPORT_CSV_COLUMNS.userType]: "trader",
            [PLAYER_IMPORT_CSV_COLUMNS.ib]: "",
            [PLAYER_IMPORT_CSV_COLUMNS.referralPercentageForIb]: "0",
          },
        },
      ],
    });

    const res = await request(app)
      .get(`/api/v1/players/import-jobs/${failedJob._id.toString()}/errors.csv`)
      .set("Authorization", `Bearer ${accessToken}`);

    expect(res.status).toBe(200);
    expect(String(res.headers["content-type"] ?? "")).toContain("text/csv");
    expect(String(res.headers["content-disposition"] ?? "")).toContain(`trader-import-errors-${failedJob._id.toString()}.csv`);
    const body = Buffer.isBuffer(res.body) ? res.body.toString("utf-8") : String(res.text ?? "");
    expect(body).toContain("error_reason");
    expect(body).toContain(`${PLAYER_IMPORT_CSV_COLUMNS.phoneNumber} is required`);
    expect(body).toContain("PLAYER-2");
  });

  it("lists computed current balance after verified deposit without persisted recompute", async () => {
    const actor = await UserModel.findOne({ username: "superadmin" }).select("_id").lean();
    expect(actor?._id).toBeDefined();
    const actorId = actor!._id;

    const exchange = await ExchangeModel.create({
      name: "E2E List Balance",
      provider: "Provider LB",
      openingBalance: 800,
      currentBalance: 800,
      bonus: 0,
      status: "active",
      createdBy: actorId,
      updatedBy: actorId,
    });

    const player = await PlayerModel.create({
      exchange: exchange._id,
      playerId: "PL-LB",
      phone: "9000000099",
      regularBonusPercentage: 0,
      firstDepositBonusPercentage: 0,
      createdBy: actorId,
      updatedBy: actorId,
    });

    await DepositModel.create({
      bankName: "Bank LB",
      utr: "UTR-LB-001",
      amount: 140,
      totalAmount: 150,
      bonusAmount: 10,
      status: "verified",
      createdBy: actorId,
      player: player._id,
      settledAt: new Date("2026-04-15T10:00:00.000Z"),
    });

    const listRes = await request(app)
      .get("/api/v1/exchange?page=1&pageSize=50&name=E2E%20List%20Balance&name_op=equals")
      .set("Authorization", `Bearer ${accessToken}`);

    expect(listRes.status).toBe(200);
    const row = listRes.body.data.find(
      (item: { name?: string }) => item.name === "E2E List Balance",
    );
    expect(row).toBeDefined();
    expect(row.currentBalance).toBe(650);
    expect(row.openingBalance).toBe(800);

    const stored = await ExchangeModel.findById(exchange._id).lean();
    expect(stored?.currentBalance).toBe(800);
  });
});
