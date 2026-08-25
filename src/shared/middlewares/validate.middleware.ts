import { NextFunction, Request, Response } from "express";
import { ZodError, ZodTypeAny } from "zod";
import { AppError } from "../errors/AppError";
import { formatZodErrorMessage } from "../utils/zodErrorMessage";

export function validate(schema: {
  body?: ZodTypeAny;
  query?: ZodTypeAny;
  params?: ZodTypeAny;
}) {
  return (req: Request, _res: Response, next: NextFunction) => {
    try {
      if (schema.body) req.body = schema.body.parse(req.body);
      if (schema.query) schema.query.parse(req.query);
      if (schema.params) schema.params.parse(req.params);
      next();
    } catch (error) {
      if (error instanceof ZodError) {
        return next(
          new AppError("validation_error", formatZodErrorMessage(error), 400, error.flatten()),
        );
      }
      next(error);
    }
  };
}
