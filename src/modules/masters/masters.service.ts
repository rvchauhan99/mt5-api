import type { Model } from "mongoose";
import { Types } from "mongoose";
import type { Schema, SchemaType } from "mongoose";
import { AppError } from "../../shared/errors/AppError";
import { invalidateCacheDomains } from "../../shared/cache/domainCache";
import {
  getMasterModel,
  getRegistryEntry,
  MASTERS_REGISTRY,
  type MasterModelKey,
  type MasterRegistryEntry,
} from "./masters.registry";

export type MasterFieldType = "STRING" | "TEXT" | "BOOLEAN" | "INTEGER" | "DECIMAL" | "DATE";

export type MasterField = {
  name: string;
  type: MasterFieldType;
  required: boolean;
};

const SKIP_IN_FIELDS: Set<string> = new Set([
  "_id",
  "__v",
  "id",
  "createdAt",
  "updatedAt",
  "createdBy",
  "updatedBy",
  "deletedAt",
]);

const SERVER_ONLY: Set<string> = new Set([
  "_id",
  "__v",
  "createdAt",
  "updatedAt",
  "createdBy",
  "updatedBy",
  "deletedAt",
]);

function cacheDomainsForModel(modelKey: MasterModelKey): string[] {
  if (modelKey === "expenseType") return ["expenseType"];
  if (modelKey === "exchangeRate") return ["exchangeRate"];
  // Bank lookup embeds payment-method activation flags — bump bank cache too.
  if (modelKey === "paymentMethod") return ["paymentMethod", "bank"];
  return [];
}

function pathToFieldType(path: SchemaType, pathName: string): MasterFieldType {
  const inst = path.instance;
  if (inst === "String") {
    if (pathName === "description" || pathName.toLowerCase().endsWith("description")) return "TEXT";
    return "STRING";
  }
  if (inst === "Boolean") return "BOOLEAN";
  if (inst === "Number") {
    if (pathName === "rate") return "DECIMAL";
    return "INTEGER";
  }
  if (inst === "Date") return "DATE";
  return "STRING";
}

export function buildFieldsFromModel(model: Model<unknown>): MasterField[] {
  const schema = model.schema as Schema;
  const fields: MasterField[] = [];
  schema.eachPath((pathname, schematype) => {
    if (SKIP_IN_FIELDS.has(pathname)) return;
    const st = schematype as SchemaType;
    if (st.instance === "ObjectID" || String(pathname).endsWith("._id")) return;
    const isRequired = Boolean((st as { isRequired?: boolean }).isRequired);
    fields.push({
      name: pathname,
      type: pathToFieldType(st, pathname),
      required: isRequired,
    });
  });
  return fields;
}

export function listRegistry(): MasterRegistryEntry[] {
  return [...MASTERS_REGISTRY].sort((a, b) => a.name.localeCompare(b.name));
}

export type ListMastersParams = {
  page: number;
  limit: number;
  q?: string;
  visibility: "active" | "inactive" | "all";
  sortBy?: string;
  sortOrder: "asc" | "desc";
};

function visibilityFilter(visibility: ListMastersParams["visibility"]): Record<string, unknown> {
  if (visibility === "active") {
    return { $or: [{ deletedAt: null }, { deletedAt: { $exists: false } }] };
  }
  if (visibility === "inactive") {
    return { deletedAt: { $ne: null } };
  }
  return {};
}

function stringSearchablePaths(model: Model<unknown>): string[] {
  const schema = model.schema as Schema;
  const paths: string[] = [];
  schema.eachPath((pathname, schematype) => {
    if (SKIP_IN_FIELDS.has(pathname)) return;
    const st = schematype as SchemaType;
    if (st.instance === "String") paths.push(pathname);
  });
  return paths;
}

function defaultSortField(modelKey: MasterModelKey): string {
  return "createdAt";
}

function allowedSortFields(model: Model<unknown>): string[] {
  const base = buildFieldsFromModel(model).map((f) => f.name);
  return [...new Set([...base, "createdAt", "updatedAt"])];
}

