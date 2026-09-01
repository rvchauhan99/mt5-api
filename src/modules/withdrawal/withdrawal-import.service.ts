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
import { normalizeUtr, escapeRegex as escapeUtrRegex } from "../../shared/utils/utr";
import { WithdrawalModel } from "./withdrawal.model";
import { resolveMoneyInput } from "../../shared/utils/moneyFx";
import { getCurrencyMinUnit, isSupportedCurrency, type SupportedCurrency } from "../../shared/constants/currencies";
import { requirePlatformCurrency } from "../settings/settings.service";
import { resolveMasterExchangeRate } from "../lookup/exchange-rate-lookup.service";

export const WITHDRAWAL_IMPORT_CHUNK_SIZE = 100;

/** CSV column headers — match Exchange withdrawal form labels. */
export const WITHDRAWAL_IMPORT_CSV_COLUMNS = {
  requestDateTime: "Request date & time",
  traderWalletId: "Trader Wallet Id",
  payoutSettlement: "Payout settlement",
  companyPayoutBank: "Company payout bank",
  liabilityPersonPayingOut: "Liability person paying out",
  referenceNumber: "Reference Number",
  accountNumber: "Account number",
  accountHolderName: "Account holder name",
  bankName: "Bank name",
  ifsc: "IFSC",
  operatedCurrency: "Operated currency",
  withdrawalAmount: "Withdrawal amount",
} as const;

export const WITHDRAWAL_IMPORT_CSV_HEADER_LIST = [
  WITHDRAWAL_IMPORT_CSV_COLUMNS.requestDateTime,
  WITHDRAWAL_IMPORT_CSV_COLUMNS.traderWalletId,
  WITHDRAWAL_IMPORT_CSV_COLUMNS.payoutSettlement,
  WITHDRAWAL_IMPORT_CSV_COLUMNS.companyPayoutBank,
  WITHDRAWAL_IMPORT_CSV_COLUMNS.liabilityPersonPayingOut,
  WITHDRAWAL_IMPORT_CSV_COLUMNS.referenceNumber,
  WITHDRAWAL_IMPORT_CSV_COLUMNS.accountNumber,
  WITHDRAWAL_IMPORT_CSV_COLUMNS.accountHolderName,
  WITHDRAWAL_IMPORT_CSV_COLUMNS.bankName,
  WITHDRAWAL_IMPORT_CSV_COLUMNS.ifsc,
  WITHDRAWAL_IMPORT_CSV_COLUMNS.operatedCurrency,
  WITHDRAWAL_IMPORT_CSV_COLUMNS.withdrawalAmount,
] as const;

