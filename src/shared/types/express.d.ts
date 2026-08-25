import { JwtPayload } from "jsonwebtoken";

declare global {
  namespace Express {
    interface Request {
      requestId?: string;
      user?: JwtPayload & { userId: string; role: string; permissions: string[]; timezone?: string };
    }
  }
}

export {};
