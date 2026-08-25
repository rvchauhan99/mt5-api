import { Types } from "mongoose";
import { AppError } from "../../shared/errors/AppError";
import type { SupportedCurrency } from "../../shared/constants/currencies";
import { SUPPORTED_CURRENCIES } from "../../shared/constants/currencies";
import { DepositModel } from "../deposit/deposit.model";
import { WithdrawalModel } from "../withdrawal/withdrawal.model";
import { ExpenseModel } from "../expense/expense.model";
import { LiabilityEntryModel } from "../liability/liability-entry.model";
import { LiabilityPersonModel } from "../liability/liability-person.model";
import { BankModel } from "../bank/bank.model";
import { ExchangeModel } from "../exchange/exchange.model";
import { ExchangeTopupModel } from "../exchange-topup/exchange-topup.model";
import { PLATFORM_SETTINGS_KEY, PlatformSettingsModel } from "./settings.model";

export type PlatformSettingsView = {
  platformCurrency: SupportedCurrency | null;
  currencyLockedAt: string | null;
  currencyLockedBy: string | null;
  isLocked: boolean;
  supportedCurrencies: readonly SupportedCurrency[];
};

async function ensureSingleton() {
  let doc = await PlatformSettingsModel.findOne({ key: PLATFORM_SETTINGS_KEY }).exec();
  if (!doc) {
    doc = await PlatformSettingsModel.create({ key: PLATFORM_SETTINGS_KEY });
  }
  return doc;
}

export async function getPlatformSettings(): Promise<PlatformSettingsView> {
  const doc = await ensureSingleton();
  const currency = doc.platformCurrency ?? null;
  return {
    platformCurrency: currency,
    currencyLockedAt: doc.currencyLockedAt ? doc.currencyLockedAt.toISOString() : null,
    currencyLockedBy: doc.currencyLockedBy ? String(doc.currencyLockedBy) : null,
    isLocked: Boolean(currency),
    supportedCurrencies: SUPPORTED_CURRENCIES,
  };
}

/**
 * Returns configured platform currency or throws if not set.
 * Call from every money create/update path.
 */
export async function requirePlatformCurrency(): Promise<SupportedCurrency> {
  const doc = await ensureSingleton();
  if (!doc.platformCurrency) {
    throw new AppError(
      "platform_currency_required",
      "Platform currency is not configured. Set it once under Profile / Settings before creating money transactions.",
      400,
    );
  }
  return doc.platformCurrency;
}

export async function getPlatformCurrencyOrNull(): Promise<SupportedCurrency | null> {
  const doc = await ensureSingleton();
  return doc.platformCurrency ?? null;
}

/**
 * Lock platform currency forever and backfill FX reference fields on existing money rows.
 */
export async function setPlatformCurrency(
  currency: SupportedCurrency,
  lockedByUserId: string,
): Promise<PlatformSettingsView> {
  const doc = await ensureSingleton();

  if (doc.platformCurrency) {
    throw new AppError(
      "platform_currency_locked",
      `Platform currency is already set to ${doc.platformCurrency} and cannot be changed.`,
      409,
    );
  }

  doc.platformCurrency = currency;
  doc.currencyLockedAt = new Date();
  doc.currencyLockedBy = new Types.ObjectId(lockedByUserId);
  await doc.save();

  await backfillExistingMoneyFx(currency);

  return getPlatformSettings();
}

/**
 * Existing amounts are treated as already in platform currency.
 * Backfill operatedCurrency / operatedAmount / exchangeRate where missing.
 */
async function backfillExistingMoneyFx(platformCurrency: SupportedCurrency) {
  const fxUnset = {
    $or: [
      { operatedCurrency: { $exists: false } },
      { operatedCurrency: null },
      { operatedCurrency: "" },
    ],
  };

  const pipelineOpts = { updatePipeline: true as const };

  await Promise.all([
    DepositModel.updateMany(
      fxUnset,
      [
        {
          $set: {
            operatedCurrency: platformCurrency,
            operatedAmount: "$amount",
            exchangeRate: 1,
          },
        },
      ],
      pipelineOpts,
    ),
    WithdrawalModel.updateMany(
      fxUnset,
      [
        {
          $set: {
            operatedCurrency: platformCurrency,
            operatedAmount: "$amount",
            exchangeRate: 1,
          },
        },
      ],
      pipelineOpts,
    ),
    ExpenseModel.updateMany(
      fxUnset,
      [
        {
          $set: {
            operatedCurrency: platformCurrency,
            operatedAmount: "$amount",
            exchangeRate: 1,
          },
        },
      ],
      pipelineOpts,
    ),
    LiabilityEntryModel.updateMany(
      fxUnset,
      [
        {
          $set: {
            operatedCurrency: platformCurrency,
            operatedAmount: "$amount",
            exchangeRate: 1,
          },
        },
      ],
      pipelineOpts,
    ),
    LiabilityPersonModel.updateMany(
      {
        $or: [
          { openingOperatedCurrency: { $exists: false } },
          { openingOperatedCurrency: null },
          { openingOperatedCurrency: "" },
        ],
      },
      [
        {
          $set: {
            openingOperatedCurrency: platformCurrency,
            openingOperatedAmount: { $abs: "$openingBalance" },
            openingExchangeRate: 1,
          },
        },
      ],
      pipelineOpts,
    ),
    BankModel.updateMany(
      {
        $or: [
          { openingOperatedCurrency: { $exists: false } },
          { openingOperatedCurrency: null },
          { openingOperatedCurrency: "" },
        ],
      },
      [
        {
          $set: {
            openingOperatedCurrency: platformCurrency,
            openingOperatedAmount: "$openingBalance",
            openingExchangeRate: 1,
          },
        },
      ],
      pipelineOpts,
    ),
    ExchangeModel.updateMany(
      {
        $or: [
          { openingOperatedCurrency: { $exists: false } },
          { openingOperatedCurrency: null },
          { openingOperatedCurrency: "" },
        ],
      },
      [
        {
          $set: {
            openingOperatedCurrency: platformCurrency,
            openingOperatedAmount: "$openingBalance",
            openingExchangeRate: 1,
          },
        },
      ],
      pipelineOpts,
    ),
    ExchangeTopupModel.updateMany(
      fxUnset,
      [
        {
          $set: {
            operatedCurrency: platformCurrency,
            operatedAmount: "$amount",
            exchangeRate: 1,
          },
        },
      ],
      pipelineOpts,
    ),
  ]);
}
