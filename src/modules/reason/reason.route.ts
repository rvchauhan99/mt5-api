import { Router } from "express";
import { authMiddleware } from "../../shared/middlewares/auth.middleware";
import { validate } from "../../shared/middlewares/validate.middleware";
import { listReasonOptionsController } from "./reason.controller";
import { reasonOptionsPermissionMiddleware } from "./reasonOptions.middleware";
import { listReasonOptionsQuerySchema } from "./reason.validation";

const reasonRouter = Router();

reasonRouter.use(authMiddleware);

reasonRouter.get(
  "/options",
  validate({ query: listReasonOptionsQuerySchema }),
  reasonOptionsPermissionMiddleware,
  listReasonOptionsController,
);

export { reasonRouter };
