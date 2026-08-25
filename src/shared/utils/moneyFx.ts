import { AppError } from "../errors/AppError";
import {
  EXCHANGE_RATE_FRACTION_DIGITS,
  getCurrencyFractionDigits,
  getCurrencyMinUnit,
  isSupportedCurrency,
  type SupportedCurrency,
} from "../constants/currencies";
import { requirePlatformCurrency } from "../../modules/settings/settings.service";

export interface ResolveMoneyInputParams {
  operatedAmount: number;
  operatedCurrency?: string | null;
  exchangeRate?: number | null;
  platformCurrency: SupportedCurrency;
  fieldLabel?: string;
  /** Minimum platform amount after rounding (defaults to platform min unit when omitted / positive ops). */
  minPlatformAmount?: number;
}

export interface ResolvedMoney {
  /** Amount in platform currency (ledger source of truth), rounded to platform minor units */
  amount: number;
  platformCurrency: SupportedCurrency;
  operatedCurrency: SupportedCurrency;
  /** Operated amount rounded to operated-currency minor units */
  operatedAmount: number;
  /** Rate snapshot rounded to EXCHANGE_RATE_FRACTION_DIGITS */
  exchangeRate: number;
}

/**
 * Round half-up to `fractionDigits` without classic float traps
 * (e.g. 1.005 → 1.01 at 2dp).
 */
export function roundHalfUp(value: number, fractionDigits: number): number {
  if (!Number.isFinite(value)) return NaN;
  if (fractionDigits < 0) throw new Error("fractionDigits must be >= 0");
  if (value === 0) return 0;

  const sign = value < 0 ? -1 : 1;
  const abs = Math.abs(value);
  const shifted = Number(`${abs}e${fractionDigits}`);
  if (!Number.isFinite(shifted)) {
    const factor = 10 ** fractionDigits;
    return (sign * Math.round(abs * factor + Number.EPSILON)) / factor;
  }
  const rounded = Math.round(shifted);
  const result = Number(`${rounded}e-${fractionDigits}`);
  return sign * result;
}

export function roundMoneyToCurrency(value: number, currency: string): number {
  return roundHalfUp(value, getCurrencyFractionDigits(currency));
}

export function roundExchangeRate(rate: number): number {
  return roundHalfUp(rate, EXCHANGE_RATE_FRACTION_DIGITS);
}

/**
 * Convert operated-currency input into platform-currency amount + reference snapshot.
 *
 * Practice:
 * 1. Round operated amount to operated-currency minor units
 * 2. Snapshot rate (1 when same currency; else required, rounded to 8dp)
 * 3. platformAmount = roundHalfUp(operated × rate, platform minor units) — single convert/round
 */
export function resolveMoneyInput(params: ResolveMoneyInputParams): ResolvedMoney {
  const {
    operatedAmount: rawOperatedAmount,
    operatedCurrency: rawCurrency,
    exchangeRate: rawRate,
    platformCurrency,
    fieldLabel = "amount",
    minPlatformAmount,
  } = params;

  if (!Number.isFinite(rawOperatedAmount) || rawOperatedAmount < 0) {
    throw new AppError("validation_error", `Invalid ${fieldLabel}`, 400);
  }

  const operatedCurrency = (rawCurrency?.trim().toUpperCase() || platformCurrency) as string;
  if (!isSupportedCurrency(operatedCurrency)) {
    throw new AppError("validation_error", `Unsupported currency: ${operatedCurrency}`, 400);
  }

  const operatedAmount = roundMoneyToCurrency(rawOperatedAmount, operatedCurrency);
  const sameCurrency = operatedCurrency === platformCurrency;
  let exchangeRate: number;

  if (sameCurrency) {
    exchangeRate = 1;
  } else {
    if (rawRate == null || !Number.isFinite(rawRate) || rawRate <= 0) {
      throw new AppError(
        "validation_error",
        `Exchange rate is required when operated currency (${operatedCurrency}) differs from platform currency (${platformCurrency})`,
        400,
      );
    }
    exchangeRate = roundExchangeRate(rawRate);
    if (exchangeRate <= 0) {
      throw new AppError("validation_error", "Exchange rate must be greater than zero", 400);
    }
  }

  const amount = roundMoneyToCurrency(operatedAmount * exchangeRate, platformCurrency);
  const minUnit = getCurrencyMinUnit(platformCurrency);
  const effectiveMin = minPlatformAmount ?? 0;

  if (effectiveMin > 0 && amount < effectiveMin) {
    throw new AppError(
      "validation_error",
      `Converted ${fieldLabel} must be at least ${effectiveMin} in platform currency (${platformCurrency})`,
      400,
    );
  }

  if (amount < 0) {
    throw new AppError("validation_error", `Invalid converted ${fieldLabel}`, 400);
  }

  // Allow zero for openings/amends; for positive creates callers pass minPlatformAmount = min unit
  void minUnit;

  return {
    amount,
    platformCurrency,
    operatedCurrency,
    operatedAmount,
    exchangeRate,
  };
}

export type MoneyRequestFx = {
  amount: number;
  operatedCurrency?: string | null;
  operatedAmount?: number | null;
  exchangeRate?: number | null;
};

/**
 * Resolve body money fields against the locked platform currency.
 * `amount` is treated as operated amount when `operatedAmount` is omitted.
 */
export async function resolveMoneyFromRequest(
  input: MoneyRequestFx,
  options?: {
    fieldLabel?: string;
    minPlatformAmount?: number;
  },
): Promise<ResolvedMoney> {
  const platformCurrency = await requirePlatformCurrency();
  const operatedAmount = input.operatedAmount ?? input.amount;
  return resolveMoneyInput({
    operatedAmount,
    operatedCurrency: input.operatedCurrency,
    exchangeRate: input.exchangeRate,
    platformCurrency,
    fieldLabel: options?.fieldLabel ?? "amount",
    minPlatformAmount: options?.minPlatformAmount,
  });
}

export type OpeningMoneyRequestFx = {
  openingBalance: number;
  openingOperatedCurrency?: string | null;
  openingOperatedAmount?: number | null;
  openingExchangeRate?: number | null;
};

export async function resolveOpeningMoneyFromRequest(
  input: OpeningMoneyRequestFx,
): Promise<{
  openingBalance: number;
  openingOperatedCurrency: SupportedCurrency;
  openingOperatedAmount: number;
  openingExchangeRate: number;
}> {
  const resolved = await resolveMoneyFromRequest(
    {
      amount: input.openingBalance,
      operatedCurrency: input.openingOperatedCurrency,
      operatedAmount: input.openingOperatedAmount,
      exchangeRate: input.openingExchangeRate,
    },
    { fieldLabel: "opening balance", minPlatformAmount: 0 },
  );
  return {
    openingBalance: resolved.amount,
    openingOperatedCurrency: resolved.operatedCurrency,
    openingOperatedAmount: resolved.operatedAmount,
    openingExchangeRate: resolved.exchangeRate,
  };
}

/** Convert a secondary operated amount (bonus / reverse bonus) with an already-resolved rate. */
export function convertSecondaryAmount(
  operatedSecondary: number,
  exchangeRate: number,
  platformCurrency: SupportedCurrency,
  operatedCurrency: string,
): number {
  const roundedOperated = roundMoneyToCurrency(operatedSecondary, operatedCurrency);
  return roundMoneyToCurrency(roundedOperated * exchangeRate, platformCurrency);
}
