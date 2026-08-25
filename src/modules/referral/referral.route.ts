import { Router } from "express";
import { PERMISSIONS } from "../../shared/constants/permissions";
import { authMiddleware } from "../../shared/middlewares/auth.middleware";
import { permissionMiddleware } from "../../shared/middlewares/permission.middleware";
import { validate } from "../../shared/middlewares/validate.middleware";
import { listReferralAccrualController, settleReferralAccrualController } from "./referral.controller";
import { listReferralAccrualQuerySchema, settleReferralAccrualBodySchema } from "./referral.validation";

const referralRouter = Router();

referralRouter.use(authMiddleware);

referralRouter.get(
  "/accruals",
  permissionMiddleware(PERMISSIONS.REFERRAL_LIST),
  validate({ query: listReferralAccrualQuerySchema }),
  listReferralAccrualController,
);

referralRouter.post(
  "/settle",
  permissionMiddleware(PERMISSIONS.REFERRAL_SETTLE),
  validate({ body: settleReferralAccrualBodySchema }),
  settleReferralAccrualController,
);

export { referralRouter };
