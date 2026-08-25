import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import { authenticator } from "otplib";
import QRCode from "qrcode";
import crypto from "crypto";
import { env } from "../../config/env";
import { AppError } from "../../shared/errors/AppError";
import { signAccessToken } from "../../shared/utils/jwt";
import { sendPasswordResetEmail } from "../../shared/services/email.service";
import { createAuditLog } from "../audit/audit.service";
import { UserModel } from "../users/user.model";
import {
  AUDIT_ACTION_LOGIN,
  AUDIT_ACTION_LOGIN_2FA,
  AUDIT_ENTITY_AUTH,
} from "../../shared/constants/auditEntities";

const LOGIN_RATE_MS = 15 * 60 * 1000;
const OTP_RATE_MS = 10 * 60 * 1000;
const MAX_LOGIN_ATTEMPTS = 8;
const MAX_OTP_ATTEMPTS = 8;
const loginRate = new Map<string, { count: number; resetAt: number }>();
const otpRate = new Map<string, { count: number; resetAt: number }>();

function consumeRateLimit(
  store: Map<string, { count: number; resetAt: number }>,
  key: string,
  max: number,
  windowMs: number,
) {
  const now = Date.now();
  const current = store.get(key);
  if (!current || current.resetAt < now) {
    store.set(key, { count: 1, resetAt: now + windowMs });
    return;
  }
  if (current.count >= max) {
    throw new AppError("auth_error", "Too many attempts. Please try later.", 429);
  }
  current.count += 1;
  store.set(key, current);
}

export async function loginUser(username: string, password: string) {
  consumeRateLimit(loginRate, username.toLowerCase(), MAX_LOGIN_ATTEMPTS, LOGIN_RATE_MS);
  const user = await UserModel.findOne({
    username: { $regex: new RegExp(`^${username}$`, "i") },
    status: "active",
  });
  if (!user) {
    throw new AppError("auth_error", "Invalid credentials", 401);
  }

  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) {
    throw new AppError("auth_error", "Invalid credentials", 401);
  }

  if (user.isTwoFactorEnabled) {
    const tempPayload = { userId: user._id.toString(), type: "2fa_pending" };
    const tempToken = jwt.sign(tempPayload, env.jwtAccessSecret, { expiresIn: "5m" });
    return { require_2fa: true, tempToken };
  }

  const payload = {
    userId: user._id.toString(),
    role: user.role,
    permissions: user.permissions,
    timezone: user.timezone || "Asia/Kolkata",
  };

  const accessToken = signAccessToken(payload);
  const refreshToken = jwt.sign(payload, env.jwtRefreshSecret, { expiresIn: "7d" });
  user.lastLoginAt = new Date();
  await user.save();

  const actorId = user._id.toString();
  void createAuditLog({
    actorId,
    action: AUDIT_ACTION_LOGIN,
    entity: AUDIT_ENTITY_AUTH,
    entityId: actorId,
    newValue: { method: "password" },
  }).catch(() => {
    /* non-fatal */
  });

  return {
    user: {
      id: user._id.toString(),
      username: user.username,
      fullName: user.fullName,
      role: user.role,
      permissions: user.permissions,
      timezone: user.timezone || "Asia/Kolkata",
    },
    accessToken,
    refreshToken,
  };
}

export function refreshAccessToken(refreshToken: string) {
  try {
    const payload = jwt.verify(refreshToken, env.jwtRefreshSecret) as {
      userId: string;
      role: string;
      permissions: string[];
      timezone?: string;
    };
    return { accessToken: signAccessToken(payload) };
  } catch {
    throw new AppError("auth_error", "Invalid refresh token", 401);
  }
}

export async function getCurrentUser(userId: string) {
  const user = await UserModel.findById(userId);
  if (!user || user.status !== "active") {
    throw new AppError("auth_error", "User inactive or not found", 401);
  }
  return {
    id: user._id.toString(),
    username: user.username,
    fullName: user.fullName,
    role: user.role,
    permissions: user.permissions,
    email: user.email,
    timezone: user.timezone || "Asia/Kolkata",
    isTwoFactorEnabled: Boolean(user.isTwoFactorEnabled),
  };
}

