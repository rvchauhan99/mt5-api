import AWS from "aws-sdk";
import path from "path";
import crypto from "crypto";
import { env } from "../../config/env";
import { logger } from "../logger";

// Lazy-loaded S3 client
let s3Client: AWS.S3 | null = null;
let bucketName: string | null = null;

export function getClient(): { s3: AWS.S3; bucketName: string } {
  if (s3Client && bucketName) {
    return { s3: s3Client, bucketName };
  }

  const endpoint = env.bucketEndpoint;
  const name = env.bucketName;
  const accessKeyId = env.bucketAccessKeyId;
  const secretAccessKey = env.bucketSecretAccessKey;

  if (!endpoint || !name || !accessKeyId || !secretAccessKey) {
    const msg = "Bucket config missing: missing endpoint, name, access key, or secret key in env";
    logger.warn(msg);
    throw new Error(msg);
  }

  const s3Endpoint = new AWS.Endpoint(endpoint);
  s3Client = new AWS.S3({
    endpoint: s3Endpoint,
    accessKeyId,
    secretAccessKey,
    region: env.bucketRegion || "auto",
    s3ForcePathStyle: true,
    signatureVersion: "v4",
  });
  
  bucketName = name;
  return { s3: s3Client, bucketName };
}

export function generateFilePath(prefix: string, originalFilename: string): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const fileExtension = path.extname(originalFilename);
  const baseName = path.basename(originalFilename, fileExtension);
  const uniqueId = crypto.randomBytes(8).toString("hex");
  const filename = `${baseName}_${uniqueId}${fileExtension}`;
  return `${prefix}/${year}/${month}/${filename}`;
}

interface UploadOptions {
  prefix?: string;
  acl?: "private" | "public-read";
  contentType?: string;
  customKey?: string;
}

interface FileLike {
  buffer: Buffer;
  originalname: string;
  mimetype: string;
  size?: number;
}

export async function uploadFile(
  file: FileLike,
  optionsOrPrefix?: string | UploadOptions
) {
  if (!file) throw new Error("File is required");
  const { s3, bucketName: bucket } = getClient();
  
  const options = typeof optionsOrPrefix === "string"
    ? { prefix: optionsOrPrefix, acl: "private" as const }
    : { acl: "private" as const, ...optionsOrPrefix };

  const prefix = options.prefix || "";
  const acl = options.acl === "public-read" ? "public-read" : "private";
  const contentType = options.contentType || file.mimetype;
  const originalName = file.originalname || "file";
  const size = file.size != null ? file.size : (file.buffer && file.buffer.length) || 0;

  const key = options.customKey
    ? options.customKey
    : prefix
      ? generateFilePath(prefix, originalName)
      : generateFilePath("uploads", originalName);

  const params = {
    Bucket: bucket,
    Key: key,
    Body: file.buffer,
    ContentType: contentType,
    ACL: acl,
  };

  try {
    await s3.upload(params).promise();
    logger.info({ bucket, key, size }, "File uploaded successfully to bucket");
    return {
      path: key,
      filename: originalName,
      size,
      mime_type: contentType,
      uploaded_at: new Date().toISOString(),
    };
  } catch (error) {
    logger.error({ err: error, bucket, key }, "Failed to upload file");
    if (error instanceof Error) {
      throw new Error(`Failed to upload file: ${error.message}`, { cause: error });
    }
    throw error;
  }
}

export async function deleteFile(key: string): Promise<boolean> {
  if (!key) throw new Error("File path (key) is required");
  const { s3, bucketName: bucket } = getClient();
  try {
    await s3.deleteObject({ Bucket: bucket, Key: key }).promise();
    logger.info({ bucket, key }, "File deleted from bucket");
    return true;
  } catch (error) {
    logger.error({ err: error, bucket, key }, "Failed to delete file");
    if (error instanceof Error) {
      throw new Error(`Failed to delete file: ${error.message}`, { cause: error });
    }
    throw error;
  }
}

export async function getSignedUrl(key: string, expiresIn = 3600): Promise<string> {
  const k = key != null ? String(key).trim() : "";
  if (!k) throw new Error("File path (key) is required");
  const { s3, bucketName: bucket } = getClient();
  try {
    const url = await s3.getSignedUrlPromise("getObject", {
      Bucket: bucket,
      Key: k,
      Expires: expiresIn,
    });
    logger.info({ bucket, key: k }, "Generated signed URL");
    return url;
  } catch (error) {
    logger.error({ err: error, bucket, key: k }, "Failed to generate signed URL");
    if (error instanceof Error) {
      throw new Error(`Failed to generate signed URL: ${error.message}`, { cause: error });
    }
    throw error;
  }
}

export async function fileExists(key: string): Promise<boolean> {
  if (!key) return false;
  const { s3, bucketName: bucket } = getClient();
  try {
    await s3.headObject({ Bucket: bucket, Key: key }).promise();
    return true;
  } catch (error: any) {
    if (error.code === "NotFound" || error.statusCode === 404) return false;
    throw error;
  }
}
