import { z } from "zod";
import { SUPPORTED_CURRENCIES } from "../constants/currencies";

/** Optional FX fields on money create/update bodies. Server resolves against platform currency. */
export const moneyFxInputSchema = z.object({
  operatedCurrency: z.enum(SUPPORTED_CURRENCIES).optional(),
  /** When provided, treated as the operated-currency amount (preferred over converting `amount`). */
  operatedAmount: z.number().min(0).optional(),
  exchangeRate: z.number().positive().optional(),
});

export type MoneyFxInput = z.infer<typeof moneyFxInputSchema>;

export const openingMoneyFxInputSchema = z.object({
  openingOperatedCurrency: z.enum(SUPPORTED_CURRENCIES).optional(),
  openingOperatedAmount: z.number().min(0).optional(),
  openingExchangeRate: z.number().positive().optional(),
});

export type OpeningMoneyFxInput = z.infer<typeof openingMoneyFxInputSchema>;
