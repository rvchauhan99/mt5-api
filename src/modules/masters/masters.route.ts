import { Router } from "express";
import { authMiddleware } from "../../shared/middlewares/auth.middleware";
import { requireSuperadminMiddleware } from "../../shared/middlewares/superadmin.middleware";
import {
  createMasterRecordController,
  deleteMasterRecordController,
  getMasterRecordController,
  listMasterRecordsController,
  listMastersRegistryController,
  updateMasterRecordController,
} from "./masters.controller";

const mastersRouter = Router();

mastersRouter.use(authMiddleware);
mastersRouter.use(requireSuperadminMiddleware);

mastersRouter.get("/", listMastersRegistryController);
mastersRouter.get("/:modelKey", listMasterRecordsController);
mastersRouter.post("/:modelKey", createMasterRecordController);
mastersRouter.get("/:modelKey/:id", getMasterRecordController);
mastersRouter.patch("/:modelKey/:id", updateMasterRecordController);
mastersRouter.delete("/:modelKey/:id", deleteMasterRecordController);

export { mastersRouter };
