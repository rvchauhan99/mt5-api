import { NextFunction, Request, Response } from "express";
import mongoose from "mongoose";
import { ZodError } from "zod";
import { AppError } from "../errors/AppError";
import { logger } from "../logger";
import { formatZodErrorMessage } from "../utils/zodErrorMessage";

function mongooseValidationMessage(error: mongoose.Error.ValidationError): string {
  const parts: string[] = [];
  for (const val of Object.values(error.errors)) {
    if (val?.message) parts.push(val.message);
  }
  if (parts.length > 0) return parts.join("; ");
  return error.message || "Validation failed";
}

export function notFoundMiddleware(req: Request, res: Response) {
  res.status(404).json({
    success: false,
    error: {
      code: "not_found",
      message: `Route not found: ${req.method} ${req.originalUrl}`,
      requestId: req.requestId,
    },
  });
}

export function errorMiddleware(error: unknown, req: Request, res: Response, _next: NextFunction) {
  if (error instanceof AppError) {
    return res.status(error.statusCode).json({
      success: false,
      error: {
        code: error.code,
        message: error.message,
        details: error.details,
        requestId: req.requestId,
      },
    });
  }

  if (error instanceof ZodError) {
    return res.status(400).json({
      success: false,
      error: {
        code: "validation_error",
        message: formatZodErrorMessage(error),
        details: error.flatten(),
        requestId: req.requestId,
      },
    });
  }

  if (error instanceof mongoose.Error.ValidationError) {
    return res.status(400).json({
      success: false,
      error: {
        code: "validation_error",
        message: mongooseValidationMessage(error),
        details: error.errors,
        requestId: req.requestId,
      },
    });
  }

  logger.error(
    { err: error, requestId: req.requestId, method: req.method, path: req.originalUrl },
    "Unhandled error in request",
  );

  return res.status(500).json({
    success: false,
    error: {
      code: "system_error",
      message: "Something went wrong",
      requestId: req.requestId,
    },
  });
}
