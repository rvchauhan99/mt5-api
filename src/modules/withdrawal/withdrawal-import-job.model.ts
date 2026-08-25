import { Schema, model, type Types } from "mongoose";

export type WithdrawalImportJobStatus = "queued" | "processing" | "completed" | "failed" | "cancelled";

export interface WithdrawalImportJobInputRow {
  playerMongoId: string;
  accountNumber: string;
  accountHolderName: string;
  bankName: string;
  ifsc: string;
  amount: number;
  reverseBonus: number;
  requestedAt?: string;
  payoutUtr?: string;
  payoutSettlementType?: "bank" | "person";
  payoutBankId?: string;
  payoutLiabilityPersonId?: string;
}

export interface WithdrawalImportJobErrorItem {
  row: number;
  utr: string;
  error: string;
}

export interface WithdrawalImportJobProgress {
  totalRows: number;
  processedRows: number;
  successRows: number;
  failedRows: number;
  skippedRows: number;
}

export interface WithdrawalImportJobDocument {
  _id: Types.ObjectId;
  status: WithdrawalImportJobStatus;
  createdBy: Types.ObjectId;
  rows: WithdrawalImportJobInputRow[];
  startedAt?: Date;
  finishedAt?: Date;
  failureReason?: string;
  progress: WithdrawalImportJobProgress;
  errorSample: WithdrawalImportJobErrorItem[];
  errorRows: WithdrawalImportJobErrorItem[];
  lock?: {
    lockedBy: string;
    lockedAt: Date;
    heartbeatAt: Date;
  };
  createdAt: Date;
  updatedAt: Date;
}

const rowSchema = new Schema<WithdrawalImportJobInputRow>(
  {
    playerMongoId: { type: String, required: true, trim: true },
    accountNumber: { type: String, required: true, trim: true },
    accountHolderName: { type: String, required: true, trim: true },
    bankName: { type: String, required: true, trim: true },
    ifsc: { type: String, required: true, trim: true },
    amount: { type: Number, required: true, min: 1 },
    reverseBonus: { type: Number, required: true, min: 0, default: 0 },
    requestedAt: { type: String, required: false },
    payoutUtr: { type: String, required: false, trim: true },
    payoutSettlementType: { type: String, enum: ["bank", "person"], required: false },
    payoutBankId: { type: String, required: false },
    payoutLiabilityPersonId: { type: String, required: false },
  },
  { _id: false },
);

const progressSchema = new Schema<WithdrawalImportJobProgress>(
  {
    totalRows: { type: Number, default: 0, min: 0 },
    processedRows: { type: Number, default: 0, min: 0 },
    successRows: { type: Number, default: 0, min: 0 },
    failedRows: { type: Number, default: 0, min: 0 },
    skippedRows: { type: Number, default: 0, min: 0 },
  },
  { _id: false },
);

const errorItemSchema = new Schema<WithdrawalImportJobErrorItem>(
  {
    row: { type: Number, required: true },
    utr: { type: String, required: true, trim: true },
    error: { type: String, required: true, trim: true },
  },
  { _id: false },
);

const lockSchema = new Schema(
  {
    lockedBy: { type: String, required: true },
    lockedAt: { type: Date, required: true },
    heartbeatAt: { type: Date, required: true },
  },
  { _id: false },
);

const withdrawalImportJobSchema = new Schema<WithdrawalImportJobDocument>(
  {
    status: {
      type: String,
      enum: ["queued", "processing", "completed", "failed", "cancelled"],
      required: true,
      default: "queued",
      index: true,
    },
    createdBy: { type: Schema.Types.ObjectId, required: true, ref: "User", index: true },
    rows: { type: [rowSchema], required: true, default: [] },
    startedAt: { type: Date },
    finishedAt: { type: Date },
    failureReason: { type: String },
    progress: { type: progressSchema, default: () => ({}) },
    errorSample: { type: [errorItemSchema], default: [] },
    errorRows: { type: [errorItemSchema], default: [] },
    lock: { type: lockSchema, required: false },
  },
  { timestamps: true },
);

withdrawalImportJobSchema.index({ status: 1, createdAt: 1 });
withdrawalImportJobSchema.index({ "lock.heartbeatAt": 1 });

export const WithdrawalImportJobModel = model<WithdrawalImportJobDocument>(
  "WithdrawalImportJob",
  withdrawalImportJobSchema,
);