export async function verifyTwoFactor(tempToken: string, code: string) {
  let decoded: any;
  try {
    decoded = jwt.verify(tempToken, env.jwtAccessSecret);
    if (decoded.type !== "2fa_pending") throw new Error("Invalid token type");
  } catch {
    throw new AppError("auth_error", "Invalid or expired session", 401);
  }

  const user = await UserModel.findById(decoded.userId);
  if (!user || user.status !== "active") {
    throw new AppError("auth_error", "User inactive or not found", 401);
  }

  const isValid = authenticator.verify({ token: code, secret: user.twoFactorSecret || "" });
  if (!isValid) {
    throw new AppError("auth_error", "Invalid 2FA code", 400);
  }

  const payload = {
    userId: user._id.toString(),
    role: user.role,
    permissions: user.permissions,
    timezone: user.timezone || "Asia/Kolkata",
  };

  const accessToken = signAccessToken(payload);
  const refreshToken = jwt.sign(payload, env.jwtRefreshSecret, { expiresIn: "7d" });
  user.lastLoginAt = new Date();
  await user.save();

  const actorId = user._id.toString();
  void createAuditLog({
    actorId,
    action: AUDIT_ACTION_LOGIN_2FA,
    entity: AUDIT_ENTITY_AUTH,
    entityId: actorId,
    newValue: { method: "2fa" },
  }).catch(() => {
    /* non-fatal */
  });

  return {
    user: {
      id: user._id.toString(),
      username: user.username,
      fullName: user.fullName,
      role: user.role,
      permissions: user.permissions,
      timezone: user.timezone || "Asia/Kolkata",
    },
    accessToken,
    refreshToken,
  };
}

export async function generateTwoFactor(userId: string) {
  const user = await UserModel.findById(userId);
  if (!user) throw new AppError("not_found", "User not found", 404);

  const secret = authenticator.generateSecret();
  const otpauth = authenticator.keyuri(user.email, "CrickiERP", secret);
  const qrCodeUrl = await QRCode.toDataURL(otpauth);

  user.twoFactorSecret = secret;
  // Don't enable until verified
  await user.save();

  return { secret, qrCodeUrl };
}

export async function enableTwoFactor(userId: string, code: string) {
  const user = await UserModel.findById(userId);
  if (!user || !user.twoFactorSecret) throw new AppError("not_found", "User or secret not found", 404);

  const isValid = authenticator.verify({ token: code, secret: user.twoFactorSecret });
  if (!isValid) throw new AppError("bad_request", "Invalid 2FA code", 400);

  user.isTwoFactorEnabled = true;
  await user.save();
}

export async function disableTwoFactor(userId: string) {
  const user = await UserModel.findById(userId);
  if (!user) throw new AppError("not_found", "User not found", 404);

  user.isTwoFactorEnabled = false;
  // We keep the secret or clear it, clearing is safer so they must re-setup next time
  user.twoFactorSecret = undefined; 
  await user.save();
}

export async function forgotPassword(email: string) {
  const user = await UserModel.findOne({ email: email.toLowerCase(), status: "active" });
  if (!user) return; // Silent return for security

  const otp = crypto.randomInt(100000, 999999).toString();
  const expires = new Date(Date.now() + 10 * 60000); // 10 minutes

  user.resetPasswordOtp = otp;
  user.resetPasswordExpires = expires;
  await user.save();

  await sendPasswordResetEmail(user.email, otp, user.fullName);
}

export async function verifyResetOtp(email: string, otp: string) {
  consumeRateLimit(otpRate, `${email.toLowerCase()}:verify`, MAX_OTP_ATTEMPTS, OTP_RATE_MS);
  const user = await UserModel.findOne({
    email: email.toLowerCase(),
    status: "active",
    resetPasswordOtp: otp,
    resetPasswordExpires: { $gt: new Date() },
  });

  if (!user) {
    throw new AppError("bad_request", "Invalid or expired OTP", 400);
  }
}

export async function resetPassword(email: string, otp: string, new_password: string, confirm_password: string) {
  consumeRateLimit(otpRate, `${email.toLowerCase()}:reset`, MAX_OTP_ATTEMPTS, OTP_RATE_MS);
  if (new_password !== confirm_password) {
    throw new AppError("bad_request", "Passwords do not match", 400);
  }
  if (new_password.length < 8) {
    throw new AppError("bad_request", "Password must be at least 8 characters", 400);
  }
  const user = await UserModel.findOne({
    email: email.toLowerCase(),
    status: "active",
    resetPasswordOtp: otp,
    resetPasswordExpires: { $gt: new Date() },
  });

  if (!user) throw new AppError("bad_request", "Invalid or expired OTP", 400);

  user.passwordHash = await bcrypt.hash(new_password, 10);
  user.resetPasswordOtp = undefined;
  user.resetPasswordExpires = undefined;
  await user.save();
}

export async function changePassword(userId: string, current_pass: string, new_pass: string, confirm_pass: string) {
  const user = await UserModel.findById(userId);
  if (!user) throw new AppError("not_found", "User not found", 404);
  if (new_pass !== confirm_pass) throw new AppError("bad_request", "Passwords do not match", 400);
  if (new_pass.length < 8) throw new AppError("bad_request", "Password must be at least 8 characters", 400);

  const isValid = await bcrypt.compare(current_pass, user.passwordHash);
  if (!isValid) throw new AppError("bad_request", "Incorrect current password", 400);
  const isSameAsCurrent = await bcrypt.compare(new_pass, user.passwordHash);
  if (isSameAsCurrent) throw new AppError("bad_request", "New password must differ from current password", 400);

  user.passwordHash = await bcrypt.hash(new_pass, 10);
  await user.save();
}
