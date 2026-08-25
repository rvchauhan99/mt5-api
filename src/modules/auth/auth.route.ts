import { Router } from "express";
import {
  loginController,
  refreshController,
  changePasswordController,
  forgotPasswordController,
  verifyResetOtpController,
  resetPasswordController,
  generateTwoFactorController,
  enableTwoFactorController,
  disableTwoFactorController,
  verifyTwoFactorController,
  meController,
  logoutController,
} from "./auth.controller";
import { validate } from "../../shared/middlewares/validate.middleware";
import { authMiddleware } from "../../shared/middlewares/auth.middleware";
import {
  loginBodySchema,
  refreshBodySchema,
  changePasswordBodySchema,
  forgotPasswordBodySchema,
  verifyResetOtpBodySchema,
  resetPasswordBodySchema,
  enable2FaBodySchema,
  verify2FaBodySchema,
} from "./auth.validation";

const authRouter = Router();

authRouter.post("/login", validate({ body: loginBodySchema }), loginController);
authRouter.post("/refresh", validate({ body: refreshBodySchema }), refreshController);
authRouter.get("/me", authMiddleware, meController);
authRouter.post("/logout", logoutController);

// Password Reset Routes
authRouter.post("/forgot-password", validate({ body: forgotPasswordBodySchema }), forgotPasswordController);
authRouter.post("/verify-reset-otp", validate({ body: verifyResetOtpBodySchema }), verifyResetOtpController);
authRouter.post("/reset-password", validate({ body: resetPasswordBodySchema }), resetPasswordController);

// Change Password (Requires Auth)
authRouter.post("/change-password", authMiddleware, validate({ body: changePasswordBodySchema }), changePasswordController);

// 2FA Routes
authRouter.post("/verify-2fa", validate({ body: verify2FaBodySchema }), verifyTwoFactorController);
authRouter.post("/2fa/generate", authMiddleware, generateTwoFactorController);
authRouter.post("/2fa/enable", authMiddleware, validate({ body: enable2FaBodySchema }), enableTwoFactorController);
authRouter.post("/2fa/disable", authMiddleware, disableTwoFactorController);

export { authRouter };
