import { Router } from "express";
import multer from "multer";
import { authMiddleware } from "../../shared/middlewares/auth.middleware";
import { permissionMiddleware } from "../../shared/middlewares/permission.middleware";
import { requireSuperadminMiddleware } from "../../shared/middlewares/superadmin.middleware";
import { PERMISSIONS } from "../../shared/constants/permissions";
import { validate } from "../../shared/middlewares/validate.middleware";
import { expenseListPermissionMiddleware } from "./expense.list.middleware";
import { expenseTypesReadMiddleware } from "./expenseTypes.middleware";
import {
  approveExpenseController,
  cancelExpenseController,
  createExpenseController,
  expenseDocumentViewUrlController,
  exportExpenseController,
  getExpenseController,
  listExpenseController,
  listExpenseTypesController,
  rejectExpenseController,
  uploadExpenseDocumentsController,
  updateExpenseController,
} from "./expense.controller";
import {
  approveExpenseBodySchema,
  cancelExpenseBodySchema,
  createExpenseBodySchema,
  expenseDocumentViewParamsSchema,
  expenseIdParamSchema,
  listExpenseQuerySchema,
  rejectExpenseBodySchema,
  updateExpenseBodySchema,
} from "./expense.validation";

const expenseRouter = Router();
const expenseDocumentsUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024,
    files: 5,
  },
  fileFilter: (_req, file, cb) => {
    const isAllowed = /^(application\/pdf|image\/(jpeg|jpg|png|webp))$/i.test(file.mimetype);
    if (!isAllowed) {
      cb(new Error("Only PDF, JPG, JPEG, PNG, and WEBP files are allowed"));
      return;
    }
    cb(null, true);
  },
});

expenseRouter.use(authMiddleware);

expenseRouter.post(
  "/",
  permissionMiddleware(PERMISSIONS.EXPENSE_ADD),
  validate({ body: createExpenseBodySchema }),
  createExpenseController,
);

expenseRouter.patch(
  "/:id",
  permissionMiddleware(PERMISSIONS.EXPENSE_LIST),
  validate({ params: expenseIdParamSchema, body: updateExpenseBodySchema }),
  updateExpenseController,
);

expenseRouter.get(
  "/",
  expenseListPermissionMiddleware,
  validate({ query: listExpenseQuerySchema }),
  listExpenseController,
);

expenseRouter.get(
  "/export",
  expenseListPermissionMiddleware,
  validate({ query: listExpenseQuerySchema }),
  exportExpenseController,
);

expenseRouter.get("/expense-types", expenseTypesReadMiddleware, listExpenseTypesController);

expenseRouter.get("/:id", expenseListPermissionMiddleware, validate({ params: expenseIdParamSchema }), getExpenseController);

expenseRouter.post(
  "/:id/approve",
  permissionMiddleware(PERMISSIONS.EXPENSE_AUDIT),
  validate({ params: expenseIdParamSchema, body: approveExpenseBodySchema }),
  approveExpenseController,
);

expenseRouter.post(
  "/:id/reject",
  permissionMiddleware(PERMISSIONS.EXPENSE_AUDIT),
  validate({ params: expenseIdParamSchema, body: rejectExpenseBodySchema }),
  rejectExpenseController,
);

expenseRouter.post(
  "/:id/cancel",
  requireSuperadminMiddleware,
  validate({ params: expenseIdParamSchema, body: cancelExpenseBodySchema }),
  cancelExpenseController,
);

expenseRouter.post(
  "/:id/documents",
  permissionMiddleware(PERMISSIONS.EXPENSE_ADD),
  (req, res, next) => {
    expenseDocumentsUpload.array("documents", 5)(req, res, (err: unknown) => {
      if (err) {
        const message = err instanceof Error ? err.message : "Upload failed";
        res.status(400).json({ success: false, message });
        return;
      }
      next();
    });
  },
  validate({ params: expenseIdParamSchema }),
  uploadExpenseDocumentsController,
);

expenseRouter.get(
  "/:id/documents/:docIndex/view",
  expenseListPermissionMiddleware,
  validate({ params: expenseDocumentViewParamsSchema }),
  expenseDocumentViewUrlController,
);

export { expenseRouter };
