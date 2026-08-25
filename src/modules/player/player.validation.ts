import { z } from "zod";

export const createPlayerBodySchema = z.object({
  exchangeId: z.string().length(24),
  playerId: z.string().min(1).max(200).trim(),
  phone: z.string().min(1).max(40).trim(),
  regularBonusPercentage: z.number().min(0).max(100),
  firstDepositBonusPercentage: z.number().min(0).max(100),
  referredByPlayerId: z.string().length(24).optional().nullable(),
  referralPercentage: z.number().min(0).max(100).default(1),
});

export const updatePlayerBodySchema = z.object({
  phone: z.string().min(1).max(40).trim(),
  regularBonusPercentage: z.number().min(0).max(100),
  firstDepositBonusPercentage: z.number().min(0).max(100),
  referredByPlayerId: z.string().length(24).optional().nullable(),
  referralPercentage: z.number().min(0).max(100).default(1),
});

export const listPlayerQuerySchema = z.object({
  search: z.string().optional(),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(500).optional(),
  limit: z.coerce.number().int().positive().max(500).optional(),
  sortBy: z.enum(["createdAt", "playerId", "phone", "regularBonusPercentage", "firstDepositBonusPercentage", "bonusPercentage"]).default("createdAt"),
  sortOrder: z.enum(["asc", "desc"]).default("desc"),
  cursor: z.string().optional(),
  playerId: z.string().optional(),
  playerId_op: z.string().optional(),
  phone: z.string().optional(),
  phone_op: z.string().optional(),
  exchangeName: z.string().optional(),
  exchangeName_op: z.string().optional(),
  exchangeId: z.string().length(24).optional(),
  createdBy: z.string().optional(),
  createdAt_from: z.string().optional(),
  createdAt_to: z.string().optional(),
  createdAt_op: z.string().optional(),
  regularBonusPercentage: z.string().optional(),
  regularBonusPercentage_to: z.string().optional(),
  regularBonusPercentage_op: z.string().optional(),
  firstDepositBonusPercentage: z.string().optional(),
  firstDepositBonusPercentage_to: z.string().optional(),
  firstDepositBonusPercentage_op: z.string().optional(),
  bonusPercentage: z.string().optional(),
  bonusPercentage_to: z.string().optional(),
  bonusPercentage_op: z.string().optional(),
});
