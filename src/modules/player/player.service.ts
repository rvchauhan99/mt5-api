import mongoose, { Types } from "mongoose";
import { generateExcelBuffer } from "../../shared/services/excel.service";
import xlsx from "xlsx";
import type { z } from "zod";
import { AppError } from "../../shared/errors/AppError";
import { createAuditLog } from "../audit/audit.service";
import { ExchangeModel } from "../exchange/exchange.model";
import {
  DEFAULT_TIMEZONE,
  formatDateTimeForTimeZone,
  ymdToUtcEnd,
  ymdToUtcStart,
} from "../../shared/utils/timezone";
import { PlayerModel } from "./player.model";
import { exportPlayerQuerySchema, listPlayerQuerySchema } from "./player.validation";
import { decodeTimeCursor, encodeTimeCursor } from "../../shared/utils/cursorPagination";

type ListPlayerQuery = z.infer<typeof listPlayerQuerySchema>;
type ExportPlayerQuery = z.infer<typeof exportPlayerQuerySchema>;

const EXPORT_MAX_ROWS = 10_000;

function trimUndef(s: string | undefined): string | undefined {
  if (s == null) return undefined;
  const t = String(s).trim();
  return t === "" ? undefined : t;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function textFieldCondition(field: string, value: string, op: string | undefined): Record<string, unknown> {
  const operator = op || "contains";
  const esc = escapeRegex(value);
  switch (operator) {
    case "contains":
      return { [field]: { $regex: esc, $options: "i" } };
    case "notContains":
      return { [field]: { $not: new RegExp(esc, "i") } };
    case "equals":
      return { [field]: { $regex: `^${esc}$`, $options: "i" } };
    case "notEquals":
      return { [field]: { $not: new RegExp(`^${esc}$`, "i") } };
    case "startsWith":
      return { [field]: { $regex: `^${esc}`, $options: "i" } };
    case "endsWith":
      return { [field]: { $regex: `${esc}$`, $options: "i" } };
    default:
      return { [field]: { $regex: esc, $options: "i" } };
  }
}

function numberFieldCondition(
  field: string,
  value: string | undefined,
  op: string | undefined,
  valueTo: string | undefined,
): Record<string, unknown> | null {
  const v = trimUndef(value);
  if (v == null) return null;
  const num = Number(v);
  if (!Number.isFinite(num)) return null;
  const operator = op || "equals";
  const numToRaw = trimUndef(valueTo);
  const toNum = numToRaw != null ? Number(numToRaw) : NaN;

  switch (operator) {
    case "equals":
      return { [field]: num };
    case "notEquals":
      return { [field]: { $ne: num } };
    case "gt":
      return { [field]: { $gt: num } };
    case "gte":
      return { [field]: { $gte: num } };
    case "lt":
      return { [field]: { $lt: num } };
    case "lte":
      return { [field]: { $lte: num } };
    case "between":
      if (numToRaw != null && Number.isFinite(toNum)) {
        return { [field]: { $gte: Math.min(num, toNum), $lte: Math.max(num, toNum) } };
      }
      return { [field]: num };
    default:
      return { [field]: num };
  }
}

function createdAtCondition(
  from: string | undefined,
  to: string | undefined,
  op: string | undefined,
  timeZone: string,
): Record<string, unknown> | null {
  const operator = op || "inRange";
  const f = trimUndef(from);
  const t = trimUndef(to);

  if (operator === "inRange" && f && t) {
    const start = ymdToUtcStart(f, timeZone);
    const end = ymdToUtcEnd(t, timeZone);
    if (!start || !end) return null;
    return { createdAt: { $gte: start, $lte: end } };
  }
  if (operator === "equals" && f) {
    const start = ymdToUtcStart(f, timeZone);
    const end = ymdToUtcEnd(f, timeZone);
    if (!start || !end) return null;
    return { createdAt: { $gte: start, $lte: end } };
  }
  if (operator === "before" && f) {
    const start = ymdToUtcStart(f, timeZone);
    if (!start) return null;
    return { createdAt: { $lt: start } };
  }
  if (operator === "after" && f) {
    const end = ymdToUtcEnd(f, timeZone);
    if (!end) return null;
    return { createdAt: { $gt: end } };
  }
  if (f && t) {
    const start = ymdToUtcStart(f, timeZone);
    const end = ymdToUtcEnd(t, timeZone);
    if (!start || !end) return null;
    return { createdAt: { $gte: start, $lte: end } };
  }
  if (f) {
    const start = ymdToUtcStart(f, timeZone);
    if (!start) return null;
    return { createdAt: { $gte: start } };
  }
  if (t) {
    const end = ymdToUtcEnd(t, timeZone);
    if (!end) return null;
    return { createdAt: { $lte: end } };
  }
  return null;
}

async function buildPlayerListFilter(q: ExportPlayerQuery, timeZone: string): Promise<Record<string, unknown>> {
  const conditions: Record<string, unknown>[] = [];

  const search = trimUndef(q.search);
  if (search) {
    conditions.push({
      $or: [
        { playerId: { $regex: escapeRegex(search), $options: "i" } },
        { phone: { $regex: escapeRegex(search), $options: "i" } },
      ],
    });
  }

  const playerId = trimUndef(q.playerId);
  if (playerId) {
    conditions.push(textFieldCondition("playerId", playerId, trimUndef(q.playerId_op)));
  }

  const phone = trimUndef(q.phone);
  if (phone) {
    conditions.push(textFieldCondition("phone", phone, trimUndef(q.phone_op)));
  }

  const userType = trimUndef(q.userType);
  if (userType) {
    const normalized = userType.toLowerCase();
    if (normalized === "trader" || normalized === "ib") {
      const op = trimUndef(q.userType_op) || "equals";
      if (op === "notEquals") {
        conditions.push({ userType: { $ne: normalized } });
      } else {
        conditions.push({ userType: normalized });
      }
    }
  }

  const exchangeName = trimUndef(q.exchangeName);
  if (exchangeName) {
    const exFilter = textFieldCondition("name", exchangeName, trimUndef(q.exchangeName_op));
    const matches = await ExchangeModel.find(exFilter).select("_id").lean();
    const ids = matches.map((m) => m._id);
    conditions.push({ exchange: { $in: ids } });
  }

  const exId = trimUndef(q.exchangeId);
  if (exId && Types.ObjectId.isValid(exId)) {
    conditions.push({ exchange: new Types.ObjectId(exId) });
  }

  const createdBy = trimUndef(q.createdBy);
  if (createdBy && Types.ObjectId.isValid(createdBy)) {
    conditions.push({ createdBy: new Types.ObjectId(createdBy) });
  }

  const dateCond = createdAtCondition(
    trimUndef(q.createdAt_from),
    trimUndef(q.createdAt_to),
    trimUndef(q.createdAt_op),
    timeZone,
  );
  if (dateCond) {
    conditions.push(dateCond);
  }

  const regularBonus = numberFieldCondition(
    "regularBonusPercentage",
    trimUndef(q.regularBonusPercentage ?? q.bonusPercentage),
    trimUndef(q.regularBonusPercentage_op ?? q.bonusPercentage_op),
    trimUndef(q.regularBonusPercentage_to ?? q.bonusPercentage_to),
  );
  if (regularBonus) {
    conditions.push(regularBonus);
  }

  const firstDepositBonus = numberFieldCondition(
    "firstDepositBonusPercentage",
    trimUndef(q.firstDepositBonusPercentage),
    trimUndef(q.firstDepositBonusPercentage_op),
    trimUndef(q.firstDepositBonusPercentage_to),
  );
  if (firstDepositBonus) {
    conditions.push(firstDepositBonus);
  }

  if (conditions.length === 0) {
    return {};
  }
  if (conditions.length === 1) {
    return conditions[0];
  }
  return { $and: conditions };
}

export async function resolveExchangeIdByName(name: string): Promise<{
  id: Types.ObjectId;
  ambiguous: boolean;
  notFound: boolean;
}> {
  const trimmed = name.trim();
  if (!trimmed) {
    return { id: new Types.ObjectId(), ambiguous: false, notFound: true };
  }
  const matches = await ExchangeModel.find({
    name: { $regex: new RegExp(`^${escapeRegex(trimmed)}$`, "i") },
  })
    .select("_id")
    .lean();

  if (matches.length === 0) {
    return { id: new Types.ObjectId(), ambiguous: false, notFound: true };
  }
  if (matches.length > 1) {
    return { id: new Types.ObjectId(), ambiguous: true, notFound: false };
  }
  return { id: matches[0]._id as Types.ObjectId, ambiguous: false, notFound: false };
}

export async function createPlayer(
  input: {
    exchangeId: string;
    playerId: string;
    phone: string;
    email?: string | null;
    userType: "trader" | "ib";
    regularBonusPercentage: number;
    firstDepositBonusPercentage: number;
    referredByPlayerId?: string | null;
    referralPercentage?: number;
  },
  actorId: string,
  requestId?: string,
) {
  const exchange = await ExchangeModel.findById(input.exchangeId);
  if (!exchange) {
    throw new AppError("not_found", "Exchange not found", 404);
  }

  const playerId = input.playerId.trim();
  const phone = input.phone.trim();
  const email = input.email?.trim().toLowerCase() || undefined;
  const userType = input.userType;
  const regularBonusPercentage = input.regularBonusPercentage;
  const firstDepositBonusPercentage = input.firstDepositBonusPercentage;
  const referralPercentage = input.referralPercentage ?? 0;

  let referredByPlayerId: Types.ObjectId | undefined;
  if (input.referredByPlayerId) {
    if (!Types.ObjectId.isValid(input.referredByPlayerId)) {
      throw new AppError("validation_error", "Invalid referredByPlayerId", 400);
    }
    referredByPlayerId = new Types.ObjectId(input.referredByPlayerId);
    const referrer = await PlayerModel.findById(referredByPlayerId).select("_id userType");
    if (!referrer) {
      throw new AppError("not_found", "Referrer player not found", 404);
    }
    if (referrer.userType !== "ib") {
      throw new AppError("validation_error", "Referrer must be an IB player", 400);
    }
  }

  try {
    const doc = await PlayerModel.create({
      exchange: new Types.ObjectId(input.exchangeId),
      playerId,
      phone,
      email,
      userType,
      regularBonusPercentage,
      firstDepositBonusPercentage,
      referredByPlayerId,
      referralPercentage,
      createdBy: new Types.ObjectId(actorId),
      updatedBy: new Types.ObjectId(actorId),
    });

    await createAuditLog({
      actorId,
      action: "player.create",
      entity: "player",
      entityId: doc._id.toString(),
      newValue: {
        exchangeId: input.exchangeId,
        playerId,
        phone,
        email,
        userType,
        regularBonusPercentage,
        firstDepositBonusPercentage,
        referredByPlayerId: referredByPlayerId?.toString(),
        referralPercentage,
      },
      requestId,
    });

    return doc;
  } catch (err: unknown) {
    const code = err && typeof err === "object" && "code" in err ? (err as { code?: number }).code : undefined;
    if (code === 11000) {
      throw new AppError("business_rule_error", "Trader Wallet Id already exists for this exchange", 409);
    }
    throw err;
  }
}

export async function getPlayerById(id: string) {
  if (!mongoose.Types.ObjectId.isValid(id)) {
    throw new AppError("validation_error", "Invalid Trader Wallet Id", 400);
  }
  const doc = await PlayerModel.findById(id)
    .select(
      "exchange playerId phone email userType regularBonusPercentage firstDepositBonusPercentage referredByPlayerId referralPercentage",
    )
    .populate("exchange", "name provider")
    .populate("referredByPlayerId", "playerId phone exchange")
    .lean();
  if (!doc) {
    throw new AppError("not_found", "Player not found", 404);
  }
  return {
    ...doc,
    userType: doc.userType === "ib" ? "ib" : "trader",
    bonusPercentage: doc.regularBonusPercentage,
  };
}

export async function updatePlayer(
  id: string,
  input: {
    phone: string;
    email?: string | null;
    userType: "trader" | "ib";
    regularBonusPercentage: number;
    firstDepositBonusPercentage: number;
    referredByPlayerId?: string | null;
    referralPercentage?: number;
  },
  actorId: string,
  requestId?: string,
) {
  if (!mongoose.Types.ObjectId.isValid(id)) {
    throw new AppError("validation_error", "Invalid Trader Wallet Id", 400);
  }
  const doc = await PlayerModel.findById(id);
  if (!doc) {
    throw new AppError("not_found", "Player not found", 404);
  }

  const oldValue = {
    phone: doc.phone,
    email: doc.email,
    userType: doc.userType ?? "trader",
    regularBonusPercentage: doc.regularBonusPercentage,
    firstDepositBonusPercentage: doc.firstDepositBonusPercentage,
    referredByPlayerId: doc.referredByPlayerId?.toString(),
    referralPercentage: doc.referralPercentage ?? 0,
  };

  let referredByPlayerId: Types.ObjectId | undefined;
  if (input.referredByPlayerId) {
    if (!Types.ObjectId.isValid(input.referredByPlayerId)) {
      throw new AppError("validation_error", "Invalid referredByPlayerId", 400);
    }
    if (String(doc._id) === input.referredByPlayerId) {
      throw new AppError("business_rule_error", "Player cannot refer themselves", 400);
    }
    referredByPlayerId = new Types.ObjectId(input.referredByPlayerId);
    const referrer = await PlayerModel.findById(referredByPlayerId).select("_id userType");
    if (!referrer) {
      throw new AppError("not_found", "Referrer player not found", 404);
    }
    if (referrer.userType !== "ib") {
      throw new AppError("validation_error", "Referrer must be an IB player", 400);
    }
  }

  const email = input.email?.trim().toLowerCase() || undefined;
  doc.phone = input.phone.trim();
  if (email) {
    doc.email = email;
  } else {
    doc.set("email", undefined);
  }
  doc.userType = input.userType;
  doc.regularBonusPercentage = input.regularBonusPercentage;
  doc.firstDepositBonusPercentage = input.firstDepositBonusPercentage;
  doc.referredByPlayerId = referredByPlayerId;
  doc.referralPercentage = input.referralPercentage ?? 0;
  doc.updatedBy = new Types.ObjectId(actorId);
  await doc.save();

  await createAuditLog({
    actorId,
    action: "player.update",
    entity: "player",
    entityId: doc._id.toString(),
    oldValue,
    newValue: {
      phone: doc.phone,
      email: doc.email,
      userType: doc.userType,
      regularBonusPercentage: doc.regularBonusPercentage,
      firstDepositBonusPercentage: doc.firstDepositBonusPercentage,
      referredByPlayerId: doc.referredByPlayerId?.toString(),
      referralPercentage: doc.referralPercentage ?? 0,
    },
    requestId,
  });

  return doc;
}

export async function listPlayers(query: ListPlayerQuery, options?: { timeZone?: string }) {
  const timeZone = options?.timeZone || DEFAULT_TIMEZONE;
  const page = query.page ?? 1;
  const pageSize = query.pageSize ?? query.limit ?? 20;
  const skip = (page - 1) * pageSize;
  const requestedSortBy = query.sortBy ?? "createdAt";
  const sortBy = requestedSortBy === "bonusPercentage" ? "regularBonusPercentage" : requestedSortBy;
  const sortOrder = query.sortOrder === "asc" ? 1 : -1;
  const supportsCursor = sortOrder === -1 && sortBy === "createdAt";
  const cursor = supportsCursor ? decodeTimeCursor(query.cursor) : null;

  const filter = await buildPlayerListFilter(query, timeZone);
  const queryFilter: Record<string, unknown> = { ...filter };
  if (cursor) {
    const cursorDate = new Date(cursor.t);
    if (!Number.isNaN(cursorDate.getTime()) && Types.ObjectId.isValid(cursor.id)) {
      queryFilter.$or = [
        { createdAt: { $lt: cursorDate } },
        { createdAt: cursorDate, _id: { $lt: new Types.ObjectId(cursor.id) } },
      ];
    }
  }

  const [rows, total] = await Promise.all([
    PlayerModel.find(queryFilter)
      .sort({ [sortBy]: sortOrder })
      .skip(cursor ? 0 : skip)
      .limit(pageSize)
      .populate("exchange", "name provider")
      .populate("referredByPlayerId", "playerId phone exchange")
      .populate("createdBy", "fullName username")
      .populate("updatedBy", "fullName username")
      .lean(),
    PlayerModel.countDocuments(filter),
  ]);

  const normalizedRows = rows.map((row) => ({
    ...row,
    userType: row.userType === "ib" ? "ib" : "trader",
    bonusPercentage:
      typeof row.regularBonusPercentage === "number"
        ? row.regularBonusPercentage
        : Number((row as { bonusPercentage?: unknown }).bonusPercentage ?? 0),
  }));

  return {
    rows: normalizedRows,
    meta: {
      total,
      page,
      pageSize,
      ...(cursor && rows.length
        ? {
            nextCursor: encodeTimeCursor({
              t: (rows[rows.length - 1] as { createdAt?: Date }).createdAt ?? new Date(),
              id: String((rows[rows.length - 1] as { _id?: unknown })._id ?? ""),
            }),
          }
        : {}),
    },
  };
}

export async function exportPlayersToBuffer(
  query: ExportPlayerQuery,
  options?: { timeZone?: string },
): Promise<Buffer> {
  const timeZone = options?.timeZone || DEFAULT_TIMEZONE;
  const filter = await buildPlayerListFilter(query, timeZone);
  const requestedSortBy = query.sortBy ?? "createdAt";
  const sortBy = requestedSortBy === "bonusPercentage" ? "regularBonusPercentage" : requestedSortBy;
  const sortOrder = query.sortOrder === "asc" ? 1 : -1;

  const rows = await PlayerModel.find(filter)
    .sort({ [sortBy]: sortOrder })
    .limit(EXPORT_MAX_ROWS)
    .populate("exchange", "name provider")
    .populate("createdBy", "fullName username")
    .lean();

  function formatCreatedBy(createdBy: unknown): string {
    if (createdBy == null) return "";
    if (typeof createdBy === "object" && createdBy !== null && "fullName" in createdBy) {
      const u = createdBy as { fullName?: string; username?: string };
      const fn = u.fullName?.trim();
      const un = u.username?.trim();
      if (fn && un) return `${fn} (${un})`;
      if (fn) return fn;
      if (un) return un;
    }
    return "";
  }

  const exportData = rows.map((r) => {
    const ex = r.exchange as { name?: string; provider?: string } | null;
    return {
      "Exchange Name": ex?.name ?? "",
      Provider: ex?.provider ?? "",
      "Trader Wallet Id": r.playerId,
      Phone: r.phone,
      Email: r.email ?? "",
      "User Type": r.userType === "ib" ? "IB" : "Trader",
      "Regular Bonus %": r.regularBonusPercentage ?? 0,
      "First Deposit Bonus %": r.firstDepositBonusPercentage ?? 0,
      "Referral %": r.referralPercentage ?? 0,
      "Referred By Player": (() => {
        const referredBy = r.referredByPlayerId as { playerId?: string; phone?: string } | null | undefined;
        if (!referredBy?.playerId) return "";
        return referredBy.phone ? `${referredBy.playerId} (${referredBy.phone})` : referredBy.playerId;
      })(),
      "Created By": formatCreatedBy(r.createdBy),
      "Created At": formatDateTimeForTimeZone(r.createdAt, timeZone),
    };
  });

  return generateExcelBuffer(exportData, "Players");
}

/** CSV column headers — match Trader / Add form labels. */
export const PLAYER_IMPORT_CSV_COLUMNS = {
  exchange: "Exchange",
  traderId: "Trader Wallet Id",
  phoneNumber: "Phone Number",
  emailId: "Email ID",
  userType: "User type",
  ib: "IB Trader Wallet Id",
  referralPercentageForIb: "Referral Percentage for IB",
} as const;

export const PLAYER_IMPORT_CSV_HEADER_LIST = [
  PLAYER_IMPORT_CSV_COLUMNS.exchange,
  PLAYER_IMPORT_CSV_COLUMNS.traderId,
  PLAYER_IMPORT_CSV_COLUMNS.phoneNumber,
  PLAYER_IMPORT_CSV_COLUMNS.emailId,
  PLAYER_IMPORT_CSV_COLUMNS.userType,
  PLAYER_IMPORT_CSV_COLUMNS.ib,
  PLAYER_IMPORT_CSV_COLUMNS.referralPercentageForIb,
] as const;

function makeImportRowData(fields: {
  exchangeName?: string;
  playerId?: string;
  phone?: string;
  email?: string;
  userType?: string;
  ibPlayerId?: string;
  referralPercentage?: string;
}): ImportErrorRowData {
  return {
    [PLAYER_IMPORT_CSV_COLUMNS.exchange]: fields.exchangeName ?? "",
    [PLAYER_IMPORT_CSV_COLUMNS.traderId]: fields.playerId ?? "",
    [PLAYER_IMPORT_CSV_COLUMNS.phoneNumber]: fields.phone ?? "",
    [PLAYER_IMPORT_CSV_COLUMNS.emailId]: fields.email ?? "",
    [PLAYER_IMPORT_CSV_COLUMNS.userType]: fields.userType ?? "",
    [PLAYER_IMPORT_CSV_COLUMNS.ib]: fields.ibPlayerId ?? "",
    [PLAYER_IMPORT_CSV_COLUMNS.referralPercentageForIb]: fields.referralPercentage ?? "",
  };
}

export function getSampleCsvBuffer(): Buffer {
  const header = `${PLAYER_IMPORT_CSV_HEADER_LIST.join(",")}\n`;
  const example =
    "Example Exchange,PLAYER001,9876543210,trader@example.com,trader,IB001,5\n";
  return Buffer.from(header + example, "utf-8");
}

function normalizeHeaderKey(raw: string): string {
  return String(raw)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function pickCell(row: Record<string, unknown>, ...aliases: string[]): string {
  const wanted = new Set(aliases.map((a) => normalizeHeaderKey(a)));
  for (const [key, val] of Object.entries(row)) {
    if (!wanted.has(normalizeHeaderKey(key))) continue;
    if (val != null && String(val).trim() !== "") return String(val).trim();
  }
  return "";
}

/** First matching column value, may be empty (for optional numeric cells). */
function pickCellRaw(row: Record<string, unknown>, ...aliases: string[]): string {
  const wanted = new Set(aliases.map((a) => normalizeHeaderKey(a)));
  for (const [key, val] of Object.entries(row)) {
    if (!wanted.has(normalizeHeaderKey(key))) continue;
    return val == null ? "" : String(val).trim();
  }
  return "";
}

export type ImportErrorRowData = {
  [PLAYER_IMPORT_CSV_COLUMNS.exchange]: string;
  [PLAYER_IMPORT_CSV_COLUMNS.traderId]: string;
  [PLAYER_IMPORT_CSV_COLUMNS.phoneNumber]: string;
  [PLAYER_IMPORT_CSV_COLUMNS.emailId]: string;
  [PLAYER_IMPORT_CSV_COLUMNS.userType]: string;
  [PLAYER_IMPORT_CSV_COLUMNS.ib]: string;
  [PLAYER_IMPORT_CSV_COLUMNS.referralPercentageForIb]: string;
};

export type ImportRowError = {
  row: number;
  message: string;
  reason: string;
  rowData: ImportErrorRowData;
};

function buildImportError(
  rowNum: number,
  reason: string,
  rowData: ImportErrorRowData,
): ImportRowError {
  return { row: rowNum, message: reason, reason, rowData };
}

function quoteCsvValue(value: string): string {
  const escaped = value.replace(/"/g, "\"\"");
  return `"${escaped}"`;
}

export function buildPlayerImportErrorCsvBuffer(errors: ImportRowError[]): Buffer {
  const header = ["row", ...PLAYER_IMPORT_CSV_HEADER_LIST, "error_reason"];
  const lines = [header.join(",")];
  for (const error of errors) {
    lines.push(
      [
        String(error.row),
        quoteCsvValue(error.rowData[PLAYER_IMPORT_CSV_COLUMNS.exchange]),
        quoteCsvValue(error.rowData[PLAYER_IMPORT_CSV_COLUMNS.traderId]),
        quoteCsvValue(error.rowData[PLAYER_IMPORT_CSV_COLUMNS.phoneNumber]),
        quoteCsvValue(error.rowData[PLAYER_IMPORT_CSV_COLUMNS.emailId]),
        quoteCsvValue(error.rowData[PLAYER_IMPORT_CSV_COLUMNS.userType]),
        quoteCsvValue(error.rowData[PLAYER_IMPORT_CSV_COLUMNS.ib]),
        quoteCsvValue(error.rowData[PLAYER_IMPORT_CSV_COLUMNS.referralPercentageForIb]),
        quoteCsvValue(error.reason),
      ].join(","),
    );
  }
  return Buffer.from(lines.join("\n"), "utf-8");
}

function parsePercentageCell(
  raw: string,
  rowNum: number,
  fieldName: string,
  rowData: ImportErrorRowData,
): { ok: true; value: number } | { ok: false; error: ImportRowError } {
  const t = raw.trim();
  if (t === "") {
    return { ok: true, value: 0 };
  }
  const n = Number(t);
  if (!Number.isFinite(n)) {
    return {
      ok: false,
      error: buildImportError(rowNum, `${fieldName} must be a valid number`, rowData),
    };
  }
  if (n < 0 || n > 100) {
    return {
      ok: false,
      error: buildImportError(rowNum, `${fieldName} must be between 0 and 100`, rowData),
    };
  }
  return { ok: true, value: n };
}

const IMPORT_EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function parseEmailCell(
  raw: string,
  rowNum: number,
  rowData: ImportErrorRowData,
): { ok: true; value: string | undefined } | { ok: false; error: ImportRowError } {
  const trimmed = raw.trim();
  if (trimmed === "") return { ok: true, value: undefined };
  if (!IMPORT_EMAIL_REGEX.test(trimmed)) {
    return {
      ok: false,
      error: buildImportError(rowNum, "Email ID must be a valid email address", rowData),
    };
  }
  return { ok: true, value: trimmed.toLowerCase() };
}

function parseUserTypeCell(
  raw: string,
  rowNum: number,
  rowData: ImportErrorRowData,
): { ok: true; value: "trader" | "ib" } | { ok: false; error: ImportRowError } {
  const t = raw.trim().toLowerCase();
  if (t === "" || t === "trader") return { ok: true, value: "trader" };
  if (t === "ib") return { ok: true, value: "ib" };
  return {
    ok: false,
    error: buildImportError(
      rowNum,
      `${PLAYER_IMPORT_CSV_COLUMNS.userType} must be trader or ib (or blank for trader)`,
      rowData,
    ),
  };
}

function sheetRowsToObjects(sheet: xlsx.WorkSheet): Record<string, unknown>[] {
  return xlsx.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: "", raw: false });
}

