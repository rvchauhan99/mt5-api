import { Schema, model, type Types } from "mongoose";

export type DepositBulkExchangeApproveJobStatus = "queued" | "processing" | "completed" | "failed" | "cancelled";

export interface DepositBulkExchangeApproveJobErrorItem {
  depositId: string;
  error: string;
}

export interface DepositBulkExchangeApproveJobProgress {
  totalRows: number;
  processedRows: number;
  successRows: number;
  failedRows: number;
}

export interface DepositBulkExchangeApproveJobDocument {
  _id: Types.ObjectId;
  status: DepositBulkExchangeApproveJobStatus;
  createdBy: Types.ObjectId;
  depositIds: string[];
  startedAt?: Date;
  finishedAt?: Date;
  failureReason?: string;
  progress: DepositBulkExchangeApproveJobProgress;
  errorSample: DepositBulkExchangeApproveJobErrorItem[];
  errorRows: DepositBulkExchangeApproveJobErrorItem[];
  lock?: {
    lockedBy: string;
    lockedAt: Date;
    heartbeatAt: Date;
  };
  createdAt: Date;
  updatedAt: Date;
}

const progressSchema = new Schema<DepositBulkExchangeApproveJobProgress>(
  {
    totalRows: { type: Number, default: 0, min: 0 },
    processedRows: { type: Number, default: 0, min: 0 },
    successRows: { type: Number, default: 0, min: 0 },
    failedRows: { type: Number, default: 0, min: 0 },
  },
  { _id: false },
);

const errorItemSchema = new Schema<DepositBulkExchangeApproveJobErrorItem>(
  {
    depositId: { type: String, required: true, trim: true },
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

const depositBulkExchangeApproveJobSchema = new Schema<DepositBulkExchangeApproveJobDocument>(
  {
    status: {
      type: String,
      enum: ["queued", "processing", "completed", "failed", "cancelled"],
      required: true,
      default: "queued",
      index: true,
    },
    createdBy: { type: Schema.Types.ObjectId, required: true, ref: "User", index: true },
    depositIds: { type: [String], required: true, default: [] },
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

depositBulkExchangeApproveJobSchema.index({ status: 1, createdAt: 1 });
depositBulkExchangeApproveJobSchema.index({ "lock.heartbeatAt": 1 });

export const DepositBulkExchangeApproveJobModel = model<DepositBulkExchangeApproveJobDocument>(
  "DepositBulkExchangeApproveJob",
  depositBulkExchangeApproveJobSchema,
);
