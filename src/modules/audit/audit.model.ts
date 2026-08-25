import { Schema, model, Types } from "mongoose";

export interface AuditLogDocument {
  _id: Types.ObjectId;
  actorId: Types.ObjectId;
  action: string;
  entity: string;
  entityId: string;
  oldValue?: Record<string, unknown>;
  newValue?: Record<string, unknown>;
  reason?: string;
  requestId?: string;
  ipAddress?: string;
  createdAt: Date;
  updatedAt: Date;
}

const auditLogSchema = new Schema<AuditLogDocument>(
  {
    actorId: { type: Schema.Types.ObjectId, required: true, ref: "User", index: true },
    action: { type: String, required: true, trim: true },
    entity: { type: String, required: true, trim: true, index: true },
    entityId: { type: String, required: true, trim: true, index: true },
    oldValue: { type: Schema.Types.Mixed },
    newValue: { type: Schema.Types.Mixed },
    reason: { type: String, trim: true },
    requestId: { type: String, trim: true },
    ipAddress: { type: String, trim: true },
  },
  { timestamps: true },
);

auditLogSchema.index({ entity: 1, entityId: 1, createdAt: -1 });

export const AuditLogModel = model<AuditLogDocument>("AuditLog", auditLogSchema);
