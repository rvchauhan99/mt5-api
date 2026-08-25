import { z } from "zod";

const mongoId24 = z.string().regex(/^[a-f0-9]{24}$/i, "Invalid id");

export const lookupQuerySchema = z.object({
  q: z.string().trim().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  /** Exact expense type (lookup only); other resources ignore this param. */
  id: z.preprocess(
    (v) => (v === "" || v === null || v === undefined ? undefined : String(v).trim()),
    mongoId24.optional(),
  ),
});

export const exchangeRateLookupQuerySchema = z.object({
  from: z.string().trim().min(3).max(3),
  to: z.string().trim().min(3).max(3),
});

