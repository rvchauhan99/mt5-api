import { Schema, model, Types } from "mongoose";

export interface ReasonDocument {
  _id: Types.ObjectId;
  reasonType: string;
  reason: string;
  description?: string;
  isActive: boolean;
  createdBy: Types.ObjectId;
  updatedBy: Types.ObjectId;
  deletedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const reasonSchema = new Schema<ReasonDocument>(
  {
    reasonType: { type: String, required: true, trim: true, default: "general" },
    reason: { type: String, required: true, trim: true },
    description: { type: String, trim: true },
    isActive: { type: Boolean, default: true },
    createdBy: { type: Schema.Types.ObjectId, required: true, ref: "User" },
    updatedBy: { type: Schema.Types.ObjectId, required: true, ref: "User" },
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

reasonSchema.index({ reasonType: 1 });
reasonSchema.index({ deletedAt: 1 });
reasonSchema.index({ reason: "text", description: "text" });

export const ReasonModel = model<ReasonDocument>("Reason", reasonSchema);
