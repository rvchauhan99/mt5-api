import { Types } from "mongoose";
import { ReasonModel } from "../masters/reason.model";
import type { ReasonType } from "../../shared/constants/reasonTypes";
import { AppError } from "../../shared/errors/AppError";

export type ResolvedRejectReason = {
  id: string;
  masterText: string;
};

/**
 * Loads an active Reason row and ensures it matches the expected operational type.
 */
export async function loadActiveReasonForReject(
  reasonId: string,
  expectedReasonType: ReasonType,
): Promise<ResolvedRejectReason> {
  const id = String(reasonId || "").trim();
  if (!Types.ObjectId.isValid(id)) {
    throw new AppError("validation_error", "Invalid reason id", 400);
  }
  const doc = await ReasonModel.findById(id).lean().exec();
  if (!doc) {
    throw new AppError("not_found", "Reason not found", 404);
  }
  if (doc.deletedAt != null) {
    throw new AppError("business_rule_error", "Reason is not available", 400);
  }
  if (!doc.isActive) {
    throw new AppError("business_rule_error", "Reason is inactive", 400);
  }
  if (doc.reasonType !== expectedReasonType) {
    throw new AppError("validation_error", "Reason does not apply to this action", 400);
  }
  const masterText = String(doc.reason || "").trim();
  if (!masterText) {
    throw new AppError("business_rule_error", "Reason text is empty", 400);
  }
  return { id, masterText };
}

export function composeRejectReasonText(masterText: string, remark?: string): string {
  const note = remark?.trim();
  if (!note) return masterText;
  return `${masterText} — ${note}`;
}
