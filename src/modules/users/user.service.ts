import bcrypt from "bcrypt";
import xlsx from "xlsx";
import { AppError } from "../../shared/errors/AppError";
import { UserModel, UserRole, UserDocument } from "./user.model";
import { DEFAULT_ADMIN_PERMISSIONS } from "../../shared/constants/permissions";
import { PermissionModel } from "../permissions/permission.model";

export async function createUser(
  creatorId: string,
  creatorRole: string,
  data: {
    fullName: string;
    email: string;
    username: string;
    passwordRaw: string;
    role: UserRole;
    permissions: string[];
    timezone?: string;
  }
) {
  // Role checks (route layer enforces sub_admin.add etc.)
  if (creatorRole === "sub_admin" && data.role !== "sub_admin") {
    throw new AppError("auth_error", "Sub admins can only create sub admins", 403);
  }

  if (creatorRole === "admin" && data.role !== "sub_admin") {
    throw new AppError("auth_error", "Admins can only create sub_admins", 403);
  }

  // superadmin can create admin or sub_admin
  if (creatorRole === "superadmin" && data.role === "superadmin") {
    throw new AppError("auth_error", "Cannot create additional superadmins via API", 403);
  }

  const existingUser = await UserModel.findOne({
    $or: [{ username: data.username }, { email: data.email.toLowerCase() }],
  });

  if (existingUser) {
    throw new AppError("bad_request", "Username or email already exists", 400);
  }

  const passwordHash = await bcrypt.hash(data.passwordRaw, 10);

  // Default permissions for admin
  let permissions = data.permissions;
  if (data.role === "admin") {
    permissions = DEFAULT_ADMIN_PERMISSIONS;
  }

  const user = await UserModel.create({
    fullName: data.fullName,
    email: data.email.toLowerCase(),
    username: data.username,
    passwordHash,
    role: data.role,
    status: "active",
    permissions,
    createdBy: creatorId,
    timezone: data.timezone?.trim() || "Asia/Kolkata",
  });

  return {
    id: user._id.toString(),
    username: user.username,
    role: user.role,
  };
}

export async function listUsers(
  creatorRole: string,
  query: {
    page?: number;
    limit?: number;
    q?: string;
    status?: string;
    role?: string;
    sortBy?: string;
    sortOrder?: string;
    fullName?: string;
    email?: string;
    username?: string;
  }
) {
  const { page = 1, limit = 20, q, status, role, sortBy = "createdAt", sortOrder = "DESC", fullName, email, username } = query;

  const mongoQuery: any = {};
  if (q) {
    mongoQuery.$or = [
      { fullName: { $regex: q, $options: "i" } },
      { email: { $regex: q, $options: "i" } },
      { username: { $regex: q, $options: "i" } },
    ];
  }
  if (status) mongoQuery.status = status;
  if (creatorRole === "sub_admin") {
    mongoQuery.role = "sub_admin";
  } else if (role) {
    mongoQuery.role = role;
  }
  if (fullName) mongoQuery.fullName = { $regex: fullName, $options: "i" };
  if (email) mongoQuery.email = { $regex: email, $options: "i" };
  if (username) mongoQuery.username = { $regex: username, $options: "i" };

  const sort: any = {};
  sort[sortBy] = sortOrder.toUpperCase() === "ASC" ? 1 : -1;

  const skip = (page - 1) * limit;

  const [data, total] = await Promise.all([
    UserModel.find(mongoQuery, { passwordHash: 0, resetPasswordOtp: 0, resetPasswordExpires: 0 })
      .sort(sort)
      .skip(skip)
      .limit(limit)
      .lean(),
    UserModel.countDocuments(mongoQuery),
  ]);

  return {
    data,
    meta: {
      total,
      page: Number(page),
      limit: Number(limit),
      pages: Math.ceil(total / limit),
    },
  };
}

