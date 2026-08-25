import { Schema, model, Types } from "mongoose";

export type ExpenseStatus = "pending_audit" | "approved" | "rejected" | "cancelled";

export interface ExpenseDocumentFile {
  path: string;
  filename: string;
  size: number;
  mime_type: string;
  uploaded_at: Date;
}

export interface ExpenseDocument {
  _id: Types.ObjectId;
  expenseTypeId: Types.ObjectId;
  amount: number;
  operatedCurrency?: string;
  operatedAmount?: number;
  exchangeRate?: number;
  expenseDate: Date;
  description?: string;
  bankId?: Types.ObjectId;
  /** Denormalized for lists */
  bankName: string;
  settlementAccountType?: "bank" | "person";
  liabilityPersonId?: Types.ObjectId;
  liabilityPersonName?: string;
  liabilityEntryId?: Types.ObjectId;
  status: ExpenseStatus;
  rejectReason?: string;
  /** Master Reason reference for rejection. */
  rejectReasonId?: Types.ObjectId;
  cancelReason?: string;
  /** Master Reason reference for superadmin cancel of approved expense. */
  cancelReasonId?: Types.ObjectId;
  cancelledBy?: Types.ObjectId;
  cancelledAt?: Date;
  approvedBy?: Types.ObjectId;
  approvedAt?: Date;
  bankBalanceAfter?: number;
  documents: ExpenseDocumentFile[];
  createdBy: Types.ObjectId;
  updatedBy?: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const expenseSchema = new Schema<ExpenseDocument>(
  {
    expenseTypeId: { type: Schema.Types.ObjectId, ref: "ExpenseType", required: true },
    amount: { type: Number, required: true, min: 0.01 },
    operatedCurrency: { type: String, trim: true },
    operatedAmount: { type: Number, min: 0 },
    exchangeRate: { type: Number, min: 0 },
    expenseDate: { type: Date, required: true },
    description: { type: String, trim: true, default: "" },
    bankId: { type: Schema.Types.ObjectId, ref: "Bank" },
    bankName: { type: String, trim: true, default: "" },
    settlementAccountType: { type: String, enum: ["bank", "person"] },
    liabilityPersonId: { type: Schema.Types.ObjectId, ref: "LiabilityPerson" },
    liabilityPersonName: { type: String, trim: true, default: "" },
    liabilityEntryId: { type: Schema.Types.ObjectId, ref: "LiabilityEntry" },
    status: {
      type: String,
      enum: ["pending_audit", "approved", "rejected", "cancelled"],
      default: "pending_audit",
    },
    rejectReason: { type: String, trim: true },
    rejectReasonId: { type: Schema.Types.ObjectId, ref: "Reason" },
    cancelReason: { type: String, trim: true },
    cancelReasonId: { type: Schema.Types.ObjectId, ref: "Reason" },
    cancelledBy: { type: Schema.Types.ObjectId, ref: "User" },
    cancelledAt: { type: Date },
    approvedBy: { type: Schema.Types.ObjectId, ref: "User" },
    approvedAt: { type: Date },
    bankBalanceAfter: { type: Number, min: 0 },
    documents: [
      {
        path: { type: String, required: true, trim: true },
        filename: { type: String, required: true, trim: true },
        size: { type: Number, required: true, min: 0 },
        mime_type: { type: String, required: true, trim: true },
        uploaded_at: { type: Date, required: true, default: Date.now },
      },
    ],
    createdBy: { type: Schema.Types.ObjectId, required: true, ref: "User" },
    updatedBy: { type: Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true },
);

expenseSchema.index({ status: 1, createdAt: -1 });
expenseSchema.index({ expenseTypeId: 1 });
expenseSchema.index({ bankId: 1 });
expenseSchema.index({ expenseDate: 1 });
expenseSchema.index({ status: 1, expenseDate: -1, _id: -1 });
expenseSchema.index({ bankId: 1, status: 1, createdAt: -1, _id: -1 });

export const ExpenseModel = model<ExpenseDocument>("Expense", expenseSchema);
