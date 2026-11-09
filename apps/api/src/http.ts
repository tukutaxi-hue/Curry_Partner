import type { FastifyReply, FastifyRequest } from "fastify";
import { ZodError } from "zod";
import { Prisma } from "@prisma/client";
import { ApiError } from "./errors.js";
import { prisma, setActor, transaction } from "./db.js";
import { verifyAccessToken } from "./auth/tokens.js";

export type AuthContext = {
  userId: string;
  role: "ADMIN" | "HOMEMAKER";
  sessionId: string;
  mustChangePassword: boolean;
  name: string;
  phone: string;
  tokenVersion: number;
};

declare module "fastify" {
  interface FastifyRequest {
    auth?: AuthContext;
  }
}

export function actor(req: FastifyRequest): AuthContext {
  if (!req.auth) throw new ApiError(401, "UNAUTHORIZED", "Sign in required.");
  return req.auth;
}

export async function authenticate(req: FastifyRequest) {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) throw new ApiError(401, "UNAUTHORIZED", "Sign in required.");
  let claims;
  try {
    claims = await verifyAccessToken(header.slice("Bearer ".length));
  } catch {
    throw new ApiError(401, "UNAUTHORIZED", "Sign in required.");
  }
  const auth = await transaction({ userId: claims.sub, role: claims.role }, async (tx) => {
    const user = await tx.user.findUnique({
      where: { id: claims.sub },
      select: {
        id: true,
        role: true,
        phone: true,
        name: true,
        mustChangePassword: true,
        accountStatus: true,
        tokenVersion: true,
      },
    });
    const session = await tx.session.findUnique({ where: { id: claims.sid } });
    if (!user || !session) return null;
    if (user.role !== claims.role || user.tokenVersion !== claims.tv) return null;
    if (user.accountStatus !== "ACTIVE") return null;
    if (session.userId !== user.id || session.revokedAt || session.expiresAt.getTime() <= Date.now()) return null;
    return {
      userId: user.id,
      role: user.role,
      sessionId: session.id,
      mustChangePassword: user.mustChangePassword,
      name: user.name,
      phone: user.phone,
      tokenVersion: user.tokenVersion,
    } satisfies AuthContext;
  });
  if (!auth) throw new ApiError(401, "UNAUTHORIZED", "Sign in required.");
  req.auth = auth;
}

export async function requireRoles(req: FastifyRequest, roles: Array<AuthContext["role"]>) {
  await authenticate(req);
  const current = actor(req);
  if (!roles.includes(current.role)) throw new ApiError(403, "FORBIDDEN", "You do not have access to this.");
  if (current.mustChangePassword) {
    throw new ApiError(403, "PASSWORD_CHANGE_REQUIRED", "Set a new password before continuing.");
  }
}

export function idempotencyHeader(req: FastifyRequest): string | undefined {
  const value = req.headers["idempotency-key"];
  return Array.isArray(value) ? value[0] : value;
}

export function userAgent(req: FastifyRequest): string {
  const value = req.headers["user-agent"];
  const agent = Array.isArray(value) ? value[0] : value;
  return (agent ?? "unknown").slice(0, 200);
}

export function sendError(reply: FastifyReply, error: unknown) {
  if (error instanceof ApiError) {
    return reply.status(error.statusCode).send({
      error: { code: error.code, message: error.message, details: error.details },
    });
  }
  if (error instanceof ZodError) {
    return reply.status(400).send({
      error: {
        code: "VALIDATION",
        message: "Check the submitted fields.",
        details: error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
      },
    });
  }
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
    return reply.status(409).send({ error: { code: "CONFLICT", message: "That record conflicts with one that already exists." } });
  }
  reqLog(error);
  return reply.status(500).send({ error: { code: "INTERNAL", message: "Something went wrong. Try again." } });
}

function reqLog(error: unknown) {
  const message = error instanceof Error ? error.message : "Unknown error";
  console.error(message);
}

export async function revokeSession(sessionId: string, userId: string, role: "ADMIN" | "HOMEMAKER") {
  await transaction({ userId, role }, async (tx) => {
    await setActor(tx, { userId, role });
    await tx.session.update({ where: { id: sessionId }, data: { revokedAt: new Date() } });
  });
}

export async function dbReady() {
  await prisma.$queryRaw`SELECT 1`;
}