export type WithdrawalImportValidRow = {
  row: number;
  playerMongoId: string;
  playerIdLabel?: string;
  accountNumber: string;
  accountHolderName: string;
  bankName: string;
  ifsc: string;
  amount: number;
  operatedCurrency: string;
  operatedAmount: number;
  exchangeRate: number;
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
  operatedCurrency: string;
  withdrawalAmount: string;
  exchangeRate: string;
  platformAmount: string;
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
  operatedCurrency: string;
  operatedAmount: number;
  exchangeRate: number;
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

function parseWithdrawalImportPayoutMode(raw: string): "bank" | "person" {
  const value = raw.trim().toLowerCase();
  if (value === "person" || value === "liability person" || value === "liabilityperson") {
    return "person";
  }
  return "bank";
}

function makeWithdrawalImportInvalidRow(fields: {
  row: number;
  dateTime?: string;
  playerId?: string;
  accountNumber?: string;
  accountHolderName?: string;
  bankName?: string;
  ifsc?: string;
  operatedCurrency?: string;
  withdrawalAmount?: string;
  exchangeRate?: string;
  platformAmount?: string;
  payoutUtr?: string;
  payoutSettlementType?: string;
  payoutBank?: string;
  payoutLiablePersonName?: string;
  errors: string[];
}): WithdrawalImportInvalidRow {
  return {
    row: fields.row,
    dateTime: fields.dateTime ?? "",
    playerId: fields.playerId ?? "",
    accountNumber: fields.accountNumber ?? "",
    accountHolderName: fields.accountHolderName ?? "",
    bankName: fields.bankName ?? "",
    ifsc: fields.ifsc ?? "",
    operatedCurrency: fields.operatedCurrency ?? "",
    withdrawalAmount: fields.withdrawalAmount ?? "",
    exchangeRate: fields.exchangeRate ?? "",
    platformAmount: fields.platformAmount ?? "",
    payoutUtr: fields.payoutUtr ?? "",
    payoutSettlementType: fields.payoutSettlementType ?? "Bank",
    payoutBank: fields.payoutBank ?? "",
    payoutLiablePersonName: fields.payoutLiablePersonName ?? "",
    errors: fields.errors,
  };
}

async function resolveWithdrawalImportRowMoney(
  operatedCurrencyRaw: string,
  amountRaw: string,
  platformCurrency: SupportedCurrency,
  rateCache: Map<string, number | null>,
): Promise<
  | {
      ok: true;
      operatedCurrency: SupportedCurrency;
      operatedAmount: number;
      exchangeRate: number;
      amount: number;
    }
  | { ok: false; errors: string[] }
> {
  const errors: string[] = [];
  if (!amountRaw.trim()) {
    errors.push(`${WITHDRAWAL_IMPORT_CSV_COLUMNS.withdrawalAmount} is required`);
    return { ok: false, errors };
  }

  const rawAmount = Number(amountRaw);
  if (Number.isNaN(rawAmount)) {
    errors.push(`${WITHDRAWAL_IMPORT_CSV_COLUMNS.withdrawalAmount} must be a valid number`);
    return { ok: false, errors };
  }

  const operatedCurrency = (operatedCurrencyRaw.trim().toUpperCase() || platformCurrency) as string;
  if (!isSupportedCurrency(operatedCurrency)) {
    errors.push(`Unsupported currency: ${operatedCurrencyRaw.trim() || operatedCurrency}`);
    return { ok: false, errors };
  }

  const minOperated = getCurrencyMinUnit(operatedCurrency);
  if (rawAmount < minOperated) {
    errors.push(
      `${WITHDRAWAL_IMPORT_CSV_COLUMNS.withdrawalAmount} must be at least ${minOperated} in ${operatedCurrency}`,
    );
    return { ok: false, errors };
  }

  let exchangeRate: number;
  if (operatedCurrency === platformCurrency) {
    exchangeRate = 1;
  } else {
    let cachedRate = rateCache.get(operatedCurrency);
    if (cachedRate === undefined) {
      const master = await resolveMasterExchangeRate(operatedCurrency, platformCurrency);
      cachedRate = master.rate;
      rateCache.set(operatedCurrency, cachedRate);
    }
    if (cachedRate == null) {
      errors.push(`No master exchange rate for ${operatedCurrency} → ${platformCurrency}`);
      return { ok: false, errors };
    }
    exchangeRate = cachedRate;
  }

  try {
    const money = resolveMoneyInput({
      operatedAmount: rawAmount,
      operatedCurrency,
      exchangeRate,
      platformCurrency,
      fieldLabel: WITHDRAWAL_IMPORT_CSV_COLUMNS.withdrawalAmount,
      minPlatformAmount: getCurrencyMinUnit(platformCurrency),
    });
    return {
      ok: true,
      operatedCurrency: money.operatedCurrency,
      operatedAmount: money.operatedAmount,
      exchangeRate: money.exchangeRate,
      amount: money.amount,
    };
  } catch (err) {
    const message = err instanceof AppError ? err.message : "Invalid amount conversion";
    errors.push(message);
    return { ok: false, errors };
  }
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
  const platformCurrency = await requirePlatformCurrency();
  const rateCache = new Map<string, number | null>();
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
    operatedCurrencyRaw: string;
    amountRaw: string;
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
    const payoutUtr = withdrawalImportPickCell(
      row,
      WITHDRAWAL_IMPORT_CSV_COLUMNS.referenceNumber,
      "reference number",
      "referencenumber",
      "payout reference number",
      "payoutreferencenumber",
      "payout utr",
      "payoututr",
      "payout_utr",
      "utr",
      "UTR",
    );
    const playerIdRaw = withdrawalImportPickCell(
      row,
      WITHDRAWAL_IMPORT_CSV_COLUMNS.traderWalletId,
      "trader wallet id",
      "trader id",
      "player id",
      "playerid",
      "player_id",
      "player",
    );
    const accountNumberRaw = withdrawalImportPickCell(
      row,
      WITHDRAWAL_IMPORT_CSV_COLUMNS.accountNumber,
      "account number",
      "accountnumber",
      "account_number",
      "acc no",
      "accno",
    );
    const normalizedAccountNumber = normalizeImportAccountLikeValue(
      accountNumberRaw,
      WITHDRAWAL_IMPORT_CSV_COLUMNS.accountNumber,
    );
    const accountNumberTextValue = withdrawalImportPickCell(
      textRow,
      WITHDRAWAL_IMPORT_CSV_COLUMNS.accountNumber,
      "account number",
      "accountnumber",
      "account_number",
      "acc no",
      "accno",
    );
    const accountDisplayScientific = IMPORT_SCI_NOTATION_REGEX.test(accountNumberTextValue.trim());
    const accountHolderName = withdrawalImportPickCell(
      row,
      WITHDRAWAL_IMPORT_CSV_COLUMNS.accountHolderName,
      "account holder name",
      "accountholdername",
      "account_holder_name",
      "holder name",
      "holdername",
    );
    const bankName = withdrawalImportPickCell(
      row,
      WITHDRAWAL_IMPORT_CSV_COLUMNS.bankName,
      "bank name",
      "bankname",
      "bank_name",
      "destination bank",
    );
    const ifsc = withdrawalImportPickCell(row, WITHDRAWAL_IMPORT_CSV_COLUMNS.ifsc, "ifsc", "IFSC");
    const operatedCurrencyRaw = withdrawalImportPickCell(
      row,
      WITHDRAWAL_IMPORT_CSV_COLUMNS.operatedCurrency,
      "operated currency",
      "operatedcurrency",
      "currency",
    );
    const amountRaw = withdrawalImportPickCell(
      row,
      WITHDRAWAL_IMPORT_CSV_COLUMNS.withdrawalAmount,
      "withdrawal amount",
      "withdrawalamount",
      "amount",
    );
    const dateTimeValue = importPickRaw(
      row,
      WITHDRAWAL_IMPORT_CSV_COLUMNS.requestDateTime,
      "date time",
      "datetime",
      "date_time",
      "requested_at",
      "requestedat",
      "request date time",
      "requestdatetime",
      "date",
    );
    const payoutSettlementType = withdrawalImportPickCell(
      row,
      WITHDRAWAL_IMPORT_CSV_COLUMNS.payoutSettlement,
      "payout settlement",
      "payoutsettlement",
      "payout settlement type",
      "payoutsettlementtype",
      "payout_settlement_type",
      "payout type",
    );
    const payoutBankIdentifierRaw = withdrawalImportPickCell(
      row,
      WITHDRAWAL_IMPORT_CSV_COLUMNS.companyPayoutBank,
      "company payout bank",
      "companypayoutbank",
      "payout bank",
      "payoutbank",
      "payout_bank",
      "company bank",
      "companybank",
    );
    const normalizedPayoutBankIdentifier = normalizeImportAccountLikeValue(
      payoutBankIdentifierRaw,
      WITHDRAWAL_IMPORT_CSV_COLUMNS.companyPayoutBank,
    );
    const payoutBankTextValue = withdrawalImportPickCell(
      textRow,
      WITHDRAWAL_IMPORT_CSV_COLUMNS.companyPayoutBank,
      "company payout bank",
      "companypayoutbank",
      "payout bank",
      "payoutbank",
      "payout_bank",
      "company bank",
      "companybank",
    );
    const payoutBankDisplayScientific = IMPORT_SCI_NOTATION_REGEX.test(payoutBankTextValue.trim());
    const payoutPersonName = withdrawalImportPickCell(
      row,
      WITHDRAWAL_IMPORT_CSV_COLUMNS.liabilityPersonPayingOut,
      "liability person paying out",
      "liabilitypersonpayingout",
      "payout liable person name",
      "payoutliablepersonname",
      "payout_liable_person_name",
      "payout person",
      "payoutperson",
      "payout liability person",
      "liable person name",
    );

    if (
      !playerIdRaw &&
      !accountNumberRaw &&
      !accountHolderName &&
      !bankName &&
      !ifsc &&
      !amountRaw &&
      !payoutUtr &&
      !operatedCurrencyRaw
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
          ? `${WITHDRAWAL_IMPORT_CSV_COLUMNS.accountNumber} must be provided as full digits, not scientific notation (E+).`
          : undefined),
      accountHolderName,
      bankName,
      ifsc,
      operatedCurrencyRaw,
      amountRaw,
      payoutUtr,
      payoutSettlementType,
      payoutBankIdentifierRaw,
      payoutBankIdentifier: normalizedPayoutBankIdentifier.value,
      payoutBankNotationError:
        normalizedPayoutBankIdentifier.notationError ||
        (payoutBankDisplayScientific
          ? `${WITHDRAWAL_IMPORT_CSV_COLUMNS.companyPayoutBank} must be provided as full digits/account label, not scientific notation (E+).`
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
    const utrMatchers = normalizedUtrs.map((u) => new RegExp(`^${escapeUtrRegex(u)}$`, "i"));
    const [depConflicts, wdConflicts] = await Promise.all([
      DepositModel.find({
        utr: { $in: utrMatchers },
        status: { $ne: "rejected" },
      })
        .select({ utr: 1 })
        .lean(),
      WithdrawalModel.find({
        utr: { $in: utrMatchers },
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
    const refLabel = WITHDRAWAL_IMPORT_CSV_COLUMNS.referenceNumber;

    if (!rd.playerIdRaw) {
      rowErrors.push(`${WITHDRAWAL_IMPORT_CSV_COLUMNS.traderWalletId} is required`);
    }
    if (rd.accountNumberNotationError) rowErrors.push(rd.accountNumberNotationError);
    if (!rd.accountNumber) {
      rowErrors.push(`${WITHDRAWAL_IMPORT_CSV_COLUMNS.accountNumber} is required`);
    } else if (rd.accountNumber.length > 40) {
      rowErrors.push(`${WITHDRAWAL_IMPORT_CSV_COLUMNS.accountNumber} must not exceed 40 characters`);
    }
    if (!rd.accountHolderName) {
      rowErrors.push(`${WITHDRAWAL_IMPORT_CSV_COLUMNS.accountHolderName} is required`);
    } else if (rd.accountHolderName.length > 120) {
      rowErrors.push(`${WITHDRAWAL_IMPORT_CSV_COLUMNS.accountHolderName} must not exceed 120 characters`);
    }
    if (!rd.bankName) {
      rowErrors.push(`${WITHDRAWAL_IMPORT_CSV_COLUMNS.bankName} is required`);
    } else if (rd.bankName.length > 120) {
      rowErrors.push(`${WITHDRAWAL_IMPORT_CSV_COLUMNS.bankName} must not exceed 120 characters`);
    }
    if (!rd.ifsc) {
      rowErrors.push(`${WITHDRAWAL_IMPORT_CSV_COLUMNS.ifsc} is required`);
    } else if (rd.ifsc.length < 4 || rd.ifsc.length > 20) {
      rowErrors.push(`${WITHDRAWAL_IMPORT_CSV_COLUMNS.ifsc} must be 4–20 characters`);
    }

    const moneyResult = await resolveWithdrawalImportRowMoney(
      rd.operatedCurrencyRaw,
      rd.amountRaw,
      platformCurrency,
      rateCache,
    );
    if (!moneyResult.ok) {
      rowErrors.push(...moneyResult.errors);
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
          `Multiple players found with ${WITHDRAWAL_IMPORT_CSV_COLUMNS.traderWalletId} "${rd.playerIdRaw}". ${WITHDRAWAL_IMPORT_CSV_COLUMNS.traderWalletId} must be unique across exchanges in this file.`,
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
    const payoutMode = parseWithdrawalImportPayoutMode(rd.payoutSettlementType);

    let resolvedPayoutBankId: string | undefined;
    let resolvedPayoutBankDisplay: string | undefined;
    let resolvedPayoutPersonId: string | undefined;
    let resolvedPayoutPersonName: string | undefined;
    let resolvedPayoutUtr: string | undefined;

    if (!hasPayoutUtr) rowErrors.push(`${refLabel} is required`);
    else if (rd.payoutUtr.length < 4) rowErrors.push(`${refLabel} must be at least 4 characters`);
    else if (rd.payoutUtr.length > 120) rowErrors.push(`${refLabel} must not exceed 120 characters`);
    else {
      const normalized = normalizeUtr(rd.payoutUtr);
      if (existingPayoutUtrConflicts.has(normalized)) {
        rowErrors.push(`${refLabel} already exists in another transaction`);
      } else if (seenPayoutUtrs.has(normalized)) {
        rowErrors.push(`Duplicate ${refLabel} within this file`);
      } else {
        seenPayoutUtrs.add(normalized);
        resolvedPayoutUtr = normalized;
      }
    }

    if (payoutMode === "bank") {
      if (rd.payoutBankNotationError) rowErrors.push(rd.payoutBankNotationError);
      if (!hasPayoutBank) {
        rowErrors.push(
          `${WITHDRAWAL_IMPORT_CSV_COLUMNS.companyPayoutBank} is required for Bank payout settlement`,
        );
      } else {
        const key = rd.payoutBankIdentifier.trim().toLowerCase();
        const bankResult = payoutBankResolutionCache.get(key);
        if (bankResult?.status === "ambiguous") {
          rowErrors.push(
            `Multiple banks found with holder name "${rd.payoutBankIdentifier}". Use account number instead.`,
          );
        } else if (!bankResult || bankResult.status === "not_found") {
          rowErrors.push(
            `${WITHDRAWAL_IMPORT_CSV_COLUMNS.companyPayoutBank} "${rd.payoutBankIdentifier}" not found (tried account number and holder name)`,
          );
        } else if (bankResult.status === "inactive") {
          rowErrors.push(`Payout bank "${bankResult.displayName}" is not active`);
        } else {
          resolvedPayoutBankId = bankResult.id;
          resolvedPayoutBankDisplay = bankResult.displayName;
        }
      }
    } else if (!hasPayoutPerson) {
      rowErrors.push(
        `${WITHDRAWAL_IMPORT_CSV_COLUMNS.liabilityPersonPayingOut} is required for Person payout settlement`,
      );
    } else {
      const key = rd.payoutPersonName.trim().toLowerCase();
      const personResult = payoutPersonResolutionCache.get(key);
      if (!personResult || personResult.status === "not_found") {
        rowErrors.push(
          `${WITHDRAWAL_IMPORT_CSV_COLUMNS.liabilityPersonPayingOut} "${rd.payoutPersonName}" not found`,
        );
      } else if (personResult.status === "inactive") {
        rowErrors.push(
          `${WITHDRAWAL_IMPORT_CSV_COLUMNS.liabilityPersonPayingOut} "${personResult.name}" is inactive`,
        );
      } else {
        resolvedPayoutPersonId = personResult.id;
        resolvedPayoutPersonName = personResult.name;
      }
    }

    const platformAmount = moneyResult.ok ? moneyResult.amount : undefined;

    if (rowErrors.length > 0) {
      invalidRows.push(
        makeWithdrawalImportInvalidRow({
          row: rd.rowNum,
          dateTime: formatImportDateTimeForDisplay(rd.dateTimeValue),
          playerId: rd.playerIdRaw,
          accountNumber: rd.accountNumberRaw,
          accountHolderName: rd.accountHolderName,
          bankName: rd.bankName,
          ifsc: rd.ifsc,
          operatedCurrency: rd.operatedCurrencyRaw,
          withdrawalAmount: rd.amountRaw,
          exchangeRate: moneyResult.ok ? String(moneyResult.exchangeRate) : "",
          platformAmount: platformAmount != null ? String(platformAmount) : "",
          payoutUtr: rd.payoutUtr,
          payoutSettlementType: rd.payoutSettlementType || "Bank",
          payoutBank: rd.payoutBankIdentifierRaw,
          payoutLiablePersonName: rd.payoutPersonName,
          errors: rowErrors,
        }),
      );
    } else if (moneyResult.ok) {
      validRows.push({
        row: rd.rowNum,
        playerMongoId: resolvedPlayerMongoId!,
        playerIdLabel: resolvedPlayerIdLabel,
        accountNumber: rd.accountNumber,
        accountHolderName: rd.accountHolderName,
        bankName: rd.bankName,
        ifsc: rd.ifsc,
        amount: moneyResult.amount,
        operatedCurrency: moneyResult.operatedCurrency,
        operatedAmount: moneyResult.operatedAmount,
        exchangeRate: moneyResult.exchangeRate,
        reverseBonus: 0,
        payableAmount: moneyResult.amount,
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
  const utrMatchers = normalized.map((u) => new RegExp(`^${escapeUtrRegex(u)}$`, "i"));
  const [depConflicts, wdConflicts] = await Promise.all([
    DepositModel.find({ utr: { $in: utrMatchers }, status: { $ne: "rejected" } })
      .select({ utr: 1 })
      .lean(),
    WithdrawalModel.find({ utr: { $in: utrMatchers }, status: { $ne: "rejected" } })
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

  const reverseBonus = 0;
  const payableAmount = row.amount;

  const base: Record<string, unknown> = {
    player: new Types.ObjectId(row.playerMongoId),
    playerName: player.label,
    accountNumber: row.accountNumber.trim(),
    accountHolderName: row.accountHolderName.trim(),
    bankName: row.bankName.trim(),
    ifsc: row.ifsc.trim(),
    amount: row.amount,
    operatedCurrency: row.operatedCurrency,
    operatedAmount: row.operatedAmount,
    exchangeRate: row.exchangeRate,
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
    return { error: `${WITHDRAWAL_IMPORT_CSV_COLUMNS.referenceNumber} is required` };
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
  if (writeError.code === 11000) {
    return `${WITHDRAWAL_IMPORT_CSV_COLUMNS.referenceNumber} already exists in another transaction`;
  }
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
          error: `${WITHDRAWAL_IMPORT_CSV_COLUMNS.referenceNumber} is required`,
        });
        continue;
      }
      const normalizedUtr = normalizeUtr(payoutUtr);
      if (dbConflicts.has(normalizedUtr) || jobPayoutUtrSet.has(normalizedUtr)) {
        errors.push({
          row: item.index + 1,
          utr: payoutUtr,
          error: `${WITHDRAWAL_IMPORT_CSV_COLUMNS.referenceNumber} already exists in another transaction`,
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

const WITHDRAWAL_IMPORT_SAMPLE_COLUMNS = WITHDRAWAL_IMPORT_CSV_HEADER_LIST;

export async function getWithdrawalImportSampleRows(): Promise<Array<Record<string, string>>> {
  let platformCurrency = "INR";
  try {
    platformCurrency = await requirePlatformCurrency();
  } catch {
    // Template fallback when platform currency is not configured yet.
  }

  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const todayStr = `${pad(now.getDate())}/${pad(now.getMonth() + 1)}/${now.getFullYear()} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
  return [
    {
      [WITHDRAWAL_IMPORT_CSV_COLUMNS.requestDateTime]: todayStr,
      [WITHDRAWAL_IMPORT_CSV_COLUMNS.traderWalletId]: "PLAYER001",
      [WITHDRAWAL_IMPORT_CSV_COLUMNS.payoutSettlement]: "Bank",
      [WITHDRAWAL_IMPORT_CSV_COLUMNS.companyPayoutBank]: "1234567890",
      [WITHDRAWAL_IMPORT_CSV_COLUMNS.liabilityPersonPayingOut]: "",
      [WITHDRAWAL_IMPORT_CSV_COLUMNS.referenceNumber]: "PAYOUT001ABC",
      [WITHDRAWAL_IMPORT_CSV_COLUMNS.accountNumber]: "123456789012",
      [WITHDRAWAL_IMPORT_CSV_COLUMNS.accountHolderName]: "John Doe",
      [WITHDRAWAL_IMPORT_CSV_COLUMNS.bankName]: "HDFC Bank",
      [WITHDRAWAL_IMPORT_CSV_COLUMNS.ifsc]: "HDFC0001234",
      [WITHDRAWAL_IMPORT_CSV_COLUMNS.operatedCurrency]: "",
      [WITHDRAWAL_IMPORT_CSV_COLUMNS.withdrawalAmount]: "5000",
    },
    {
      [WITHDRAWAL_IMPORT_CSV_COLUMNS.requestDateTime]: "",
      [WITHDRAWAL_IMPORT_CSV_COLUMNS.traderWalletId]: "PLAYER002",
      [WITHDRAWAL_IMPORT_CSV_COLUMNS.payoutSettlement]: "Person",
      [WITHDRAWAL_IMPORT_CSV_COLUMNS.companyPayoutBank]: "",
      [WITHDRAWAL_IMPORT_CSV_COLUMNS.liabilityPersonPayingOut]: "John Doe",
      [WITHDRAWAL_IMPORT_CSV_COLUMNS.referenceNumber]: "PAYOUT002DEF",
      [WITHDRAWAL_IMPORT_CSV_COLUMNS.accountNumber]: "987654321098",
      [WITHDRAWAL_IMPORT_CSV_COLUMNS.accountHolderName]: "Jane Smith",
      [WITHDRAWAL_IMPORT_CSV_COLUMNS.bankName]: "ICICI Bank",
      [WITHDRAWAL_IMPORT_CSV_COLUMNS.ifsc]: "ICIC0005678",
      [WITHDRAWAL_IMPORT_CSV_COLUMNS.operatedCurrency]: "USD",
      [WITHDRAWAL_IMPORT_CSV_COLUMNS.withdrawalAmount]: "100",
    },
  ];
}

export async function buildWithdrawalImportSampleCsv(): Promise<Buffer> {
  const rows = await getWithdrawalImportSampleRows();
  const header = WITHDRAWAL_IMPORT_SAMPLE_COLUMNS.join(",");
  const lines = rows.map((row) =>
    WITHDRAWAL_IMPORT_SAMPLE_COLUMNS.map((col) => row[col] ?? "").join(","),
  );
  return Buffer.from([header, ...lines].join("\n"), "utf-8");
}

export async function buildWithdrawalImportSampleXlsx(): Promise<Buffer> {
  const rows = await getWithdrawalImportSampleRows();
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
  const header = [
    "Row",
    ...WITHDRAWAL_IMPORT_CSV_HEADER_LIST,
    "Exchange rate",
    "Platform amount",
    "Error",
  ].join(",");
  const lines = [header];
  for (const r of invalidRows) {
    lines.push(
      [
        String(r.row),
        withdrawalQuoteCsvVal(r.dateTime),
        withdrawalQuoteCsvVal(r.playerId),
        withdrawalQuoteCsvVal(r.payoutSettlementType),
        withdrawalQuoteCsvVal(r.payoutBank),
        withdrawalQuoteCsvVal(r.payoutLiablePersonName),
        withdrawalQuoteCsvVal(r.payoutUtr),
        withdrawalQuoteCsvVal(r.accountNumber),
        withdrawalQuoteCsvVal(r.accountHolderName),
        withdrawalQuoteCsvVal(r.bankName),
        withdrawalQuoteCsvVal(r.ifsc),
        withdrawalQuoteCsvVal(r.operatedCurrency),
        withdrawalQuoteCsvVal(r.withdrawalAmount),
        withdrawalQuoteCsvVal(r.exchangeRate),
        withdrawalQuoteCsvVal(r.platformAmount),
        withdrawalQuoteCsvVal(r.errors.join("; ")),
      ].join(","),
    );
  }
  return Buffer.from(lines.join("\n"), "utf-8");
}
