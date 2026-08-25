import { z } from "zod";

export const loginBodySchema = z.object({
  username: z.string().min(3),
  password: z.string().min(6),
});

export const refreshBodySchema = z.object({
  refreshToken: z.string().min(10).optional(),
});

export const verify2FaBodySchema = z.object({
  tempToken: z.string(),
  code: z.string().length(6),
});

export const enable2FaBodySchema = z.object({
  code: z.string().length(6),
});

export const forgotPasswordBodySchema = z.object({
  email: z.string().email(),
});

export const verifyResetOtpBodySchema = z.object({
  email: z.string().email(),
  otp: z.string().length(6),
});

export const resetPasswordBodySchema = z.object({
  email: z.string().email(),
  otp: z.string().length(6),
  new_password: z.string().min(6),
  confirm_password: z.string().min(6),
}).refine(data => data.new_password === data.confirm_password, {
  message: "Passwords do not match",
  path: ["confirm_password"],
});

export const changePasswordBodySchema = z.object({
  current_password: z.string().min(6),
  new_password: z.string().min(6),
  confirm_password: z.string().min(6),
}).refine(data => data.new_password === data.confirm_password, {
  message: "Passwords do not match",
  path: ["confirm_password"],
});
