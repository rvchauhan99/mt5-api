import { Types } from "mongoose";
import { getAuditContext } from "../../shared/context/auditContext";
import { AuditLogModel } from "./audit.model";

type AuditPayload = {
  actorId: string;
  action: string;
  entity: string;
  entityId: string;
  oldValue?: Record<string, unknown>;
  newValue?: Record<string, unknown>;
  reason?: string;
  requestId?: string;
};

export async function createAuditLog(payload: AuditPayload) {
  const { clientIp } = getAuditContext();
  return AuditLogModel.create({
    ...payload,
    actorId: new Types.ObjectId(payload.actorId),
    ...(clientIp ? { ipAddress: clientIp } : {}),
  });
}
