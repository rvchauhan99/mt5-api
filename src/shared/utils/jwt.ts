import jwt, { JwtPayload } from "jsonwebtoken";
import { env } from "../../config/env";

export type AuthTokenPayload = JwtPayload & {
  userId: string;
  role: string;
  permissions: string[];
  timezone?: string;
};

export function signAccessToken(payload: AuthTokenPayload) {
  return jwt.sign(payload, env.jwtAccessSecret, { expiresIn: "6h" });
}

export function verifyAccessToken(token: string): AuthTokenPayload {
  return jwt.verify(token, env.jwtAccessSecret) as AuthTokenPayload;
}