export async function listMasters(modelKey: string, params: ListMastersParams) {
  const entry = getRegistryEntry(modelKey);
  const Model = getMasterModel(modelKey);
  if (!entry || !Model) {
    throw new AppError("not_found", "Unknown master type", 404);
  }

  const { page, limit, q, visibility, sortOrder } = params;
  const sortBy = params.sortBy && params.sortBy.trim() !== "" ? params.sortBy : defaultSortField(entry.modelKey);
  const allowed = allowedSortFields(Model);
  const safeSortBy = allowed.includes(sortBy) ? sortBy : defaultSortField(entry.modelKey);
  const sort: Record<string, 1 | -1> = { [safeSortBy]: sortOrder === "asc" ? 1 : -1 };

  const conditions: Record<string, unknown>[] = [];
  const vis = visibilityFilter(visibility);
  if (Object.keys(vis).length > 0) conditions.push(vis);

  const qTrim = q?.trim();
  if (qTrim) {
    const esc = qTrim.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const or = stringSearchablePaths(Model).map((p) => ({
      [p]: { $regex: esc, $options: "i" },
    }));
    if (or.length > 0) conditions.push({ $or: or });
  }

  const filter: Record<string, unknown> =
    conditions.length === 0 ? {} : conditions.length === 1 ? conditions[0]! : { $and: conditions };

  const skip = (page - 1) * limit;
  const [rows, total] = await Promise.all([
    Model.find(filter).sort(sort).skip(skip).limit(limit).lean().exec(),
    Model.countDocuments(filter),
  ]);

  let fields = buildFieldsFromModel(Model);
  // Guarantee payment-method activation toggles appear in Masters UI even if schema was stale.
  if (entry.modelKey === "paymentMethod") {
    const ensureBoolean = (name: string) => {
      if (!fields.some((f) => f.name === name)) {
        fields = [...fields, { name, type: "BOOLEAN", required: false }];
      }
    };
    ensureBoolean("isActiveForWithdrawalPayout");
    ensureBoolean("isActiveForDeposit");
  }

  return {
    fields,
    data: rows.map((r) => leanToPlain(r as Record<string, unknown>)),
    meta: { total, page, pageSize: limit },
  };
}

function leanToPlain(doc: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...doc };
  if (out._id != null) out._id = String(out._id);
  return out;
}

export async function getMasterById(modelKey: string, id: string) {
  const Model = getMasterModel(modelKey);
  if (!Model) {
    throw new AppError("not_found", "Unknown master type", 404);
  }
  if (!Types.ObjectId.isValid(id)) {
    throw new AppError("validation_error", "Invalid id", 400);
  }
  const row = await Model.findById(id).lean().exec();
  if (!row) {
    throw new AppError("not_found", "Record not found", 404);
  }
  return leanToPlain(row as Record<string, unknown>);
}

function pickWritablePayload(
  model: Model<unknown>,
  body: Record<string, unknown>,
): Record<string, unknown> {
  const schema = model.schema as Schema;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(body)) {
    if (SERVER_ONLY.has(key)) continue;
    if (!schema.paths[key]) continue;
    out[key] = body[key];
  }
  return out;
}

export async function createMaster(modelKey: string, body: Record<string, unknown>, actorId: string) {
  const Model = getMasterModel(modelKey);
  if (!Model) {
    throw new AppError("not_found", "Unknown master type", 404);
  }
  const userId = new Types.ObjectId(actorId);
  const payload = pickWritablePayload(Model, body);
  const doc = await Model.create({
    ...payload,
    createdBy: userId,
    updatedBy: userId,
    deletedAt: null,
  });
  const lean = await Model.findById(doc._id).lean().exec();
  const domains = cacheDomainsForModel(modelKey as MasterModelKey);
  if (domains.length > 0) await invalidateCacheDomains(domains);
  return leanToPlain(lean as Record<string, unknown>);
}

export async function updateMaster(modelKey: string, id: string, body: Record<string, unknown>, actorId: string) {
  const Model = getMasterModel(modelKey);
  if (!Model) {
    throw new AppError("not_found", "Unknown master type", 404);
  }
  if (!Types.ObjectId.isValid(id)) {
    throw new AppError("validation_error", "Invalid id", 400);
  }
  const userId = new Types.ObjectId(actorId);
  const payload = pickWritablePayload(Model, body);
  const updated = await Model.findOneAndUpdate(
    { _id: id, $or: [{ deletedAt: null }, { deletedAt: { $exists: false } }] },
    { $set: { ...payload, updatedBy: userId } },
    { returnDocument: "after" },
  )
    .lean()
    .exec();
  if (!updated) {
    throw new AppError("not_found", "Record not found", 404);
  }
  const domains = cacheDomainsForModel(modelKey as MasterModelKey);
  if (domains.length > 0) await invalidateCacheDomains(domains);
  return leanToPlain(updated as Record<string, unknown>);
}

export async function softDeleteMaster(modelKey: string, id: string, actorId: string) {
  const Model = getMasterModel(modelKey);
  if (!Model) {
    throw new AppError("not_found", "Unknown master type", 404);
  }
  if (!Types.ObjectId.isValid(id)) {
    throw new AppError("validation_error", "Invalid id", 400);
  }
  const userId = new Types.ObjectId(actorId);
  const updated = await Model.findOneAndUpdate(
    { _id: id, $or: [{ deletedAt: null }, { deletedAt: { $exists: false } }] },
    { $set: { deletedAt: new Date(), updatedBy: userId, isActive: false } },
    { returnDocument: "after" },
  )
    .lean()
    .exec();
  if (!updated) {
    throw new AppError("not_found", "Record not found", 404);
  }
  const domains = cacheDomainsForModel(modelKey as MasterModelKey);
  if (domains.length > 0) await invalidateCacheDomains(domains);
  return { success: true };
}

export function getFieldsForModelKey(modelKey: string): MasterField[] | null {
  const Model = getMasterModel(modelKey);
  if (!Model) return null;
  return buildFieldsFromModel(Model);
}