type ParsedImportRow = {
  rowNum: number;
  exchangeName: string;
  exchangeId: Types.ObjectId;
  playerId: string;
  phone: string;
  email?: string;
  userType: "trader" | "ib";
  referredByPlayerId?: Types.ObjectId;
  referralPercentage: number;
  ibPlayerIdRaw: string;
};

function parsedImportRowToErrorData(row: ParsedImportRow): ImportErrorRowData {
  return makeImportRowData({
    exchangeName: row.exchangeName,
    playerId: row.playerId,
    phone: row.phone,
    email: row.email ?? "",
    userType: row.userType,
    ibPlayerId: row.ibPlayerIdRaw,
    referralPercentage: String(row.referralPercentage),
  });
}

export type PlayerImportProgress = {
  totalRows: number;
  processedRows: number;
  successRows: number;
  failedRows: number;
  skippedRows: number;
};

type ParsedImportPayload = {
  parsedRows: ParsedImportRow[];
  skipped: number;
  totalRows: number;
  errorSample: ImportRowError[];
};

function throwImportValidation(message: string, errors: ImportRowError[]): never {
  throw new AppError("validation_error", message, 400, { errors });
}

function readRowsFromBuffer(buffer: Buffer, originalName: string): Record<string, unknown>[] {
  const lower = originalName.toLowerCase();
  const wb = xlsx.read(buffer, { type: "buffer", raw: false });
  const sheetName = wb.SheetNames[0];
  if (!sheetName) {
    if (lower.endsWith(".csv")) {
      throw new AppError("validation_error", "CSV file is empty", 400);
    }
    throw new AppError("validation_error", "Spreadsheet has no sheets", 400);
  }
  if (!lower.endsWith(".csv") && !lower.endsWith(".xlsx") && !lower.endsWith(".xls")) {
    throw new AppError("validation_error", "Unsupported file type. Use .csv, .xlsx, or .xls", 400);
  }
  return sheetRowsToObjects(wb.Sheets[sheetName]);
}

