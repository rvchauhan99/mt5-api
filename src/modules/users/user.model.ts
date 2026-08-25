import { Schema, model, Types } from "mongoose";

export type UserRole = "superadmin" | "admin" | "sub_admin";
export type UserStatus = "active" | "deactive";

export interface UserDocument {
  _id: Types.ObjectId;
  fullName: string;
  email: string;
  username: string;
  passwordHash: string;
  role: UserRole;
  status: UserStatus;
  permissions: string[];
  twoFactorSecret?: string;
  isTwoFactorEnabled?: boolean;
  resetPasswordOtp?: string;
  resetPasswordExpires?: Date;
  createdBy?: Types.ObjectId;
  lastLoginAt?: Date;
  timezone: string;
  createdAt: Date;
  updatedAt: Date;
}

const userSchema = new Schema<UserDocument>(
  {
    fullName: { type: String, required: true, trim: true },
    email: { type: String, required: true, trim: true, lowercase: true, unique: true },
    username: { type: String, required: true, trim: true, unique: true },
    passwordHash: { type: String, required: true },
    role: { type: String, enum: ["superadmin", "admin", "sub_admin"], default: "sub_admin" },
    status: { type: String, enum: ["active", "deactive"], default: "active" },
    permissions: [{ type: String }],
    twoFactorSecret: { type: String },
    isTwoFactorEnabled: { type: Boolean, default: false },
    resetPasswordOtp: { type: String },
    resetPasswordExpires: { type: Date },
    createdBy: { type: Schema.Types.ObjectId, ref: "User" },
    lastLoginAt: { type: Date },
    timezone: { type: String, trim: true, default: "Asia/Kolkata" },
  },
  { timestamps: true },
);

export const UserModel = model<UserDocument>("User", userSchema);
