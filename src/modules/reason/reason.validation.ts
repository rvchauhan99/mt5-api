import { z } from "zod";
import { REASON_TYPES, type ReasonType } from "../../shared/constants/reasonTypes";

const reasonTypeValues = Object.values(REASON_TYPES) as [ReasonType, ...ReasonType[]];

export const listReasonOptionsQuerySchema = z.object({
  reasonType: z.enum(reasonTypeValues),
  limit: z.coerce.number().int().positive().max(200).default(200),
});