function chunkArray<T>(arr: T[], size: number): T[][] {
  if (size <= 0) return [arr];
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

async function resolveExchangeMapByName(names: string[]): Promise<Map<string, Types.ObjectId>> {
  if (names.length === 0) return new Map();
  const uniqueByLower = new Map<string, string>();
  for (const rawName of names) {
    const normalized = rawName.trim().toLowerCase();
    if (!normalized || uniqueByLower.has(normalized)) continue;
    uniqueByLower.set(normalized, rawName.trim());
  }
  const uniqueNames = Array.from(uniqueByLower.values());
  const conditions = uniqueNames.map((name) => ({ name: { $regex: new RegExp(`^${escapeRegex(name)}$`, "i") } }));
  const exchanges = await ExchangeModel.find({ $or: conditions }).select("_id name").lean();

  const bucket = new Map<string, Types.ObjectId[]>();
  for (const ex of exchanges) {
    const key = String(ex.name).trim().toLowerCase();
    const list = bucket.get(key) ?? [];
    list.push(ex._id as Types.ObjectId);
    bucket.set(key, list);
  }

  const resolved = new Map<string, Types.ObjectId>();
  for (const [k, list] of bucket.entries()) {
    if (list.length === 1) resolved.set(k, list[0]);
  }
  return resolved;
}

async function resolveIbMapByExchangeAndPlayerId(
  pairs: Array<{ exchangeId: Types.ObjectId; ibPlayerId: string }>,
): Promise<Map<string, Types.ObjectId>> {
  if (pairs.length === 0) return new Map();

  const uniquePairs = new Map<string, { exchangeId: Types.ObjectId; ibPlayerId: string }>();
  for (const pair of pairs) {
    const ibPlayerId = pair.ibPlayerId.trim();
    if (!ibPlayerId) continue;
    const key = `${pair.exchangeId.toString()}:${ibPlayerId.toLowerCase()}`;
    if (!uniquePairs.has(key)) {
      uniquePairs.set(key, { exchangeId: pair.exchangeId, ibPlayerId });
    }
  }

  const orConditions = Array.from(uniquePairs.values()).map((pair) => ({
    exchange: pair.exchangeId,
    playerId: pair.ibPlayerId,
    userType: "ib" as const,
  }));
  if (orConditions.length === 0) return new Map();

  const players = await PlayerModel.find({ $or: orConditions }).select("_id exchange playerId userType").lean();
  const resolved = new Map<string, Types.ObjectId>();
  for (const doc of players) {
    if (doc.userType !== "ib") continue;
    const key = `${(doc.exchange as Types.ObjectId).toString()}:${String(doc.playerId).trim().toLowerCase()}`;
    resolved.set(key, doc._id as Types.ObjectId);
  }
  return resolved;
}

export async function parsePlayerImportFile(
  buffer: Buffer,
  originalName: string,
): Promise<ParsedImportPayload> {
  const rows = readRowsFromBuffer(buffer, originalName);
  const errors: ImportRowError[] = [];
  let skipped = 0;
  const parsedRows: ParsedImportRow[] = [];
  const exchangeNames: string[] = [];
  const rowInputCache: Array<{
    rowNum: number;
    exchangeName: string;
    playerId: string;
    phone: string;
    emailRaw: string;
    userTypeRaw: string;
    ibPlayerIdRaw: string;
    referralPercentageRaw: string;
    rowData: ImportErrorRowData;
  }> = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const rowNum = i + 2;
    const exchangeName = pickCell(
      row,
      PLAYER_IMPORT_CSV_COLUMNS.exchange,
      "exchange_name",
      "exchange",
      "exchange name",
    );
    const playerId = pickCell(
      row,
      PLAYER_IMPORT_CSV_COLUMNS.traderId,
      "player_id",
      "playerid",
      "player id",
      "trader id",
      "trader wallet id",
    );
    const phone = pickCell(
      row,
      PLAYER_IMPORT_CSV_COLUMNS.phoneNumber,
      "phone",
      "phone_number",
      "phone number",
      "mobile",
    );
    const emailRaw = pickCellRaw(
      row,
      PLAYER_IMPORT_CSV_COLUMNS.emailId,
      "email",
      "email id",
      "email_id",
    );
    const userTypeRaw = pickCellRaw(
      row,
      PLAYER_IMPORT_CSV_COLUMNS.userType,
      "user_type",
      "userType",
      "user type",
      "type",
    );
    const ibPlayerIdRaw = pickCellRaw(
      row,
      PLAYER_IMPORT_CSV_COLUMNS.ib,
      "ib_player_id",
      "ib id",
      "ib_player",
      "ib trader id",
      "ib trader wallet id",
    );
    const referralPercentageRaw = pickCellRaw(
      row,
      PLAYER_IMPORT_CSV_COLUMNS.referralPercentageForIb,
      "referral_percentage",
      "referral %",
      "referral percent",
      "referral_percentage_for_ib",
      "referral percentage for ib",
    );
    const rowData = makeImportRowData({
      exchangeName,
      playerId,
      phone,
      email: emailRaw,
      userType: userTypeRaw,
      ibPlayerId: ibPlayerIdRaw,
      referralPercentage: referralPercentageRaw,
    });

    if (!exchangeName && !playerId && !phone) {
      skipped += 1;
      continue;
    }

    if (!exchangeName) {
      errors.push(
        buildImportError(rowNum, `${PLAYER_IMPORT_CSV_COLUMNS.exchange} is required`, rowData),
      );
      continue;
    }
    if (!playerId) {
      errors.push(
        buildImportError(rowNum, `${PLAYER_IMPORT_CSV_COLUMNS.traderId} is required`, rowData),
      );
      continue;
    }
    if (!phone) {
      errors.push(
        buildImportError(rowNum, `${PLAYER_IMPORT_CSV_COLUMNS.phoneNumber} is required`, rowData),
      );
      continue;
    }

    exchangeNames.push(exchangeName);
    rowInputCache.push({
      rowNum,
      exchangeName,
      playerId,
      phone,
      emailRaw,
      userTypeRaw,
      ibPlayerIdRaw,
      referralPercentageRaw,
      rowData,
    });
  }

  const exchangeMap = await resolveExchangeMapByName(exchangeNames);
  const exchangeResolvedRows: Array<{
    rowNum: number;
    exchangeName: string;
    exchangeId: Types.ObjectId;
    playerId: string;
    phone: string;
    email?: string;
    userType: "trader" | "ib";
    ibPlayerIdRaw: string;
    referralPercentage: number;
    rowData: ImportErrorRowData;
  }> = [];

  for (const row of rowInputCache) {
    const exchangeKey = row.exchangeName.trim().toLowerCase();
    const exchangeId = exchangeMap.get(exchangeKey);
    if (!exchangeId) {
      const resolved = await resolveExchangeIdByName(row.exchangeName);
      if (resolved.notFound) {
        errors.push(buildImportError(row.rowNum, `No exchange found for name "${row.exchangeName}"`, row.rowData));
      } else if (resolved.ambiguous) {
        errors.push(
          buildImportError(
            row.rowNum,
            `Multiple exchanges match "${row.exchangeName}"; names must be unique for import`,
            row.rowData,
          ),
        );
      }
      continue;
    }

    const emailParsed = parseEmailCell(row.emailRaw, row.rowNum, row.rowData);
    if (!emailParsed.ok) {
      errors.push(emailParsed.error);
      continue;
    }
    const userTypeParsed = parseUserTypeCell(row.userTypeRaw, row.rowNum, row.rowData);
    if (!userTypeParsed.ok) {
      errors.push(userTypeParsed.error);
      continue;
    }
    const referralPercentageParsed = parsePercentageCell(
      row.referralPercentageRaw,
      row.rowNum,
      PLAYER_IMPORT_CSV_COLUMNS.referralPercentageForIb,
      row.rowData,
    );
    if (!referralPercentageParsed.ok) {
      errors.push(referralPercentageParsed.error);
      continue;
    }

    const ibPlayerIdTrimmed = row.ibPlayerIdRaw.trim();
    if (userTypeParsed.value === "ib" && ibPlayerIdTrimmed) {
      errors.push(
        buildImportError(
          row.rowNum,
          `${PLAYER_IMPORT_CSV_COLUMNS.ib} cannot be set when ${PLAYER_IMPORT_CSV_COLUMNS.userType} is ib`,
          row.rowData,
        ),
      );
      continue;
    }
    if (ibPlayerIdTrimmed && ibPlayerIdTrimmed.toLowerCase() === row.playerId.trim().toLowerCase()) {
      errors.push(
        buildImportError(
          row.rowNum,
          `${PLAYER_IMPORT_CSV_COLUMNS.ib} cannot be the same as ${PLAYER_IMPORT_CSV_COLUMNS.traderId}`,
          row.rowData,
        ),
      );
      continue;
    }

    exchangeResolvedRows.push({
      rowNum: row.rowNum,
      exchangeName: row.exchangeName,
      exchangeId,
      playerId: row.playerId,
      phone: row.phone,
      email: emailParsed.value,
      userType: userTypeParsed.value,
      ibPlayerIdRaw: ibPlayerIdTrimmed,
      referralPercentage: referralPercentageParsed.value,
      rowData: row.rowData,
    });
  }

  const ibPairs = exchangeResolvedRows
    .filter((row) => row.ibPlayerIdRaw)
    .map((row) => ({ exchangeId: row.exchangeId, ibPlayerId: row.ibPlayerIdRaw }));
  const ibMap = await resolveIbMapByExchangeAndPlayerId(ibPairs);

  for (const row of exchangeResolvedRows) {
    let referredByPlayerId: Types.ObjectId | undefined;
    if (row.ibPlayerIdRaw) {
      const ibKey = `${row.exchangeId.toString()}:${row.ibPlayerIdRaw.toLowerCase()}`;
      referredByPlayerId = ibMap.get(ibKey);
      if (!referredByPlayerId) {
        errors.push(
          buildImportError(
            row.rowNum,
            `No ${PLAYER_IMPORT_CSV_COLUMNS.ib} found for "${row.ibPlayerIdRaw}" on ${PLAYER_IMPORT_CSV_COLUMNS.exchange} "${row.exchangeName}"`,
            row.rowData,
          ),
        );
        continue;
      }
    }

    parsedRows.push({
      rowNum: row.rowNum,
      exchangeName: row.exchangeName,
      exchangeId: row.exchangeId,
      playerId: row.playerId,
      phone: row.phone,
      email: row.email,
      userType: row.userType,
      referredByPlayerId,
      referralPercentage: row.referralPercentage,
      ibPlayerIdRaw: row.ibPlayerIdRaw,
    });
  }

  const seenFirstRow = new Map<string, number>();
  for (const p of parsedRows) {
    const key = `${p.exchangeId.toString()}:${p.playerId}`;
    const first = seenFirstRow.get(key);
    if (first !== undefined) {
      errors.push({
        row: p.rowNum,
        message: `Duplicate ${PLAYER_IMPORT_CSV_COLUMNS.traderId} "${p.playerId}" for this ${PLAYER_IMPORT_CSV_COLUMNS.exchange} (same as row ${first})`,
        reason: `Duplicate ${PLAYER_IMPORT_CSV_COLUMNS.traderId} "${p.playerId}" for this ${PLAYER_IMPORT_CSV_COLUMNS.exchange} (same as row ${first})`,
        rowData: parsedImportRowToErrorData(p),
      });
    } else {
      seenFirstRow.set(key, p.rowNum);
    }
  }

  if (errors.length > 0) {
    throwImportValidation("Import failed — no rows were imported. Fix the issues below and try again.", errors);
  }
  if (parsedRows.length === 0) {
    throw new AppError(
      "validation_error",
      `No data rows to import. Add at least one row with ${PLAYER_IMPORT_CSV_COLUMNS.exchange}, ${PLAYER_IMPORT_CSV_COLUMNS.traderId}, and ${PLAYER_IMPORT_CSV_COLUMNS.phoneNumber}.`,
      400,
    );
  }

  return { parsedRows, skipped, totalRows: rows.length, errorSample: [] };
}

