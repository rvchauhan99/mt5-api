import { z } from "zod";

const optionalTrimmed = z
  .string()
  .optional()
  .transform((s) => (typeof s === "string" && s.trim() !== "" ? s.trim() : undefined));

const ymd = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD");

const optionalObjectId = z.preprocess(
  (v) => (v === "" || v === undefined || v === null ? undefined : String(v).trim()),
  z.string().length(24).optional(),
);

const boolFromQuery = z.preprocess((v) => {
  if (v === true || v === "true" || v === "1" || v === 1) return true;
  if (v === false || v === "false" || v === "0" || v === 0) return false;
  return undefined;
}, z.boolean().optional());

export const balanceSheetQuerySchema = z.object({
  fromDate: ymd,
  toDate: ymd,
  exchangeId: optionalObjectId,
  groupId: optionalObjectId,
  groupCode: optionalTrimmed,
  showZeroBalances: boolFromQuery.default(false),
  includeSubGroups: boolFromQuery.default(true),
  currency: optionalTrimmed,
  compare: z.preprocess(
    (v) => (v === "" || v === undefined || v === null ? undefined : String(v).trim()),
    z.enum(["none", "prior_period", "yoy", "qoq"]).optional().default("none"),
  ),
});

export const balanceSheetSummaryQuerySchema = balanceSheetQuerySchema;

export const balanceSheetExportQuerySchema = balanceSheetQuerySchema;

export const balanceSheetDrilldownQuerySchema = z.object({
  fromDate: ymd,
  toDate: ymd,
  exchangeId: optionalObjectId,
  ledgerId: z.string().min(1),
  ledgerType: z.enum([
    "bank",
    "exchange",
    "person",
    "player",
    "expense",
    "referral",
    "withdrawal",
    "deposit",
    "manual",
    "computed",
  ]),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(200).default(50),
});

export const balanceSheetDrilldownExportQuerySchema = z.object({
  fromDate: ymd,
  toDate: ymd,
  exchangeId: optionalObjectId,
  ledgerId: z.string().min(1),
  ledgerType: z.enum([
    "bank",
    "exchange",
    "person",
    "player",
    "expense",
    "referral",
    "withdrawal",
    "deposit",
    "manual",
    "computed",
  ]),
});

export const createBalanceSheetSnapshotBodySchema = z.object({
  fromDate: ymd,
  toDate: ymd,
  exchangeId: optionalObjectId,
  note: optionalTrimmed,
});

export const balanceSheetMovementsQuerySchema = z.object({
  type: z.enum(["deposit", "withdrawal", "expense", "liability", "transfer"]),
  fromDate: ymd,
  toDate: ymd,
  exchangeId: optionalObjectId,
  bankId: optionalObjectId,
  personId: optionalObjectId,
  status: optionalTrimmed,
  search: optionalTrimmed,
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(200).default(25),
  sort: optionalTrimmed,
});

export type BalanceSheetQuery = z.infer<typeof balanceSheetQuerySchema>;
export type BalanceSheetDrilldownQuery = z.infer<typeof balanceSheetDrilldownQuerySchema>;
export type BalanceSheetDrilldownExportQuery = z.infer<typeof balanceSheetDrilldownExportQuerySchema>;
export type CreateBalanceSheetSnapshotBody = z.infer<typeof createBalanceSheetSnapshotBodySchema>;
export type BalanceSheetMovementsQuery = z.infer<typeof balanceSheetMovementsQuerySchema>;
