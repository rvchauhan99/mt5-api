import { Request, Response } from "express";
import { StatusCodes } from "http-status-codes";
import { env } from "../../config/env";
import {
  loginUser,
  refreshAccessToken,
  changePassword,
  forgotPassword,
  verifyResetOtp,
  resetPassword,
  generateTwoFactor,
  enableTwoFactor,
  disableTwoFactor,
  verifyTwoFactor,
  getCurrentUser,
} from "./auth.service";

const REFRESH_COOKIE = "crickierp_refresh";
const REFRESH_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function setRefreshCookie(res: Response, refreshToken: string) {
  // Cross-origin (Vercel → Cloud Run) needs SameSite=None + Secure
  res.cookie(REFRESH_COOKIE, refreshToken, {
    httpOnly: true,
    secure: env.cookieSecure,
    sameSite: env.cookieSecure ? "none" : "lax",
    maxAge: REFRESH_TTL_MS,
    path: "/api/v1/auth",
    domain: env.cookieDomain,
  });
}

export async function loginController(req: Request, res: Response) {
  const { username, password } = req.body as { username: string; password: string };
  const data = await loginUser(username, password);
  if (!data.require_2fa && data.refreshToken) {
    setRefreshCookie(res, data.refreshToken);
  }
  res.status(StatusCodes.OK).json({ success: true, data });
}

export async function refreshController(req: Request, res: Response) {
  const refreshToken = (req.cookies?.[REFRESH_COOKIE] || req.body?.refreshToken) as string;
  const data = refreshAccessToken(refreshToken);
  res.status(StatusCodes.OK).json({ success: true, data });
}

export async function verifyTwoFactorController(req: Request, res: Response) {
  const { tempToken, code } = req.body;
  const data = await verifyTwoFactor(tempToken, code);
  setRefreshCookie(res, data.refreshToken);
  res.status(StatusCodes.OK).json({ success: true, data });
}

export async function meController(req: Request, res: Response) {
  const data = await getCurrentUser(req.user!.userId);
  res.status(StatusCodes.OK).json({ success: true, data });
}

export async function logoutController(_req: Request, res: Response) {
  res.clearCookie(REFRESH_COOKIE, {
    httpOnly: true,
    secure: env.cookieSecure,
    sameSite: env.cookieSecure ? "none" : "lax",
    path: "/api/v1/auth",
    domain: env.cookieDomain,
  });
  res.status(StatusCodes.OK).json({ success: true, message: "Logged out successfully" });
}

export async function generateTwoFactorController(req: Request, res: Response) {
  // @ts-ignore
  const userId = req.user.userId;
  const data = await generateTwoFactor(userId);
  res.status(StatusCodes.OK).json({ success: true, data });
}

export async function enableTwoFactorController(req: Request, res: Response) {
  // @ts-ignore
  const userId = req.user.userId;
  const { code } = req.body;
  await enableTwoFactor(userId, code);
  res.status(StatusCodes.OK).json({ success: true, message: "2FA Enabled Successfully" });
}

export async function disableTwoFactorController(req: Request, res: Response) {
  // @ts-ignore
  const userId = req.user.userId;
  await disableTwoFactor(userId);
  res.status(StatusCodes.OK).json({ success: true, message: "2FA Disabled Successfully" });
}

export async function forgotPasswordController(req: Request, res: Response) {
  const { email } = req.body;
  await forgotPassword(email);
  res.status(StatusCodes.OK).json({
    success: true,
    message: "If the email exists, a password reset OTP has been sent.",
  });
}

export async function verifyResetOtpController(req: Request, res: Response) {
  const { email, otp } = req.body;
  await verifyResetOtp(email, otp);
  res.status(StatusCodes.OK).json({
    success: true,
    message: "OTP verified successfully. You can now reset your password.",
  });
}

export async function resetPasswordController(req: Request, res: Response) {
  const { email, otp, new_password, confirm_password } = req.body;
  await resetPassword(email, otp, new_password, confirm_password);
  res.status(StatusCodes.OK).json({
    success: true,
    message: "Password reset successfully. Please login with your new password.",
  });
}

export async function changePasswordController(req: Request, res: Response) {
  // @ts-ignore
  const userId = req.user.userId;
  const { current_password, new_password, confirm_password } = req.body;
  await changePassword(userId, current_password, new_password, confirm_password);
  res.status(StatusCodes.OK).json({
    success: true,
    message: "Password changed successfully",
  });
}
