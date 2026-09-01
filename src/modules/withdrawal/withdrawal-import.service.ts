import { Types } from "mongoose";
import xlsx from "xlsx";
import { AppError } from "../../shared/errors/AppError";
import { createAuditLog } from "../audit/audit.service";
import { BankModel } from "../bank/bank.model";
import { bankDisplayName as formatBankDisplayName } from "../bank/bank.constants";
import { DepositModel } from "../deposit/deposit.model";
import {
  buildBankResolutionCache,
  buildExchangePlayerResolutionCache,
  buildPersonResolutionCache,
  loadBanksForImportIdentifiers,
  loadLiabilityPersonsForImportNames,
  loadPlayersForImportPlayerIds,
} from "../deposit/deposit-import-resolve";
import { LiabilityPersonModel } from "../liability/liability-person.model";
import { PlayerModel } from "../player/player.model";
import { emitApprovalQueueEvent } from "../approval/approval-queue-events";
import { chunkArray } from "../../shared/utils/chunkArray";
import {
  formatImportDateTimeForDisplay,
  importPickRaw,
  isImportDateTimePresent,
  parseImportDateTime,
} from "../../shared/utils/importDateTime";
import { DEFAULT_TIMEZONE } from "../../shared/utils/timezone";
import { logger } from "../../shared/logger";
import { normalizeUtr } from "../../shared/utils/utr";
import { WithdrawalModel } from "./withdrawal.model";

export const WITHDRAWAL_IMPORT_CHUNK_SIZE = 100;

export type WithdrawalImportValidRow = {
  row: number;
  playerMongoId: string;
  playerIdLabel?: string;
  accountNumber: string;
  accountHolderName: string;
  bankName: string;
  ifsc: string;
  amount: number;
  reverseBonus: number;
  payableAmount: number;
  requestedAt?: string;
  payoutUtr?: string;
  payoutSettlementType?: "bank" | "person";
  payoutBankId?: string;
  payoutBankDisplayLabel?: string;
  payoutLiabilityPersonId?: string;
  payoutLiabilityPersonName?: string;
};

export type WithdrawalImportInvalidRow = {
  row: number;
  dateTime: string;
  playerId: string;
  accountNumber: string;
  accountHolderName: string;
  bankName: string;
  ifsc: string;
  amount: string;
  reverseBonus: string;
  payoutUtr: string;
  payoutSettlementType: string;
  payoutBank: string;
  payoutLiablePersonName: string;
  errors: string[];
};

export type WithdrawalImportValidationResult = {
  summary: { total: number; valid: number; invalid: number; skipped: number };
  validRows: WithdrawalImportValidRow[];
  invalidRows: WithdrawalImportInvalidRow[];
};

export type WithdrawalImportCommitRow = {
  playerMongoId: string;
  accountNumber: string;
  accountHolderName: string;
  bankName: string;
  ifsc: string;
  amount: number;
  reverseBonus: number;
  requestedAt?: string;
  payoutUtr?: string;
  payoutSettlementType?: "bank" | "person";
  payoutBankId?: string;
  payoutLiabilityPersonId?: string;
};

export type WithdrawalImportCommitProgress = {
  totalRows: number;
  processedRows: number;
  created: number;
  errors: Array<{ row: number; utr: string; error: string }>;
};

function payableFromAmounts(amount: number, reverseBonus: number): number {
  const raw = amount - reverseBonus;
  return Math.max(0, Math.round(raw));
}

function bankDisplayName(b: { holderName: string; bankName: string; accountNumber: string }): string {
  return formatBankDisplayName(b);
}

function parseBusinessDateTime(value: string | undefined, fieldName: string): Date {
  if (!value) return new Date();
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new AppError("validation_error", `${fieldName} must be a valid datetime`, 400);
  }
  return parsed;
}

function withdrawalImportNormalizeHeaderKey(raw: string): string {
  return String(raw).trim().toLowerCase().replace(/[^a-z0-9]/g, "");
}

function withdrawalImportPickCell(row: Record<string, unknown>, ...aliases: string[]): string {
  const wanted = new Set(aliases.map((a) => withdrawalImportNormalizeHeaderKey(a)));
  for (const [key, val] of Object.entries(row)) {
    if (!wanted.has(withdrawalImportNormalizeHeaderKey(key))) continue;
    if (val != null && String(val).trim() !== "") return String(val).trim();
  }
  return "";
}

function withdrawalImportReadRows(
  buffer: Buffer,
  originalName: string,
): { rawRows: Record<string, unknown>[]; textRows: Record<string, unknown>[] } {
  const lower = originalName.toLowerCase();
  if (!lower.endsWith(".csv") && !lower.endsWith(".xlsx") && !lower.endsWith(".xls")) {
    throw new AppError("validation_error", "Unsupported file type. Use .csv, .xlsx, or .xls", 400);
  }
  const wb = xlsx.read(buffer, { type: "buffer", cellDates: false });
  const sheetName = wb.SheetNames[0];
  if (!sheetName) {
    throw new AppError("validation_error", "File is empty or has no sheets", 400);
  }
  const sheet = wb.Sheets[sheetName];
  const rawRows = xlsx.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: "", raw: true });
  const textRows = xlsx.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: "", raw: false });
  return { rawRows, textRows };
}

