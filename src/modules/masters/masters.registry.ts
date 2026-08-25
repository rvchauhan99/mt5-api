import type { Model } from "mongoose";
import { ReasonModel } from "./reason.model";
import { ExpenseTypeModel } from "./expense-type.model";
import { ExchangeRateModel } from "./exchange-rate.model";

export const MASTER_MODEL_KEYS = ["reason", "expenseType", "exchangeRate"] as const;
export type MasterModelKey = (typeof MASTER_MODEL_KEYS)[number];

export type MasterRegistryEntry = {
  id: number;
  name: string;
  modelKey: MasterModelKey;
  /** Field names (camelCase) required on create */
  required_fields: string[];
};

export const MASTERS_REGISTRY: MasterRegistryEntry[] = [
  {
    id: 1,
    name: "Reason",
    modelKey: "reason",
    required_fields: ["reasonType", "reason"],
  },
  {
    id: 2,
    name: "Expense Type",
    modelKey: "expenseType",
    required_fields: ["name"],
  },
  {
    id: 3,
    name: "Exchange Rate",
    modelKey: "exchangeRate",
    required_fields: ["fromCurrency", "toCurrency", "rate"],
  },
];

const MODEL_MAP: Record<MasterModelKey, Model<unknown>> = {
  reason: ReasonModel,
  expenseType: ExpenseTypeModel,
  exchangeRate: ExchangeRateModel,
};

export function getMasterModel(modelKey: string): Model<unknown> | null {
  if (!MASTER_MODEL_KEYS.includes(modelKey as MasterModelKey)) return null;
  return MODEL_MAP[modelKey as MasterModelKey];
}

export function getRegistryEntry(modelKey: string): MasterRegistryEntry | undefined {
  return MASTERS_REGISTRY.find((e) => e.modelKey === modelKey);
}