export async function applyPlayerImportRows(
  parsedRows: ParsedImportRow[],
  actorId: string,
  options?: {
    chunkSize?: number;
    skippedRows?: number;
    onProgress?: (progress: PlayerImportProgress) => Promise<void> | void;
  },
): Promise<{
  created: number;
  updated: number;
  skipped: number;
}> {
  const actorOid = new Types.ObjectId(actorId);
  const chunkSize = options?.chunkSize ?? 750;
  let created = 0;
  let updated = 0;
  let processedRows = 0;
  const totalRows = parsedRows.length + (options?.skippedRows ?? 0);
  const skipped = options?.skippedRows ?? 0;
  const chunks = chunkArray(parsedRows, chunkSize);

  for (const chunk of chunks) {
    const orConditions = chunk.map((p) => ({
      exchange: p.exchangeId,
      playerId: p.playerId,
    }));
    const existing = await PlayerModel.find({ $or: orConditions }).select("_id exchange playerId").lean();
    const existingByKey = new Map<string, Types.ObjectId>();
    for (const doc of existing) {
      const exId = (doc.exchange as Types.ObjectId).toString();
      existingByKey.set(`${exId}:${doc.playerId}`, doc._id as Types.ObjectId);
    }

    const docsToCreate = chunk
      .filter((p) => !existingByKey.has(`${p.exchangeId.toString()}:${p.playerId}`))
      .map((p) => ({
        exchange: p.exchangeId,
        playerId: p.playerId,
        phone: p.phone,
        ...(p.email ? { email: p.email } : {}),
        userType: p.userType,
        regularBonusPercentage: 0,
        firstDepositBonusPercentage: 0,
        ...(p.referredByPlayerId ? { referredByPlayerId: p.referredByPlayerId } : {}),
        referralPercentage: p.referralPercentage,
        isMigratedOldUser: false,
        createdBy: actorOid,
        updatedBy: actorOid,
      }));

    const updateOps = chunk
      .map((p) => {
        const key = `${p.exchangeId.toString()}:${p.playerId}`;
        const existingId = existingByKey.get(key);
        if (!existingId) return null;

        const setFields: Record<string, unknown> = {
          phone: p.phone,
          userType: p.userType,
          referralPercentage: p.referralPercentage,
          updatedBy: actorOid,
        };
        if (p.email) {
          setFields.email = p.email;
        }
        if (p.referredByPlayerId) {
          setFields.referredByPlayerId = p.referredByPlayerId;
        }

        const unsetFields: Record<string, ""> = {};
        if (!p.email) {
          unsetFields.email = "";
        }
        if (!p.referredByPlayerId) {
          unsetFields.referredByPlayerId = "";
        }

        return {
          updateOne: {
            filter: { _id: existingId },
            update: {
              $set: setFields,
              ...(Object.keys(unsetFields).length > 0 ? { $unset: unsetFields } : {}),
            },
          },
        };
      })
      .filter((op): op is NonNullable<typeof op> => op !== null);

    if (docsToCreate.length > 0) {
      await PlayerModel.insertMany(docsToCreate, { ordered: false });
      created += docsToCreate.length;
    }
    if (updateOps.length > 0) {
      await PlayerModel.bulkWrite(updateOps, { ordered: false });
      updated += updateOps.length;
    }

    processedRows += chunk.length;
    if (options?.onProgress) {
      await options.onProgress({
        totalRows,
        processedRows: processedRows + skipped,
        successRows: created + updated,
        failedRows: 0,
        skippedRows: skipped,
      });
    }
  }

  return { created, updated, skipped };
}

export async function importPlayersFromFile(
  buffer: Buffer,
  originalName: string,
  actorId: string,
  requestId?: string,
): Promise<{
  created: number;
  updated: number;
  skipped: number;
}> {
  const { parsedRows, skipped } = await parsePlayerImportFile(buffer, originalName);
  const { created, updated } = await applyPlayerImportRows(parsedRows, actorId, { skippedRows: skipped });

  await createAuditLog({
    actorId,
    action: "player.import",
    entity: "player",
    entityId: "bulk",
    newValue: {
      created,
      updated,
      skipped,
      fileName: originalName,
    },
    requestId,
  });

  return { created, updated, skipped };
}
