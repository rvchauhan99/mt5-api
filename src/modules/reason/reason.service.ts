import { ReasonModel } from "../masters/reason.model";
import type { ReasonType } from "../../shared/constants/reasonTypes";

export async function listActiveReasonOptions(reasonType: ReasonType, limit: number) {
  const rows = await ReasonModel.find({
    reasonType,
    isActive: true,
    $or: [{ deletedAt: null }, { deletedAt: { $exists: false } }],
  })
    .sort({ reason: 1 })
    .limit(limit)
    .select({ reason: 1, reasonType: 1 })
    .lean()
    .exec();

  return rows.map((r) => ({
    id: String(r._id),
    reason: String(r.reason ?? "").trim(),
    reasonType: String(r.reasonType ?? ""),
  }));
}