export async function exportUsers(
  creatorRole: string,
  query: {
    q?: string;
    status?: string;
    role?: string;
    fullName?: string;
    email?: string;
    username?: string;
  }
) {
  const { q, status, role, fullName, email, username } = query;

  const mongoQuery: any = {};
  if (q) {
    mongoQuery.$or = [
      { fullName: { $regex: q, $options: "i" } },
      { email: { $regex: q, $options: "i" } },
      { username: { $regex: q, $options: "i" } },
    ];
  }
  if (status) mongoQuery.status = status;
  if (creatorRole === "sub_admin") {
    mongoQuery.role = "sub_admin";
  } else if (role) {
    mongoQuery.role = role;
  }
  if (fullName) mongoQuery.fullName = { $regex: fullName, $options: "i" };
  if (email) mongoQuery.email = { $regex: email, $options: "i" };
  if (username) mongoQuery.username = { $regex: username, $options: "i" };

  const users = await UserModel.find(mongoQuery, { passwordHash: 0, resetPasswordOtp: 0, resetPasswordExpires: 0 })
    .sort({ createdAt: -1 })
    .lean();

  const exportData = users.map(u => ({
    "Full Name": u.fullName,
    "Email": u.email,
    "Username": u.username,
    "Role": u.role,
    "Status": u.status,
    "Timezone": u.timezone || "Asia/Kolkata",
    "Created At": u.createdAt,
    "Last Login": u.lastLoginAt || "Never",
  }));

  const worksheet = xlsx.utils.json_to_sheet(exportData);
  const workbook = xlsx.utils.book_new();
  xlsx.utils.book_append_sheet(workbook, worksheet, "Users");
  const buffer = xlsx.write(workbook, { type: "buffer", bookType: "xlsx" });
  return buffer;
}

export async function updateUser(
  creatorRole: string,
  id: string,
  data: Partial<{
    fullName: string;
    email: string;
    username: string;
    role: UserRole;
    status: string;
    permissions: string[];
    timezone: string;
  }>
) {
  const user = await UserModel.findById(id);
  if (!user) throw new AppError("not_found", "User not found", 404);

  if (creatorRole === "sub_admin" && user.role !== "sub_admin") {
    throw new AppError("auth_error", "Sub admins can only update sub admins", 403);
  }

  if (creatorRole === "admin" && user.role !== "sub_admin") {
    throw new AppError("auth_error", "Admins can only update sub admins", 403);
  }

  if (creatorRole === "sub_admin" && data.role !== undefined) {
    throw new AppError("auth_error", "Sub admins cannot change user role", 403);
  }

  if (data.email && data.email !== user.email) {
    const existing = await UserModel.findOne({ email: data.email.toLowerCase() });
    if (existing && existing._id.toString() !== id) {
      throw new AppError("bad_request", "Email already in use", 400);
    }
    user.email = data.email.toLowerCase();
  }

  if (data.username && data.username !== user.username) {
    const existing = await UserModel.findOne({ username: data.username });
    if (existing && existing._id.toString() !== id) {
      throw new AppError("bad_request", "Username already in use", 400);
    }
    user.username = data.username;
  }

  if (data.fullName) user.fullName = data.fullName;
  if (data.status) user.status = data.status as any;
  if (data.role && creatorRole !== "admin") { // admins cant promote to admin
    user.role = data.role;
  }
  if (data.permissions) user.permissions = data.permissions;
  if (typeof data.timezone === "string" && data.timezone.trim()) {
    user.timezone = data.timezone.trim();
  }

  await user.save();

  return {
    id: user._id.toString(),
    username: user.username,
    role: user.role,
  };
}

export async function deleteUser(creatorRole: string, id: string) {
  const user = await UserModel.findById(id);
  if (!user) throw new AppError("not_found", "User not found", 404);

  if (creatorRole === "sub_admin" && user.role !== "sub_admin") {
    throw new AppError("auth_error", "Sub admins can only delete sub admins", 403);
  }

  if (creatorRole === "admin" && user.role !== "sub_admin") {
    throw new AppError("auth_error", "Admins can only delete sub admins", 403);
  }

  await UserModel.findByIdAndDelete(id);
  return { success: true };
}

export async function resetUserPassword(creatorRole: string, id: string, newPasswordRaw: string) {
  const user = await UserModel.findById(id);
  if (!user) throw new AppError("not_found", "User not found", 404);

  if (creatorRole === "sub_admin" && user.role !== "sub_admin") {
    throw new AppError("auth_error", "Sub admins can only change passwords of sub admins", 403);
  }

  if (creatorRole === "admin" && user.role !== "sub_admin") {
    throw new AppError("auth_error", "Admins can only change passwords of sub admins", 403);
  }

  user.passwordHash = await bcrypt.hash(newPasswordRaw, 10);
  await user.save();
  return { success: true };
}

export async function listPermissions() {
  const rows = await PermissionModel.find({ module: { $ne: "masters" } }).sort({ module: 1, action: 1 });
  return rows;
}
