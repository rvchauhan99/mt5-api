import { AppError } from "../../shared/errors/AppError";
import { isSupportedCurrency } from "../../shared/constants/currencies";
import { roundExchangeRate } from "../../shared/utils/moneyFx";
import { ExchangeRateModel } from "../masters/exchange-rate.model";

export type MasterExchangeRateSource = "direct" | "reverse";

export type MasterExchangeRateResult = {
  rate: number | null;
  source: MasterExchangeRateSource | null;
};

/**
 * Resolve rate for 1 `from` = ? `to`.
 * Direct master row first; else reverse pair as 1/rate.
 */
export async function resolveMasterExchangeRate(
  from: string,
  to: string,
): Promise<MasterExchangeRateResult> {
  const fromCurrency = from.trim().toUpperCase();
  const toCurrency = to.trim().toUpperCase();

  if (!isSupportedCurrency(fromCurrency) || !isSupportedCurrency(toCurrency)) {
    throw new AppError("validation_error", "Unsupported currency", 400);
  }
  if (fromCurrency === toCurrency) {
    return { rate: 1, source: "direct" };
  }

  const activeFilter = {
    isActive: true,
    $or: [{ deletedAt: null }, { deletedAt: { $exists: false } }],
  };

  const direct = await ExchangeRateModel.findOne({
    ...activeFilter,
    fromCurrency,
    toCurrency,
  })
    .select("rate")
    .lean()
    .exec();

  if (direct && Number.isFinite(Number(direct.rate)) && Number(direct.rate) > 0) {
    return { rate: roundExchangeRate(Number(direct.rate)), source: "direct" };
  }

  const reverse = await ExchangeRateModel.findOne({
    ...activeFilter,
    fromCurrency: toCurrency,
    toCurrency: fromCurrency,
  })
    .select("rate")
    .lean()
    .exec();

  if (reverse && Number.isFinite(Number(reverse.rate)) && Number(reverse.rate) > 0) {
    return { rate: roundExchangeRate(1 / Number(reverse.rate)), source: "reverse" };
  }

  return { rate: null, source: null };
}
