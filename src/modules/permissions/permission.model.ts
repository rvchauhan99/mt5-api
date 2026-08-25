import { Schema, model, Types } from "mongoose";

export interface PermissionDocument {
  _id: Types.ObjectId;
  module: string;
  action: string;
  key: string;
  description?: string;
}

const permissionSchema = new Schema<PermissionDocument>(
  {
    module: { type: String, required: true, trim: true },
    action: { type: String, required: true, trim: true },
    key: { type: String, required: true, trim: true, unique: true },
    description: { type: String, trim: true },
  },
  { timestamps: true },
);

export const PermissionModel = model<PermissionDocument>("Permission", permissionSchema);
