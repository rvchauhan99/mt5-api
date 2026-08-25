import { Request, Response } from "express";
import { StatusCodes } from "http-status-codes";
import {
  createMaster,
  getMasterById,
  listMasters,
  listRegistry,
  softDeleteMaster,
  updateMaster,
} from "./masters.service";
import {
  listMastersQuerySchema,
  modelKeyIdParamSchema,
  modelKeyParamSchema,
  parseCreateBody,
  parseUpdateBody,
} from "./masters.validation";
import type { MasterModelKey } from "./masters.registry";

export function listMastersRegistryController(_req: Request, res: Response) {
  const data = listRegistry();
  res.status(StatusCodes.OK).json({ success: true, data });
}

export async function listMasterRecordsController(req: Request, res: Response) {
  const { modelKey } = modelKeyParamSchema.parse(req.params);
  const query = listMastersQuerySchema.parse(req.query);
  const result = await listMasters(modelKey, {
    page: query.page,
    limit: query.limit,
    q: query.q,
    visibility: query.visibility,
    sortBy: query.sortBy,
    sortOrder: query.sortOrder,
  });
  res.status(StatusCodes.OK).json({
    success: true,
    data: result.data,
    meta: result.meta,
    fields: result.fields,
  });
}

export async function getMasterRecordController(req: Request, res: Response) {
  const { modelKey, id } = modelKeyIdParamSchema.parse(req.params);
  const data = await getMasterById(modelKey, id);
  res.status(StatusCodes.OK).json({ success: true, data });
}

export async function createMasterRecordController(req: Request, res: Response) {
  const { modelKey } = modelKeyParamSchema.parse(req.params);
  const body = parseCreateBody(modelKey as MasterModelKey, req.body);
  const data = await createMaster(modelKey, body, req.user!.userId);
  res.status(StatusCodes.CREATED).json({ success: true, data });
}

export async function updateMasterRecordController(req: Request, res: Response) {
  const { modelKey, id } = modelKeyIdParamSchema.parse(req.params);
  const body = parseUpdateBody(modelKey as MasterModelKey, req.body);
  const data = await updateMaster(modelKey, id, body, req.user!.userId);
  res.status(StatusCodes.OK).json({ success: true, data });
}

export async function deleteMasterRecordController(req: Request, res: Response) {
  const { modelKey, id } = modelKeyIdParamSchema.parse(req.params);
  const data = await softDeleteMaster(modelKey, id, req.user!.userId);
  res.status(StatusCodes.OK).json({ success: true, data });
}
