import { Router } from "express";
import { PERMISSIONS } from "../../shared/constants/permissions";
import { authMiddleware } from "../../shared/middlewares/auth.middleware";
import { permissionMiddleware } from "../../shared/middlewares/permission.middleware";
import { validate } from "../../shared/middlewares/validate.middleware";
import {
  listReferralAccrualController,
  settleReferralAccrualController,
  updateReferralAccrualController,
} from "./referral.controller";
import {
  listReferralAccrualQuerySchema,
  referralAccrualIdParamSchema,
  settleReferralAccrualBodySchema,
  updateReferralAccrualBodySchema,
} from "./referral.validation";

const referralRouter = Router();

referralRouter.use(authMiddleware);

referralRouter.get(
  "/accruals",
  permissionMiddleware(PERMISSIONS.REFERRAL_LIST),
  validate({ query: listReferralAccrualQuerySchema }),
  listReferralAccrualController,
);

referralRouter.patch(
  "/accruals/:id",
  permissionMiddleware(PERMISSIONS.REFERRAL_SETTLE),
  validate({ params: referralAccrualIdParamSchema, body: updateReferralAccrualBodySchema }),
  updateReferralAccrualController,
);

referralRouter.post(
  "/settle",
  permissionMiddleware(PERMISSIONS.REFERRAL_SETTLE),
  validate({ body: settleReferralAccrualBodySchema }),
  settleReferralAccrualController,
);

export { referralRouter };
