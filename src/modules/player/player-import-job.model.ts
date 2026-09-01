import { Schema, model, Types } from "mongoose";
import { PLAYER_IMPORT_CSV_COLUMNS, type ImportErrorRowData } from "./player.service";

export type PlayerImportJobStatus =
  | "queued"
  | "processing"
  | "completed"
  | "failed"
  | "cancelled";

export interface PlayerImportJobErrorItem {
  row: number;
  message: string;
  reason: string;
  rowData: ImportErrorRowData;
}

export interface PlayerImportJobProgress {
  totalRows: number;
  processedRows: number;
  successRows: number;
  failedRows: number;
  skippedRows: number;
}

export interface PlayerImportJobDocument {
  _id: Types.ObjectId;
  status: PlayerImportJobStatus;
  fileName: string;
  fileSize: number;
  fileMimeType: string;
  fileBuffer: Buffer;
  createdBy: Types.ObjectId;
  startedAt?: Date;
  finishedAt?: Date;
  failureReason?: string;
  progress: PlayerImportJobProgress;
  errorSample: PlayerImportJobErrorItem[];
  errorRows: PlayerImportJobErrorItem[];
  lock?: {
    lockedBy: string;
    lockedAt: Date;
    heartbeatAt: Date;
  };
  createdAt: Date;
  updatedAt: Date;
}

const progressSchema = new Schema<PlayerImportJobProgress>(
  {
    totalRows: { type: Number, default: 0, min: 0 },
    processedRows: { type: Number, default: 0, min: 0 },
    successRows: { type: Number, default: 0, min: 0 },
    failedRows: { type: Number, default: 0, min: 0 },
    skippedRows: { type: Number, default: 0, min: 0 },
  },
  { _id: false },
);

const errorItemSchema = new Schema<PlayerImportJobErrorItem>(
  {
    row: { type: Number, required: true },
    message: { type: String, required: true },
    reason: { type: String, required: true },
    rowData: {
      [PLAYER_IMPORT_CSV_COLUMNS.exchange]: { type: String, default: "" },
      [PLAYER_IMPORT_CSV_COLUMNS.traderId]: { type: String, default: "" },
      [PLAYER_IMPORT_CSV_COLUMNS.phoneNumber]: { type: String, default: "" },
      [PLAYER_IMPORT_CSV_COLUMNS.emailId]: { type: String, default: "" },
      [PLAYER_IMPORT_CSV_COLUMNS.userType]: { type: String, default: "" },
      [PLAYER_IMPORT_CSV_COLUMNS.ib]: { type: String, default: "" },
      [PLAYER_IMPORT_CSV_COLUMNS.referralPercentageForIb]: { type: String, default: "" },
    },
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

const playerImportJobSchema = new Schema<PlayerImportJobDocument>(
  {
    status: {
      type: String,
      enum: ["queued", "processing", "completed", "failed", "cancelled"],
      required: true,
      default: "queued",
      index: true,
    },
    fileName: { type: String, required: true, trim: true },
    fileSize: { type: Number, required: true, min: 0 },
    fileMimeType: { type: String, required: true, trim: true },
    fileBuffer: { type: Buffer, required: true },
    createdBy: { type: Schema.Types.ObjectId, required: true, ref: "User", index: true },
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

playerImportJobSchema.index({ status: 1, createdAt: 1 });
playerImportJobSchema.index({ "lock.heartbeatAt": 1 });

export const PlayerImportJobModel = model<PlayerImportJobDocument>(
  "PlayerImportJob",
  playerImportJobSchema,
);
