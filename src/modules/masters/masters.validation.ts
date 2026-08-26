import { z } from "zod";
import type { MasterModelKey } from "./masters.registry";
import { MASTER_MODEL_KEYS } from "./masters.registry";
import { SUPPORTED_CURRENCIES } from "../../shared/constants/currencies";

const mongoIdString = z.string().regex(/^[a-f0-9]{24}$/i, "Invalid id");

export const modelKeyParamSchema = z.object({
  modelKey: z.enum(MASTER_MODEL_KEYS),
});

export const modelKeyIdParamSchema = z.object({
  modelKey: z.enum(MASTER_MODEL_KEYS),
  id: mongoIdString,
});

const sortByToken = z
  .string()
  .regex(/^[a-zA-Z][a-zA-Z0-9_]*$/, "Invalid sort field")
  .max(64);

export const listMastersQuerySchema = z
  .object({
    page: z.coerce.number().int().positive().default(1),
    limit: z.coerce.number().int().positive().max(500).default(20),
    q: z.preprocess(
      (v) => (v === "" || v === null || v === undefined ? undefined : String(v).trim()),
      z.string().max(200).optional(),
    ),
    visibility: z.enum(["active", "inactive", "all"]).default("active"),
    sortBy: z.preprocess(
      (v) => (v === "" || v === null || v === undefined ? undefined : String(v).trim()),
      sortByToken.optional(),
    ),
    sortOrder: z.enum(["asc", "desc"]).default("desc"),
  })
  .strict();

export const createReasonBodySchema = z
  .object({
    reasonType: z.string().min(1).max(200).trim().default("general"),
    reason: z.string().min(1).max(2000).trim(),
    description: z.preprocess(
      (v) => (v === "" || v === null || v === undefined ? undefined : v),
      z.string().max(10000).trim().optional(),
    ),
    isActive: z.boolean().optional(),
  })
  .strict();

export const updateReasonBodySchema = createReasonBodySchema.partial().strict();

export const createExpenseTypeBodySchema = z
  .object({
    name: z.string().min(1).max(500).trim(),
    code: z.preprocess(
      (v) => (v === "" || v === null || v === undefined ? undefined : v),
      z.string().max(100).trim().optional(),
    ),
    description: z.preprocess(
      (v) => (v === "" || v === null || v === undefined ? undefined : v),
      z.string().max(10000).trim().optional(),
    ),
    isActive: z.boolean().optional(),
    auditRequired: z.boolean().optional().default(false),
  })
  .strict();

export const updateExpenseTypeBodySchema = createExpenseTypeBodySchema.partial().strict();

export const createPaymentMethodBodySchema = z
  .object({
    name: z.string().min(1).max(500).trim(),
    code: z.preprocess(
      (v) => (v === "" || v === null || v === undefined ? undefined : v),
      z.string().max(100).trim().optional(),
    ),
    description: z.preprocess(
      (v) => (v === "" || v === null || v === undefined ? undefined : v),
      z.string().max(10000).trim().optional(),
    ),
    isActive: z.boolean().optional(),
  })
  .strict();

export const updatePaymentMethodBodySchema = createPaymentMethodBodySchema.partial().strict();

const currencyEnum = z.enum(SUPPORTED_CURRENCIES);

export const createExchangeRateBodySchema = z
  .object({
    fromCurrency: currencyEnum,
    toCurrency: currencyEnum,
    rate: z.number().positive(),
    isActive: z.boolean().optional(),
  })
  .strict()
  .superRefine((data, ctx) => {
    if (data.fromCurrency === data.toCurrency) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "From and to currency must be different",
        path: ["toCurrency"],
      });
    }
  });

export const updateExchangeRateBodySchema = z
  .object({
    fromCurrency: currencyEnum.optional(),
    toCurrency: currencyEnum.optional(),
    rate: z.number().positive().optional(),
    isActive: z.boolean().optional(),
  })
  .strict()
  .superRefine((data, ctx) => {
    if (
      data.fromCurrency !== undefined &&
      data.toCurrency !== undefined &&
      data.fromCurrency === data.toCurrency
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "From and to currency must be different",
        path: ["toCurrency"],
      });
    }
  });

export function parseCreateBody(modelKey: MasterModelKey, body: unknown): Record<string, unknown> {
  switch (modelKey) {
    case "reason":
      return createReasonBodySchema.parse(body) as Record<string, unknown>;
    case "expenseType":
      return createExpenseTypeBodySchema.parse(body) as Record<string, unknown>;
    case "exchangeRate":
      return createExchangeRateBodySchema.parse(body) as Record<string, unknown>;
    case "paymentMethod":
      return createPaymentMethodBodySchema.parse(body) as Record<string, unknown>;
    default: {
      const _x: never = modelKey;
      return _x;
    }
  }
}

export function parseUpdateBody(modelKey: MasterModelKey, body: unknown): Record<string, unknown> {
  switch (modelKey) {
    case "reason":
      return updateReasonBodySchema.parse(body) as Record<string, unknown>;
    case "expenseType":
      return updateExpenseTypeBodySchema.parse(body) as Record<string, unknown>;
    case "exchangeRate":
      return updateExchangeRateBodySchema.parse(body) as Record<string, unknown>;
    case "paymentMethod":
      return updatePaymentMethodBodySchema.parse(body) as Record<string, unknown>;
    default: {
      const _x: never = modelKey;
      return _x;
    }
  }
}
