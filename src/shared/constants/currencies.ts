/** Supported ISO 4217 currency codes for platform / operated currency. */
export const SUPPORTED_CURRENCIES = [
  "INR",
  "USD",
  "EUR",
  "GBP",
  "AED",
  "AUD",
  "CAD",
  "SGD",
  "NPR",
  "PKR",
  "BDT",
  "LKR",
  "MYR",
  "THB",
  "JPY",
  "CNY",
  "HKD",
  "NZD",
  "CHF",
  "ZAR",
] as const;

export type SupportedCurrency = (typeof SUPPORTED_CURRENCIES)[number];

/**
 * ISO 4217 minor-unit (fraction) digits for supported currencies.
 * Used for CRM money rounding: convert → round half-up to platform minor unit once.
 */
export const CURRENCY_FRACTION_DIGITS: Record<SupportedCurrency, number> = {
  INR: 2,
  USD: 2,
  EUR: 2,
  GBP: 2,
  AED: 2,
  AUD: 2,
  CAD: 2,
  SGD: 2,
  NPR: 2,
  PKR: 2,
  BDT: 2,
  LKR: 2,
  MYR: 2,
  THB: 2,
  JPY: 0,
  CNY: 2,
  HKD: 2,
  NZD: 2,
  CHF: 2,
  ZAR: 2,
};

/** FX rate snapshot precision (industry-common for CRM / treasury capture). */
export const EXCHANGE_RATE_FRACTION_DIGITS = 8;

export function isSupportedCurrency(value: string): value is SupportedCurrency {
  return (SUPPORTED_CURRENCIES as readonly string[]).includes(value);
}

export function getCurrencyFractionDigits(currency: string): number {
  if (isSupportedCurrency(currency)) return CURRENCY_FRACTION_DIGITS[currency];
  return 2;
}

/** Smallest positive unit for a currency (e.g. 0.01 INR, 1 JPY). */
export function getCurrencyMinUnit(currency: string): number {
  const digits = getCurrencyFractionDigits(currency);
  return digits === 0 ? 1 : 10 ** -digits;
}