const WITHDRAWAL_IMPORT_INVALID_DATE_MESSAGE =
  "Invalid date/time. Use DD/MM/YYYY HH:mm (or upload as-is from Excel); seconds and AM/PM are accepted.";

const IMPORT_SCI_NOTATION_REGEX = /^[+-]?\d+(?:\.\d+)?[eE][+-]?\d+$/;

function normalizeImportAccountLikeValue(value: string, fieldName: string): {
  value: string;
  notationError?: string;
} {
  const trimmed = value.trim();
  if (!trimmed) return { value: "" };
  if (IMPORT_SCI_NOTATION_REGEX.test(trimmed)) {
    return {
      value: trimmed,
      notationError: `${fieldName} must be provided as full digits, not scientific notation (E+).`,
    };
  }
  return { value: trimmed };
}

function debugImportLog(payload: {
  runId: string;
  hypothesisId: string;
  location: string;
  message: string;
  data: Record<string, unknown>;
}) {
  // #region agent log
  fetch("http://127.0.0.1:7851/ingest/493287c9-0e60-4d99-b939-fc9c5e98db8e", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "146f82" },
    body: JSON.stringify({
      sessionId: "146f82",
      runId: payload.runId,
      hypothesisId: payload.hypothesisId,
      location: payload.location,
      message: payload.message,
      data: payload.data,
      timestamp: Date.now(),
    }),
  }).catch(() => {});
  // #endregion
}

