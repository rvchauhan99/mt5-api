import { Router } from "express";
import multer from "multer";
import { authMiddleware } from "../../shared/middlewares/auth.middleware";
import { anyPermissionMiddleware, permissionMiddleware } from "../../shared/middlewares/permission.middleware";
import { requireSuperadminMiddleware } from "../../shared/middlewares/superadmin.middleware";
import { PERMISSIONS } from "../../shared/constants/permissions";
import { validate } from "../../shared/middlewares/validate.middleware";
import {
  amendWithdrawalController,
  bulkBankerApproveController,
  createBulkBankerApproveJobController,
  createWithdrawalController,
  createWithdrawalImportJobController,
  deleteWithdrawalController,
  downloadWithdrawalImportJobErrorCsvController,
  getBulkBankerApproveJobController,
  getWithdrawalImportJobController,
  listSavedAccountsController,
  listWithdrawalController,
  sampleWithdrawalCsvController,
  streamWithdrawalApprovalQueueEventsController,
  streamBulkBankerApproveJobEventsController,
  streamWithdrawalImportJobEventsController,
  updateWithdrawalExchangeController,
  updateWithdrawalBankerController,
  updateWithdrawalStatusController,
  exportWithdrawalController,
  validateWithdrawalImportController,
} from "./withdrawal.controller";
import { withdrawalListPermissionMiddleware } from "./withdrawal.list.middleware";
import { withdrawalStatusPermissionMiddleware } from "./withdrawal.status.middleware";
import {
  approvalQueueEventsQuerySchema,
  amendWithdrawalBodySchema,
  bulkBankerApproveBodySchema,
  createBulkBankerApproveJobBodySchema,
  createWithdrawalBodySchema,
  createWithdrawalImportJobBodySchema,
  exportWithdrawalQuerySchema,
  listWithdrawalQuerySchema,
  updateWithdrawalBodySchema,
  updateWithdrawalStatusBodySchema,
  withdrawalBankerPayoutBodySchema,
} from "./withdrawal.validation";

const withdrawalRouter = Router();

withdrawalRouter.use(authMiddleware);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ok = /\.(csv|xlsx|xls)$/i.test(file.originalname);
    if (!ok) {
      cb(new Error("Only .csv, .xlsx, .xls files are allowed"));
      return;
    }
    cb(null, true);
  },
});

const WITHDRAWAL_ENTRY_PERMISSIONS = [PERMISSIONS.WITHDRAWAL_EXCHANGE, PERMISSIONS.WITHDRAWAL_BANKER] as const;

withdrawalRouter.get(
  "/import/sample",
  anyPermissionMiddleware([...WITHDRAWAL_ENTRY_PERMISSIONS]),
  sampleWithdrawalCsvController,
);

withdrawalRouter.post(
  "/import/validate",
  anyPermissionMiddleware([...WITHDRAWAL_ENTRY_PERMISSIONS]),
  upload.single("file"),
  validateWithdrawalImportController,
);

withdrawalRouter.post(
  "/import/jobs",
  anyPermissionMiddleware([...WITHDRAWAL_ENTRY_PERMISSIONS]),
  validate({ body: createWithdrawalImportJobBodySchema }),
  createWithdrawalImportJobController,
);

withdrawalRouter.get(
  "/import/jobs/:jobId",
  anyPermissionMiddleware([...WITHDRAWAL_ENTRY_PERMISSIONS]),
  getWithdrawalImportJobController,
);

withdrawalRouter.get(
  "/import/jobs/:jobId/events",
  anyPermissionMiddleware([...WITHDRAWAL_ENTRY_PERMISSIONS]),
  streamWithdrawalImportJobEventsController,
);

withdrawalRouter.get(
  "/import/jobs/:jobId/errors.csv",
  anyPermissionMiddleware([...WITHDRAWAL_ENTRY_PERMISSIONS]),
  downloadWithdrawalImportJobErrorCsvController,
);

withdrawalRouter.post(
  "/bulk-banker-approve",
  anyPermissionMiddleware([...WITHDRAWAL_ENTRY_PERMISSIONS]),
  validate({ body: bulkBankerApproveBodySchema }),
  bulkBankerApproveController,
);

withdrawalRouter.post(
  "/bulk-banker-approve/jobs",
  anyPermissionMiddleware([...WITHDRAWAL_ENTRY_PERMISSIONS]),
  validate({ body: createBulkBankerApproveJobBodySchema }),
  createBulkBankerApproveJobController,
);

withdrawalRouter.get(
  "/bulk-banker-approve/jobs/:jobId",
  anyPermissionMiddleware([...WITHDRAWAL_ENTRY_PERMISSIONS]),
  getBulkBankerApproveJobController,
);

withdrawalRouter.get(
  "/bulk-banker-approve/jobs/:jobId/events",
  anyPermissionMiddleware([...WITHDRAWAL_ENTRY_PERMISSIONS]),
  streamBulkBankerApproveJobEventsController,
);

withdrawalRouter.post(
  "/",
  anyPermissionMiddleware([...WITHDRAWAL_ENTRY_PERMISSIONS]),
  validate({ body: createWithdrawalBodySchema }),
  createWithdrawalController,
);

withdrawalRouter.get(
  "/player/:playerId/saved-accounts",
  anyPermissionMiddleware([...WITHDRAWAL_ENTRY_PERMISSIONS]),
  listSavedAccountsController,
);

withdrawalRouter.patch(
  "/:id",
  anyPermissionMiddleware([...WITHDRAWAL_ENTRY_PERMISSIONS]),
  validate({ body: updateWithdrawalBodySchema }),
  updateWithdrawalExchangeController,
);

withdrawalRouter.patch(
  "/:id/banker-payout",
  anyPermissionMiddleware([...WITHDRAWAL_ENTRY_PERMISSIONS]),
  validate({ body: withdrawalBankerPayoutBodySchema }),
  updateWithdrawalBankerController,
);

withdrawalRouter.post(
  "/:id/amend",
  permissionMiddleware(PERMISSIONS.WITHDRAWAL_FINAL_VIEW),
  validate({ body: amendWithdrawalBodySchema }),
  amendWithdrawalController,
);

withdrawalRouter.patch(
  "/:id/status",
  withdrawalStatusPermissionMiddleware,
  validate({ body: updateWithdrawalStatusBodySchema }),
  updateWithdrawalStatusController,
);

withdrawalRouter.get(
  "/approval-queue/events",
  withdrawalListPermissionMiddleware,
  validate({ query: approvalQueueEventsQuerySchema }),
  streamWithdrawalApprovalQueueEventsController,
);

withdrawalRouter.get(
  "/export",
  withdrawalListPermissionMiddleware,
  validate({ query: exportWithdrawalQuerySchema }),
  exportWithdrawalController,
);

withdrawalRouter.get(
  "/",
  withdrawalListPermissionMiddleware,
  validate({ query: listWithdrawalQuerySchema }),
  listWithdrawalController,
);

withdrawalRouter.delete("/:id", requireSuperadminMiddleware, deleteWithdrawalController);

export { withdrawalRouter };
