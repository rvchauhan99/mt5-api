import { Router } from "express";
import multer from "multer";
import { authMiddleware } from "../../shared/middlewares/auth.middleware";
import { anyPermissionMiddleware, permissionMiddleware } from "../../shared/middlewares/permission.middleware";
import { requireSuperadminMiddleware } from "../../shared/middlewares/superadmin.middleware";
import { PERMISSIONS } from "../../shared/constants/permissions";
import { validate } from "../../shared/middlewares/validate.middleware";
import {
  amendDepositController,
  commitDepositImportController,
  createDepositController,
  createDepositImportJobController,
  deleteDepositController,
  downloadDepositImportJobErrorCsvController,
  bulkExchangeApproveController,
  createBulkExchangeApproveJobController,
  getBulkExchangeApproveJobController,
  streamBulkExchangeApproveJobEventsController,
  exchangeActionController,
  exportDepositController,
  getDepositImportJobController,
  listDepositController,
  sampleDepositCsvController,
  streamDepositImportJobEventsController,
  streamDepositApprovalQueueEventsController,
  updateDepositController,
  validateDepositImportController,
} from "./deposit.controller";
import { depositListPermissionMiddleware } from "./deposit.list.middleware";
import {
  approvalQueueEventsQuerySchema,
  amendDepositBodySchema,
  commitDepositImportBodySchema,
  createDepositImportJobBodySchema,
  createDepositBodySchema,
  bulkExchangeApproveBodySchema,
  createBulkExchangeApproveJobBodySchema,
  exchangeActionBodySchema,
  listDepositQuerySchema,
  updateDepositBodySchema,
} from "./deposit.validation";

const depositRouter = Router();

depositRouter.use(authMiddleware);

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

depositRouter.get(
  "/import/sample",
  permissionMiddleware(PERMISSIONS.DEPOSIT_BANKER),
  sampleDepositCsvController,
);

depositRouter.post(
  "/import/validate",
  permissionMiddleware(PERMISSIONS.DEPOSIT_BANKER),
  upload.single("file"),
  validateDepositImportController,
);

depositRouter.post(
  "/import/commit",
  permissionMiddleware(PERMISSIONS.DEPOSIT_BANKER),
  validate({ body: commitDepositImportBodySchema }),
  commitDepositImportController,
);

depositRouter.post(
  "/import/jobs",
  permissionMiddleware(PERMISSIONS.DEPOSIT_BANKER),
  validate({ body: createDepositImportJobBodySchema }),
  createDepositImportJobController,
);

depositRouter.get(
  "/import/jobs/:jobId",
  permissionMiddleware(PERMISSIONS.DEPOSIT_BANKER),
  getDepositImportJobController,
);

depositRouter.get(
  "/import/jobs/:jobId/events",
  permissionMiddleware(PERMISSIONS.DEPOSIT_BANKER),
  streamDepositImportJobEventsController,
);

depositRouter.get(
  "/import/jobs/:jobId/errors.csv",
  permissionMiddleware(PERMISSIONS.DEPOSIT_BANKER),
  downloadDepositImportJobErrorCsvController,
);

depositRouter.post(
  "/",
  permissionMiddleware(PERMISSIONS.DEPOSIT_BANKER),
  validate({ body: createDepositBodySchema }),
  createDepositController,
);

depositRouter.put(
  "/:id",
  permissionMiddleware(PERMISSIONS.DEPOSIT_BANKER),
  validate({ body: updateDepositBodySchema }),
  updateDepositController,
);

depositRouter.get(
  "/approval-queue/events",
  depositListPermissionMiddleware,
  validate({ query: approvalQueueEventsQuerySchema }),
  streamDepositApprovalQueueEventsController,
);

depositRouter.get(
  "/export",
  depositListPermissionMiddleware,
  validate({ query: listDepositQuerySchema }),
  exportDepositController,
);

depositRouter.get(
  "/",
  depositListPermissionMiddleware,
  validate({ query: listDepositQuerySchema }),
  listDepositController,
);

depositRouter.post(
  "/bulk-exchange-approve",
  permissionMiddleware(PERMISSIONS.DEPOSIT_EXCHANGE),
  validate({ body: bulkExchangeApproveBodySchema }),
  bulkExchangeApproveController,
);

depositRouter.post(
  "/bulk-exchange-approve/jobs",
  permissionMiddleware(PERMISSIONS.DEPOSIT_EXCHANGE),
  validate({ body: createBulkExchangeApproveJobBodySchema }),
  createBulkExchangeApproveJobController,
);

depositRouter.get(
  "/bulk-exchange-approve/jobs/:jobId",
  permissionMiddleware(PERMISSIONS.DEPOSIT_EXCHANGE),
  getBulkExchangeApproveJobController,
);

depositRouter.get(
  "/bulk-exchange-approve/jobs/:jobId/events",
  permissionMiddleware(PERMISSIONS.DEPOSIT_EXCHANGE),
  streamBulkExchangeApproveJobEventsController,
);

depositRouter.post(
  "/:id/exchange-action",
  permissionMiddleware(PERMISSIONS.DEPOSIT_EXCHANGE),
  validate({ body: exchangeActionBodySchema }),
  exchangeActionController,
);

depositRouter.post(
  "/:id/amend",
  anyPermissionMiddleware([PERMISSIONS.DEPOSIT_FINAL_VIEW]),
  validate({ body: amendDepositBodySchema }),
  amendDepositController,
);

depositRouter.delete("/:id", requireSuperadminMiddleware, deleteDepositController);

export { depositRouter };