function withdrawalQuoteCsvVal(value: string): string {
  if (!value) return "";
  if (value.includes(",") || value.includes('"') || value.includes("\n")) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

export async function validateWithdrawalImportRows(
  buffer: Buffer,
  originalName: string,
  options?: { timeZone?: string },
): Promise<WithdrawalImportValidationResult> {
  const importTimeZone = options?.timeZone ?? DEFAULT_TIMEZONE;
  const { rawRows, textRows } = withdrawalImportReadRows(buffer, originalName);
  if (rawRows.length === 0) {
    throw new AppError("validation_error", "File contains no data rows", 400);
  }
  if (rawRows.length > 10000) {
    throw new AppError("validation_error", "Maximum 10000 rows allowed per import", 400);
  }

  const validRows: WithdrawalImportValidRow[] = [];
  const invalidRows: WithdrawalImportInvalidRow[] = [];
  let skipped = 0;

  const allPlayerIds: string[] = [];
  const allPayoutBankIdentifiers: string[] = [];
  const allPayoutPersonNames: string[] = [];
  const rowDataList: Array<{
    rowNum: number;
    dateTimeValue: unknown;
    playerIdRaw: string;
    accountNumberRaw: string;
    accountNumber: string;
    accountNumberNotationError?: string;
    accountHolderName: string;
    bankName: string;
    ifsc: string;
    amountRaw: string;
    reverseBonusRaw: string;
    payoutUtr: string;
    payoutSettlementType: string;
    payoutBankIdentifierRaw: string;
    payoutBankIdentifier: string;
    payoutBankNotationError?: string;
    payoutPersonName: string;
  }> = [];

  for (let i = 0; i < rawRows.length; i++) {
    const row = rawRows[i];
    const textRow = textRows[i] ?? {};
    const rowNum = i + 2;
    const runId = "withdrawalSciNotation";
    const rowPayoutUtrRaw = withdrawalImportPickCell(row, "payout utr", "payoututr", "payout_utr", "utr");
    const rowUtrKey = rowPayoutUtrRaw || `row-${rowNum}`;
    const accountRawDirect = importPickRaw(
      row,
      "account number",
      "accountnumber",
      "account_number",
      "acc no",
      "accno",
    );
    if (i < 8) {
      debugImportLog({
        runId,
        hypothesisId: "H1",
        location: "withdrawal-import.service.ts:row-extract",
        message: "Raw account cell read",
        data: {
          rowNum,
          rowUtrKey,
          rawType: accountRawDirect == null ? "nullish" : typeof accountRawDirect,
          rawString: accountRawDirect == null ? "" : String(accountRawDirect),
        },
      });
    }
    const playerIdRaw = withdrawalImportPickCell(row, "player id", "playerid", "player_id", "player");
    const accountNumberRaw = withdrawalImportPickCell(
      row,
      "account number",
      "accountnumber",
      "account_number",
      "acc no",
      "accno",
    );
    const normalizedAccountNumber = normalizeImportAccountLikeValue(accountNumberRaw, "Account Number");
    const accountNumberTextValue = withdrawalImportPickCell(
      textRow,
      "account number",
      "accountnumber",
      "account_number",
      "acc no",
      "accno",
    );
    const accountDisplayScientific = IMPORT_SCI_NOTATION_REGEX.test(accountNumberTextValue.trim());
    if (i < 8) {
      debugImportLog({
        runId,
        hypothesisId: "H2",
        location: "withdrawal-import.service.ts:account-normalize",
        message: "Account normalization output",
        data: {
          rowNum,
          rowUtrKey,
          accountNumberRaw,
          normalizedValue: normalizedAccountNumber.value,
          notationError: normalizedAccountNumber.notationError ?? "",
          wasScientificToken: IMPORT_SCI_NOTATION_REGEX.test(accountNumberRaw.trim()),
          accountTextValue: accountNumberTextValue,
          accountDisplayScientific,
        },
      });
    }
    const accountHolderName = withdrawalImportPickCell(
      row,
      "account holder name",
      "accountholdername",
      "account_holder_name",
      "holder name",
      "holdername",
    );
    const bankName = withdrawalImportPickCell(row, "bank name", "bankname", "bank_name", "destination bank");
    const ifsc = withdrawalImportPickCell(row, "ifsc", "IFSC");
    const amountRaw = withdrawalImportPickCell(row, "amount", "Amount");
    const reverseBonusRaw = withdrawalImportPickCell(row, "reverse bonus", "reversebonus", "reverse_bonus");
    const dateTimeValue = importPickRaw(row, "date time", "datetime", "date_time", "requested_at", "requestedat", "date");
    const payoutUtr = rowPayoutUtrRaw;
    const payoutSettlementType = withdrawalImportPickCell(
      row,
      "payout settlement type",
      "payoutsettlementtype",
      "payout_settlement_type",
      "payout type",
    );
    const payoutBankIdentifierRaw = withdrawalImportPickCell(
      row,
      "payout bank",
      "payoutbank",
      "payout_bank",
      "company bank",
      "companybank",
    );
    const normalizedPayoutBankIdentifier = normalizeImportAccountLikeValue(
      payoutBankIdentifierRaw,
      "Payout Bank",
    );
    const payoutBankTextValue = withdrawalImportPickCell(
      textRow,
      "payout bank",
      "payoutbank",
      "payout_bank",
      "company bank",
      "companybank",
    );
    const payoutBankDisplayScientific = IMPORT_SCI_NOTATION_REGEX.test(payoutBankTextValue.trim());
    const payoutPersonName = withdrawalImportPickCell(
      row,
      "payout liable person name",
      "payoutliablepersonname",
      "payout_liable_person_name",
      "payout person",
      "payoutperson",
      "payout liability person",
    );

    if (
      !playerIdRaw &&
      !accountNumberRaw &&
      !accountHolderName &&
      !bankName &&
      !ifsc &&
      !amountRaw &&
      !payoutUtr
    ) {
      skipped++;
      continue;
    }

    rowDataList.push({
      rowNum,
      dateTimeValue,
      playerIdRaw,
      accountNumberRaw,
      accountNumber: normalizedAccountNumber.value,
      accountNumberNotationError:
        normalizedAccountNumber.notationError ||
        (accountDisplayScientific
          ? "Account Number must be provided as full digits, not scientific notation (E+)."
          : undefined),
      accountHolderName,
      bankName,
      ifsc,
      amountRaw,
      reverseBonusRaw,
      payoutUtr,
      payoutSettlementType,
      payoutBankIdentifierRaw,
      payoutBankIdentifier: normalizedPayoutBankIdentifier.value,
      payoutBankNotationError:
        normalizedPayoutBankIdentifier.notationError ||
        (payoutBankDisplayScientific
          ? "Payout Bank must be provided as full digits/account label, not scientific notation (E+)."
          : undefined),
      payoutPersonName,
    });
    if (playerIdRaw) allPlayerIds.push(playerIdRaw.trim().toLowerCase());
    if (normalizedPayoutBankIdentifier.value) {
      allPayoutBankIdentifiers.push(normalizedPayoutBankIdentifier.value.trim().toLowerCase());
    }
    if (payoutPersonName) allPayoutPersonNames.push(payoutPersonName.trim().toLowerCase());
  }

  const uniquePlayerIds = [...new Set(allPlayerIds)];
  const uniquePayoutBankIdentifiers = [...new Set(allPayoutBankIdentifiers)];
  const uniquePayoutPersonNames = [...new Set(allPayoutPersonNames)];

  const bankMaps = await loadBanksForImportIdentifiers(uniquePayoutBankIdentifiers);
  const payoutPersonMap = await loadLiabilityPersonsForImportNames(uniquePayoutPersonNames);
  const exchangePlayerMap = await loadPlayersForImportPlayerIds(uniquePlayerIds);

  const payoutBankResolutionCache = buildBankResolutionCache(uniquePayoutBankIdentifiers, bankMaps);
  const payoutPersonResolutionCache = buildPersonResolutionCache(uniquePayoutPersonNames, payoutPersonMap);
  const exchangePlayerResolutionCache = buildExchangePlayerResolutionCache(uniquePlayerIds, exchangePlayerMap);

  const seenPayoutUtrs = new Set<string>();
  const payoutUtrChecks = rowDataList.map((r) => r.payoutUtr).filter(Boolean);
  const existingPayoutUtrConflicts = new Set<string>();
  if (payoutUtrChecks.length > 0) {
    const normalizedUtrs = [...new Set(payoutUtrChecks.map((u) => normalizeUtr(u)))];
    const [depConflicts, wdConflicts] = await Promise.all([
      DepositModel.find({
        utr: { $in: normalizedUtrs },
        status: { $ne: "rejected" },
      })
        .select({ utr: 1 })
        .lean(),
      WithdrawalModel.find({
        utr: { $in: normalizedUtrs },
        status: { $ne: "rejected" },
      })
        .select({ utr: 1 })
        .lean(),
    ]);
    for (const d of depConflicts) existingPayoutUtrConflicts.add(normalizeUtr(d.utr));
    for (const w of wdConflicts) if (w.utr) existingPayoutUtrConflicts.add(normalizeUtr(w.utr));
  }

  for (const rd of rowDataList) {
    const rowErrors: string[] = [];

    if (!rd.playerIdRaw) rowErrors.push("Player Id is required");
    if (rd.accountNumberNotationError) rowErrors.push(rd.accountNumberNotationError);
    if (!rd.accountNumber) rowErrors.push("Account Number is required");
    else if (rd.accountNumber.length > 40) rowErrors.push("Account Number must not exceed 40 characters");
    if (!rd.accountHolderName) rowErrors.push("Account Holder Name is required");
    else if (rd.accountHolderName.length > 120) rowErrors.push("Account Holder Name must not exceed 120 characters");
    if (!rd.bankName) rowErrors.push("Bank Name is required");
    else if (rd.bankName.length > 120) rowErrors.push("Bank Name must not exceed 120 characters");
    if (!rd.ifsc) rowErrors.push("IFSC is required");
    else if (rd.ifsc.length < 4 || rd.ifsc.length > 20) rowErrors.push("IFSC must be 4–20 characters");

    const amt = Number(rd.amountRaw);
    if (!rd.amountRaw) rowErrors.push("Amount is required");
    else if (Number.isNaN(amt) || amt < 1) rowErrors.push("Amount must be a number >= 1");
    else if (!Number.isInteger(amt)) rowErrors.push("Amount must be a whole number (no decimals)");

    let reverseBonus = 0;
    if (rd.reverseBonusRaw.trim() !== "") {
      const rb = Number(rd.reverseBonusRaw);
      if (Number.isNaN(rb) || rb < 0) rowErrors.push("Reverse Bonus must be a whole number >= 0");
      else if (!Number.isInteger(rb)) rowErrors.push("Reverse Bonus must be a whole number (no decimals)");
      else reverseBonus = rb;
    }

    let parsedDate: Date | null = null;
    if (isImportDateTimePresent(rd.dateTimeValue)) {
      parsedDate = parseImportDateTime(rd.dateTimeValue, importTimeZone);
      if (!parsedDate) rowErrors.push(WITHDRAWAL_IMPORT_INVALID_DATE_MESSAGE);
    }

    let resolvedPlayerMongoId: string | undefined;
    let resolvedPlayerIdLabel: string | undefined;
    if (rd.playerIdRaw) {
      const playerKey = rd.playerIdRaw.trim().toLowerCase();
      const playerResult = exchangePlayerResolutionCache.get(playerKey);
      if (playerResult?.status === "ambiguous") {
        rowErrors.push(
          `Multiple players found with Player Id "${rd.playerIdRaw}". Player Id must be unique across exchanges in this file.`,
        );
      } else if (!playerResult || playerResult.status === "not_found") {
        rowErrors.push(`Player "${rd.playerIdRaw}" not found`);
      } else {
        resolvedPlayerMongoId = playerResult.id;
        resolvedPlayerIdLabel = playerResult.playerIdLabel;
      }
    }

    const hasPayoutUtr = rd.payoutUtr.trim() !== "";
    const hasPayoutBank = rd.payoutBankIdentifier.trim() !== "";
    const hasPayoutPerson = rd.payoutPersonName.trim() !== "";
    const payoutMode = rd.payoutSettlementType.toLowerCase() === "person" ? "person" : "bank";

    let resolvedPayoutBankId: string | undefined;
    let resolvedPayoutBankDisplay: string | undefined;
    let resolvedPayoutPersonId: string | undefined;
    let resolvedPayoutPersonName: string | undefined;
    let resolvedPayoutUtr: string | undefined;

    // Single-stage: payout details required on every import row.
    if (!hasPayoutUtr) rowErrors.push("Payout UTR is required");
    else if (rd.payoutUtr.length < 4) rowErrors.push("Payout UTR must be at least 4 characters");
    else if (rd.payoutUtr.length > 120) rowErrors.push("Payout UTR must not exceed 120 characters");
    else {
      const normalized = normalizeUtr(rd.payoutUtr);
      if (existingPayoutUtrConflicts.has(normalized)) {
        rowErrors.push("Payout UTR already exists in another transaction");
      } else if (seenPayoutUtrs.has(normalized)) {
        rowErrors.push("Duplicate Payout UTR within this file");
      } else {
        seenPayoutUtrs.add(normalized);
        resolvedPayoutUtr = normalized;
      }
    }

    if (payoutMode === "bank") {
      if (rd.payoutBankNotationError) rowErrors.push(rd.payoutBankNotationError);
      if (!hasPayoutBank) rowErrors.push("Payout Bank is required for Bank payout settlement");
      else {
        const key = rd.payoutBankIdentifier.trim().toLowerCase();
        const bankResult = payoutBankResolutionCache.get(key);
        if (bankResult?.status === "ambiguous") {
          rowErrors.push(
            `Multiple banks found with holder name "${rd.payoutBankIdentifier}". Use account number instead.`,
          );
        } else if (!bankResult || bankResult.status === "not_found") {
          rowErrors.push(`Payout bank "${rd.payoutBankIdentifier}" not found (tried account number and holder name)`);
        } else if (bankResult.status === "inactive") {
          rowErrors.push(`Payout bank "${bankResult.displayName}" is not active`);
        } else {
          resolvedPayoutBankId = bankResult.id;
          resolvedPayoutBankDisplay = bankResult.displayName;
        }
      }
    } else if (!hasPayoutPerson) {
      rowErrors.push("Payout Liable Person Name is required for Person payout settlement");
    } else {
      const key = rd.payoutPersonName.trim().toLowerCase();
      const personResult = payoutPersonResolutionCache.get(key);
      if (!personResult || personResult.status === "not_found") {
        rowErrors.push(`Payout liability person "${rd.payoutPersonName}" not found`);
      } else if (personResult.status === "inactive") {
        rowErrors.push(`Payout liability person "${personResult.name}" is inactive`);
      } else {
        resolvedPayoutPersonId = personResult.id;
        resolvedPayoutPersonName = personResult.name;
      }
    }

    if (rowErrors.length > 0) {
      if (rd.accountNumberNotationError && (rd.payoutUtr || rd.rowNum <= 8)) {
        debugImportLog({
          runId: "withdrawalSciNotation",
          hypothesisId: "H3",
          location: "withdrawal-import.service.ts:row-invalid",
          message: "Row rejected due to account scientific notation",
          data: {
            rowNum: rd.rowNum,
            payoutUtr: rd.payoutUtr,
            accountNumberRaw: rd.accountNumberRaw,
            notationError: rd.accountNumberNotationError,
          },
        });
      }
      invalidRows.push({
        row: rd.rowNum,
        dateTime: formatImportDateTimeForDisplay(rd.dateTimeValue),
        playerId: rd.playerIdRaw,
        accountNumber: rd.accountNumberRaw,
        accountHolderName: rd.accountHolderName,
        bankName: rd.bankName,
        ifsc: rd.ifsc,
        amount: rd.amountRaw,
        reverseBonus: rd.reverseBonusRaw,
        payoutUtr: rd.payoutUtr,
        payoutSettlementType: rd.payoutSettlementType || "Bank",
        payoutBank: rd.payoutBankIdentifierRaw,
        payoutLiablePersonName: rd.payoutPersonName,
        errors: rowErrors,
      });
    } else {
      if (rd.payoutUtr || rd.rowNum <= 8) {
        debugImportLog({
          runId: "withdrawalSciNotation",
          hypothesisId: "H4",
          location: "withdrawal-import.service.ts:row-valid",
          message: "Row accepted with account number",
          data: {
            rowNum: rd.rowNum,
            payoutUtr: rd.payoutUtr,
            accountNumberStored: rd.accountNumber,
          },
        });
      }
      validRows.push({
        row: rd.rowNum,
        playerMongoId: resolvedPlayerMongoId!,
        playerIdLabel: resolvedPlayerIdLabel,
        accountNumber: rd.accountNumber,
        accountHolderName: rd.accountHolderName,
        bankName: rd.bankName,
        ifsc: rd.ifsc,
        amount: amt,
        reverseBonus,
        payableAmount: payableFromAmounts(amt, reverseBonus),
        requestedAt: parsedDate ? parsedDate.toISOString() : undefined,
        payoutUtr: resolvedPayoutUtr,
        payoutSettlementType: resolvedPayoutUtr ? payoutMode : undefined,
        payoutBankId: resolvedPayoutBankId,
        payoutBankDisplayLabel: resolvedPayoutBankDisplay,
        payoutLiabilityPersonId: resolvedPayoutPersonId,
        payoutLiabilityPersonName: resolvedPayoutPersonName,
      });
    }
  }

  return {
    summary: {
      total: rowDataList.length + skipped,
      valid: validRows.length,
      invalid: invalidRows.length,
      skipped,
    },
    validRows,
    invalidRows,
  };
}

type WithdrawalImportCommitError = { row: number; utr: string; error: string };
type IndexedWithdrawalImportRow = { index: number; row: WithdrawalImportCommitRow };

type BankImportLean = {
  _id: Types.ObjectId;
  holderName: string;
  bankName: string;
  accountNumber: string;
  status: string;
};

type PersonImportLean = {
  _id: Types.ObjectId;
  name: string;
  isActive: boolean;
};

async function loadWithdrawalImportLookups(rows: WithdrawalImportCommitRow[]) {
  const bankIdSet = new Set<string>();
  const personIdSet = new Set<string>();
  const playerIdSet = new Set<string>();
  for (const row of rows) {
    if (row.payoutBankId && Types.ObjectId.isValid(row.payoutBankId)) bankIdSet.add(row.payoutBankId);
    if (row.payoutLiabilityPersonId && Types.ObjectId.isValid(row.payoutLiabilityPersonId)) {
      personIdSet.add(row.payoutLiabilityPersonId);
    }
    if (row.playerMongoId && Types.ObjectId.isValid(row.playerMongoId)) playerIdSet.add(row.playerMongoId);
  }
  const [banks, persons, players] = await Promise.all([
    bankIdSet.size > 0
      ? BankModel.find({ _id: { $in: [...bankIdSet].map((id) => new Types.ObjectId(id)) } })
          .select("holderName bankName accountNumber status")
          .lean()
      : [],
    personIdSet.size > 0
      ? LiabilityPersonModel.find({ _id: { $in: [...personIdSet].map((id) => new Types.ObjectId(id)) } })
          .select("name isActive")
          .lean()
      : [],
    playerIdSet.size > 0
      ? PlayerModel.find({ _id: { $in: [...playerIdSet].map((id) => new Types.ObjectId(id)) } })
          .select("playerId phone")
          .lean()
      : [],
  ]);
  return {
    bankById: new Map(banks.map((b) => [String(b._id), b as BankImportLean])),
    personById: new Map(persons.map((p) => [String(p._id), p as PersonImportLean])),
    playerById: new Map(
      players.map((p) => [
        String(p._id),
        { playerId: p.playerId, phone: p.phone, label: `${p.playerId} · ${p.phone}` },
      ]),
    ),
  };
}

async function findConflictingPayoutUtrsInDb(utrs: string[]): Promise<Set<string>> {
  const normalized = [...new Set(utrs.map((u) => normalizeUtr(u)).filter(Boolean))];
  if (normalized.length === 0) return new Set();
  const [depConflicts, wdConflicts] = await Promise.all([
    DepositModel.find({ utr: { $in: normalized }, status: { $ne: "rejected" } })
      .select({ utr: 1 })
      .lean(),
    WithdrawalModel.find({ utr: { $in: normalized }, status: { $ne: "rejected" } })
      .select({ utr: 1 })
      .lean(),
  ]);
  const conflicts = new Set<string>();
  for (const d of depConflicts) conflicts.add(normalizeUtr(d.utr));
  for (const w of wdConflicts) if (w.utr) conflicts.add(normalizeUtr(w.utr));
  return conflicts;
}

function buildWithdrawalImportInsertDoc(
  row: WithdrawalImportCommitRow,
  actorOid: Types.ObjectId,
  lookups: {
    bankById: Map<string, BankImportLean>;
    personById: Map<string, PersonImportLean>;
    playerById: Map<string, { playerId: string; phone: string; label: string }>;
  },
): Record<string, unknown> | { error: string } {
  const player = lookups.playerById.get(row.playerMongoId);
  if (!player) return { error: "Player not found" };

  const reverseBonus = Math.round(Number(row.reverseBonus ?? 0));
  const payableAmount = payableFromAmounts(row.amount, reverseBonus);

  const base: Record<string, unknown> = {
    player: new Types.ObjectId(row.playerMongoId),
    playerName: player.label,
    accountNumber: row.accountNumber.trim(),
    accountHolderName: row.accountHolderName.trim(),
    bankName: row.bankName.trim(),
    ifsc: row.ifsc.trim(),
    amount: row.amount,
    reverseBonus,
    payableAmount,
    requestedAt: row.requestedAt ? parseBusinessDateTime(row.requestedAt, "requestedAt") : new Date(),
    // Imported rows must remain in requested stage for banker confirmation flow.
    status: "requested",
    createdBy: actorOid,
    amendmentCount: 0,
    amendmentHistory: [],
  };

  if (row.payoutUtr?.trim()) {
    const payoutMode = row.payoutSettlementType ?? "bank";
    base.utr = normalizeUtr(row.payoutUtr);
    base.payoutSettlementType = payoutMode;

    if (payoutMode === "bank") {
      const bankIdStr = row.payoutBankId?.trim();
      if (!bankIdStr) return { error: "Payout bank is required" };
      const bank = lookups.bankById.get(bankIdStr);
      if (!bank) return { error: "Payout bank not found" };
      if (bank.status !== "active") return { error: "Payout bank is not active" };
      base.payoutBankId = new Types.ObjectId(bankIdStr);
      base.payoutBankName = bankDisplayName(bank);
    } else {
      const personIdStr = row.payoutLiabilityPersonId?.trim();
      if (!personIdStr) return { error: "Payout liability person is required" };
      const person = lookups.personById.get(personIdStr);
      if (!person) return { error: "Payout liability person not found" };
      if (!person.isActive) return { error: "Payout liability person is inactive" };
      base.payoutLiabilityPersonId = new Types.ObjectId(personIdStr);
      base.payoutLiabilityPersonName = person.name.trim();
    }
  } else {
    return { error: "Payout UTR is required" };
  }

  return base;
}

function isMongooseBulkWriteError(err: unknown): err is {
  insertedDocs?: unknown[];
  result?: { insertedCount?: number };
  writeErrors?: Array<{ index: number; errmsg?: string; code?: number }>;
} {
  return (
    typeof err === "object" &&
    err !== null &&
    ("writeErrors" in err || "insertedDocs" in err || "result" in err)
  );
}

function withdrawalBulkWriteErrorMessage(writeError: { errmsg?: string; code?: number }): string {
  if (writeError.code === 11000) return "Payout UTR already exists in another transaction";
  return writeError.errmsg || "Insert failed";
}

function withdrawalImportRowIdentifier(row: WithdrawalImportCommitRow): string {
  return row.payoutUtr?.trim() || row.accountNumber?.trim() || row.playerMongoId;
}

export async function applyWithdrawalImportRows(
  rows: WithdrawalImportCommitRow[],
  actorId: string,
  options?: {
    chunkSize?: number;
    onProgress?: (progress: WithdrawalImportCommitProgress) => Promise<void> | void;
  },
): Promise<{ created: number; errors: WithdrawalImportCommitError[]; createdIds: string[] }> {
  const actorOid = new Types.ObjectId(actorId);
  const chunkSize = options?.chunkSize ?? WITHDRAWAL_IMPORT_CHUNK_SIZE;
  const totalRows = rows.length;
  let created = 0;
  const errors: WithdrawalImportCommitError[] = [];
  const createdIds: string[] = [];
  const jobPayoutUtrSet = new Set<string>();

  const indexedRows: IndexedWithdrawalImportRow[] = rows.map((row, index) => ({ index, row }));
  const { bankById, personById, playerById } = await loadWithdrawalImportLookups(rows);
  const chunks = chunkArray(indexedRows, chunkSize);
  let processedRows = 0;

  for (const chunk of chunks) {
    const chunkPayoutUtrs = chunk.map((c) => c.row.payoutUtr).filter(Boolean) as string[];
    const dbConflicts = await findConflictingPayoutUtrsInDb(chunkPayoutUtrs);

    const pendingInserts: Array<{ doc: Record<string, unknown>; item: IndexedWithdrawalImportRow }> = [];

    for (const item of chunk) {
      const payoutUtr = item.row.payoutUtr?.trim();
      if (!payoutUtr) {
        errors.push({
          row: item.index + 1,
          utr: withdrawalImportRowIdentifier(item.row),
          error: "Payout UTR is required",
        });
        continue;
      }
      const normalizedUtr = normalizeUtr(payoutUtr);
      if (dbConflicts.has(normalizedUtr) || jobPayoutUtrSet.has(normalizedUtr)) {
        errors.push({
          row: item.index + 1,
          utr: payoutUtr,
          error: "Payout UTR already exists in another transaction",
        });
        continue;
      }

      const built = buildWithdrawalImportInsertDoc(item.row, actorOid, { bankById, personById, playerById });
      if ("error" in built && typeof built.error === "string") {
        errors.push({
          row: item.index + 1,
          utr: withdrawalImportRowIdentifier(item.row),
          error: built.error,
        });
        continue;
      }

      jobPayoutUtrSet.add(normalizedUtr);
      pendingInserts.push({ doc: built, item });
    }

    if (pendingInserts.length > 0) {
      try {
        const inserted = await WithdrawalModel.insertMany(
          pendingInserts.map((p) => p.doc),
          { ordered: false },
        );
        created += inserted.length;
        for (const doc of inserted) {
          createdIds.push(String(doc._id));
        }
      } catch (err: unknown) {
        if (isMongooseBulkWriteError(err)) {
          const insertedDocs = (err.insertedDocs ?? []) as Array<{ _id?: Types.ObjectId }>;
          const insertedCount = insertedDocs.length || err.result?.insertedCount || 0;
          created += insertedCount;
          for (const doc of insertedDocs) {
            if (doc?._id) createdIds.push(String(doc._id));
          }
          for (const we of err.writeErrors ?? []) {
            const pending = pendingInserts[we.index];
            if (!pending) continue;
            const rowPayoutUtr = pending.item.row.payoutUtr?.trim();
            if (rowPayoutUtr) jobPayoutUtrSet.delete(normalizeUtr(rowPayoutUtr));
            errors.push({
              row: pending.item.index + 1,
              utr: withdrawalImportRowIdentifier(pending.item.row),
              error: withdrawalBulkWriteErrorMessage(we),
            });
          }
        } else {
          for (const pending of pendingInserts) {
            const rowPayoutUtr = pending.item.row.payoutUtr?.trim();
            if (rowPayoutUtr) jobPayoutUtrSet.delete(normalizeUtr(rowPayoutUtr));
            errors.push({
              row: pending.item.index + 1,
              utr: withdrawalImportRowIdentifier(pending.item.row),
              error: err instanceof Error ? err.message : "Unexpected error",
            });
          }
        }
      }
    }

    processedRows += chunk.length;
    if (options?.onProgress) {
      await options.onProgress({ totalRows, processedRows, created, errors });
    }
  }

  return { created, errors, createdIds };
}

function scheduleWithdrawalImportSummaryAudit(payload: {
  actorId: string;
  requestId?: string;
  created: number;
  failed: number;
  totalRows: number;
}): void {
  setImmediate(() => {
    void createAuditLog({
      actorId: payload.actorId,
      action: "withdrawal.import",
      entity: "withdrawal",
      entityId: "bulk",
      newValue: {
        created: payload.created,
        failed: payload.failed,
        totalRows: payload.totalRows,
      },
      requestId: payload.requestId,
    }).catch((err) => {
      logger.warn({ err }, "withdrawal import summary audit failed");
    });
  });
}

export async function commitWithdrawalImportRows(
  rows: WithdrawalImportCommitRow[],
  actorId: string,
  requestId?: string,
  options?: {
    chunkSize?: number;
    onProgress?: (progress: WithdrawalImportCommitProgress) => Promise<void> | void;
  },
): Promise<{ created: number; errors: WithdrawalImportCommitError[] }> {
  const result = await applyWithdrawalImportRows(rows, actorId, {
    chunkSize: options?.chunkSize ?? WITHDRAWAL_IMPORT_CHUNK_SIZE,
    onProgress: options?.onProgress,
  });

  // Single-stage import: settle inserted rows that already have payout UTR + bank/person.
  if (result.createdIds.length > 0) {
    const { bulkBankerApproveWithdrawals } = await import("./withdrawal.service");
    await bulkBankerApproveWithdrawals(result.createdIds, actorId, requestId);
  } else if (result.created > 0) {
    emitApprovalQueueEvent("withdrawal", "banker");
  }

  scheduleWithdrawalImportSummaryAudit({
    actorId,
    requestId,
    created: result.created,
    failed: result.errors.length,
    totalRows: rows.length,
  });

  return { created: result.created, errors: result.errors };
}

const WITHDRAWAL_IMPORT_SAMPLE_COLUMNS = [
  "Date Time",
  "Player Id",
  "Account Number",
  "Account Holder Name",
  "Bank Name",
  "IFSC",
  "Amount",
  "Reverse Bonus",
  "Payout UTR",
  "Payout Settlement Type",
  "Payout Bank",
  "Payout Liable Person Name",
] as const;

export function getWithdrawalImportSampleRows(): Array<Record<string, string>> {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const todayStr = `${pad(now.getDate())}/${pad(now.getMonth() + 1)}/${now.getFullYear()} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
  return [
    {
      "Date Time": todayStr,
      "Player Id": "PLAYER001",
      "Account Number": "123456789012",
      "Account Holder Name": "John Doe",
      "Bank Name": "HDFC Bank",
      IFSC: "HDFC0001234",
      Amount: "5000",
      "Reverse Bonus": "500",
      "Payout UTR": "PAYOUT001ABC",
      "Payout Settlement Type": "Bank",
      "Payout Bank": "1234567890",
      "Payout Liable Person Name": "",
    },
    {
      "Date Time": "",
      "Player Id": "PLAYER002",
      "Account Number": "987654321098",
      "Account Holder Name": "Jane Smith",
      "Bank Name": "ICICI Bank",
      IFSC: "ICIC0005678",
      Amount: "3000",
      "Reverse Bonus": "0",
      "Payout UTR": "PAYOUT002DEF",
      "Payout Settlement Type": "Person",
      "Payout Bank": "",
      "Payout Liable Person Name": "John Doe",
    },
  ];
}

export function buildWithdrawalImportSampleCsv(): Buffer {
  const rows = getWithdrawalImportSampleRows();
  const header = WITHDRAWAL_IMPORT_SAMPLE_COLUMNS.join(",");
  const lines = rows.map((row) => WITHDRAWAL_IMPORT_SAMPLE_COLUMNS.map((col) => row[col] ?? "").join(","));
  return Buffer.from([header, ...lines].join("\n"), "utf-8");
}

export function buildWithdrawalImportSampleXlsx(): Buffer {
  const rows = getWithdrawalImportSampleRows();
  const worksheet = xlsx.utils.json_to_sheet(rows);
  const ref = worksheet["!ref"];
  if (ref) {
    const { e } = xlsx.utils.decode_range(ref);
    for (let rowIndex = 1; rowIndex <= e.r; rowIndex++) {
      const cellRef = xlsx.utils.encode_cell({ r: rowIndex, c: 0 });
      const cell = worksheet[cellRef];
      if (!cell) continue;
      const text = cell.v != null ? String(cell.v) : "";
      worksheet[cellRef] = { t: "s", v: text, w: text, z: "@" };
    }
  }
  const workbook = xlsx.utils.book_new();
  xlsx.utils.book_append_sheet(workbook, worksheet, "Import");
  return xlsx.write(workbook, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

export function buildWithdrawalImportErrorCsv(invalidRows: WithdrawalImportInvalidRow[]): Buffer {
  const header =
    "Row,Date Time,Player Id,Account Number,Account Holder Name,Bank Name,IFSC,Amount,Reverse Bonus,Payout UTR,Payout Settlement Type,Payout Bank,Payout Liable Person Name,Error";
  const lines = [header];
  for (const r of invalidRows) {
    lines.push(
      [
        String(r.row),
        withdrawalQuoteCsvVal(r.dateTime),
        withdrawalQuoteCsvVal(r.playerId),
        withdrawalQuoteCsvVal(r.accountNumber),
        withdrawalQuoteCsvVal(r.accountHolderName),
        withdrawalQuoteCsvVal(r.bankName),
        withdrawalQuoteCsvVal(r.ifsc),
        withdrawalQuoteCsvVal(r.amount),
        withdrawalQuoteCsvVal(r.reverseBonus),
        withdrawalQuoteCsvVal(r.payoutUtr),
        withdrawalQuoteCsvVal(r.payoutSettlementType),
        withdrawalQuoteCsvVal(r.payoutBank),
        withdrawalQuoteCsvVal(r.payoutLiablePersonName),
        withdrawalQuoteCsvVal(r.errors.join("; ")),
      ].join(","),
    );
  }
  return Buffer.from(lines.join("\n"), "utf-8");
}
