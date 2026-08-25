import { Request, Response } from "express";
import { StatusCodes } from "http-status-codes";
import { createUser, listPermissions, listUsers, exportUsers, updateUser, deleteUser, resetUserPassword } from "./user.service";

export async function createUserController(req: Request, res: Response) {
  // @ts-ignore
  const { userId, role } = req.user;
  const data = req.body;

  const result = await createUser(userId, role, {
    fullName: data.fullName,
    email: data.email,
    username: data.username,
    passwordRaw: data.password,
    role: data.role,
    permissions: data.permissions || [],
    timezone: data.timezone,
  });

  res.status(StatusCodes.CREATED).json({ success: true, data: result });
}

export async function listUsersController(req: Request, res: Response) {
  // @ts-ignore
  const { role } = req.user;
  const { page, limit, q, status, role: roleFilter, sortBy, sortOrder, fullName, email, username } = req.query;
  
  const result = await listUsers(role, {
    page: page ? Number(page) : undefined,
    limit: limit ? Number(limit) : undefined,
    q: q as string,
    status: status as string,
    role: roleFilter as string,
    sortBy: sortBy as string,
    sortOrder: sortOrder as string,
    fullName: fullName as string,
    email: email as string,
    username: username as string,
  });
  res.status(StatusCodes.OK).json({ success: true, ...result });
}

export async function listPermissionsController(_req: Request, res: Response) {
  const data = await listPermissions();
  res.status(StatusCodes.OK).json({ success: true, data });
}

export async function exportUsersController(req: Request, res: Response) {
  // @ts-ignore
  const { role } = req.user;
  const { q, status, role: roleFilter, fullName, email, username } = req.query;

  const buffer = await exportUsers(role, {
    q: q as string,
    status: status as string,
    role: roleFilter as string,
    fullName: fullName as string,
    email: email as string,
    username: username as string,
  });

  res.setHeader("Content-Disposition", "attachment; filename=\"users-export.xlsx\"");
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.send(buffer);
}

export async function updateUserController(req: Request, res: Response) {
  // @ts-ignore
  const { role } = req.user;
  const { id } = req.params;
  const result = await updateUser(role, id as string, req.body);
  res.status(StatusCodes.OK).json({ success: true, data: result });
}

export async function deleteUserController(req: Request, res: Response) {
  // @ts-ignore
  const { role } = req.user;
  const { id } = req.params;
  await deleteUser(role, id as string);
  res.status(StatusCodes.OK).json({ success: true, message: "User deleted successfully" });
}

export async function resetUserPasswordController(req: Request, res: Response) {
  // @ts-ignore
  const { role } = req.user;
  const { id } = req.params;
  const { new_password } = req.body;
  await resetUserPassword(role, id as string, new_password);
  res.status(StatusCodes.OK).json({ success: true, message: "Password reset successfully" });
}
