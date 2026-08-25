import { Schema, model, Types } from "mongoose";

export interface ExpenseTypeDocument {
  _id: Types.ObjectId;
  name: string;
  code?: string;
  description?: string;
  auditRequired?: boolean;
  isActive: boolean;
  createdBy: Types.ObjectId;
  updatedBy: Types.ObjectId;
  deletedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const expenseTypeSchema = new Schema<ExpenseTypeDocument>(
  {
    name: { type: String, required: true, trim: true },
    code: { type: String, trim: true, sparse: true, unique: true },
    description: { type: String, trim: true },
    auditRequired: { type: Boolean, default: false },
    isActive: { type: Boolean, default: true },
    createdBy: { type: Schema.Types.ObjectId, required: true, ref: "User" },
    updatedBy: { type: Schema.Types.ObjectId, required: true, ref: "User" },
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

expenseTypeSchema.index({ name: 1 });
expenseTypeSchema.index({ deletedAt: 1 });
expenseTypeSchema.index({ name: "text", code: "text", description: "text" });

export const ExpenseTypeModel = model<ExpenseTypeDocument>("ExpenseType", expenseTypeSchema);
