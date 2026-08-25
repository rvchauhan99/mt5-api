import { SUPPORTED_CURRENCIES } from "../constants/currencies";

/** Reference snapshot: transaction was entered in operated currency, ledger uses platform amount. */
export interface MoneyFxFields {
  operatedCurrency?: string;
  operatedAmount?: number;
  exchangeRate?: number;
}

export const moneyFxSchemaFields = {
  operatedCurrency: { type: String, enum: SUPPORTED_CURRENCIES, trim: true },
  operatedAmount: { type: Number, min: 0 },
  exchangeRate: { type: Number, min: 0 },
};

/** Opening-balance FX snapshot (banks, exchanges, liability persons). */
export interface OpeningMoneyFxFields {
  openingOperatedCurrency?: string;
  openingOperatedAmount?: number;
  openingExchangeRate?: number;
}

export const openingMoneyFxSchemaFields = {
  openingOperatedCurrency: { type: String, enum: SUPPORTED_CURRENCIES, trim: true },
  openingOperatedAmount: { type: Number, min: 0 },
  openingExchangeRate: { type: Number, min: 0 },
};
