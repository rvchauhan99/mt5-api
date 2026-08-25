import { Router } from "express";
import {
  createUserController,
  listPermissionsController,
  listUsersController,
  exportUsersController,
  updateUserController,
  deleteUserController,
  resetUserPasswordController,
} from "./user.controller";
import { validate } from "../../shared/middlewares/validate.middleware";
import { authMiddleware } from "../../shared/middlewares/auth.middleware";
import { anyPermissionMiddleware, permissionMiddleware } from "../../shared/middlewares/permission.middleware";
import { PERMISSIONS } from "../../shared/constants/permissions";
import { createUserSchema, updateUserSchema, resetUserPasswordSchema } from "./user.validation";

const userRouter = Router();

userRouter.post(
  "/",
  authMiddleware,
  permissionMiddleware(PERMISSIONS.SUB_ADMIN_ADD),
  validate({ body: createUserSchema }),
  createUserController,
);
userRouter.get("/", authMiddleware, permissionMiddleware(PERMISSIONS.SUB_ADMIN_LIST), listUsersController);
userRouter.get("/export", authMiddleware, permissionMiddleware(PERMISSIONS.SUB_ADMIN_LIST), exportUsersController);
userRouter.get(
  "/permissions",
  authMiddleware,
  anyPermissionMiddleware([
    PERMISSIONS.SUB_ADMIN_ADD,
    PERMISSIONS.SUB_ADMIN_LIST,
    PERMISSIONS.SUB_ADMIN_EDIT,
  ]),
  listPermissionsController,
);
userRouter.put("/:id", authMiddleware, permissionMiddleware(PERMISSIONS.SUB_ADMIN_EDIT), validate({ body: updateUserSchema }), updateUserController);
userRouter.delete("/:id", authMiddleware, permissionMiddleware(PERMISSIONS.SUB_ADMIN_EDIT), deleteUserController);
userRouter.post(
  "/:id/reset-password",
  authMiddleware,
  permissionMiddleware(PERMISSIONS.SUB_ADMIN_EDIT),
  validate({ body: resetUserPasswordSchema }),
  resetUserPasswordController,
);

export { userRouter };
