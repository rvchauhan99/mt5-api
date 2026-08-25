import { Schema, model, type Types } from "mongoose";

export type DepositImportJobStatus = "queued" | "processing" | "completed" | "failed" | "cancelled";

export interface DepositImportJobInputRow {
  utr: string;
  amount: number;
  entryAt?: string;
  settlementAccountType: "bank" | "person";
  bankId?: string;
  liabilityPersonId?: string;
  playerMongoId?: string;
  bonusAmount?: number;
  totalAmount?: number;
}

export interface DepositImportJobErrorItem {
  row: number;
  utr: string;
  error: string;
}

export interface DepositImportJobProgress {
  totalRows: number;
  processedRows: number;
  successRows: number;
  failedRows: number;
  skippedRows: number;
}

export interface DepositImportJobDocument {
  _id: Types.ObjectId;
  status: DepositImportJobStatus;
  createdBy: Types.ObjectId;
  rows: DepositImportJobInputRow[];
  startedAt?: Date;
  finishedAt?: Date;
  failureReason?: string;
  progress: DepositImportJobProgress;
  errorSample: DepositImportJobErrorItem[];
  errorRows: DepositImportJobErrorItem[];
  lock?: {
    lockedBy: string;
    lockedAt: Date;
    heartbeatAt: Date;
  };
  createdAt: Date;
  updatedAt: Date;
}

const rowSchema = new Schema<DepositImportJobInputRow>(
  {
    utr: { type: String, required: true, trim: true },
    amount: { type: Number, required: true, min: 1 },
    entryAt: { type: String, required: false },
    settlementAccountType: { type: String, enum: ["bank", "person"], required: true, default: "bank" },
    bankId: { type: String, required: false },
    liabilityPersonId: { type: String, required: false },
    playerMongoId: { type: String, required: false },
    bonusAmount: { type: Number, required: false, min: 0 },
    totalAmount: { type: Number, required: false, min: 1 },
  },
  { _id: false },
);

const progressSchema = new Schema<DepositImportJobProgress>(
  {
    totalRows: { type: Number, default: 0, min: 0 },
    processedRows: { type: Number, default: 0, min: 0 },
    successRows: { type: Number, default: 0, min: 0 },
    failedRows: { type: Number, default: 0, min: 0 },
    skippedRows: { type: Number, default: 0, min: 0 },
  },
  { _id: false },
);

const errorItemSchema = new Schema<DepositImportJobErrorItem>(
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

const depositImportJobSchema = new Schema<DepositImportJobDocument>(
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

depositImportJobSchema.index({ status: 1, createdAt: 1 });
depositImportJobSchema.index({ "lock.heartbeatAt": 1 });

export const DepositImportJobModel = model<DepositImportJobDocument>("DepositImportJob", depositImportJobSchema);
