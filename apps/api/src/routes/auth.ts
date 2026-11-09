import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { config } from "../config.js";
import { prisma, setActor } from "../db.js";
import { ApiError } from "../errors.js";
import { hashPassword, hashToken, newRefreshToken, verifyPassword } from "../auth/passwords.js";
import { signAccessToken } from "../auth/tokens.js";
import { normalizePhone } from "../phone.js";
import { actor, authenticate, userAgent } from "../http.js";
import { audit } from "../domain/support.js";

const REFRESH_COOKIE = "cp_refresh";
const refreshTtlMs = 30 * 24 * 60 * 60 * 1000;

const loginSchema = z.object({
  phone: z.string().min(8).max(20),
  password: z.string().min(1).max(200),
  client: z.enum(["web", "mobile"]).default("web"),
});

const passwordSchema = z
  .object({
    currentPassword: z.string().min(1).max(200),
    newPassword: z.string().min(10).max(200),
  })
  .refine((value) => /[A-Za-z]/.test(value.newPassword) && /\d/.test(value.newPassword), {
    message: "Use at least 10 characters with a letter and a number.",
    path: ["newPassword"],
  })
  .refine((value) => value.currentPassword !== value.newPassword, {
    message: "Choose a password that is different from the current one.",
    path: ["newPassword"],
  });

type AuthRow = {
  id: string;
  role: "ADMIN" | "HOMEMAKER";
  password_hash: string;
  account_status: "ACTIVE" | "SUSPENDED";
  must_change_password: boolean;
  token_version: number;
  name: string;
  phone: string;
};

function publicUser(user: { id: string; role: "ADMIN" | "HOMEMAKER"; name: string; phone: string; mustChangePassword: boolean }) {
  return {
    id: user.id,
    role: user.role,
    name: user.name,
    phone: user.phone,
    mustChangePassword: user.mustChangePassword,
  };
}

function setRefreshCookie(reply: { setCookie: Function }, token: string) {
  reply.setCookie(REFRESH_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    path: "/api/auth",
    secure: config.cookieSecure,
    maxAge: refreshTtlMs / 1000,
  });
}

export async function registerAuthRoutes(app: FastifyInstance) {
  app.post("/api/auth/login", { config: { rateLimit: { max: config.nodeEnv === "test" ? 1000 : 10, timeWindow: "1 minute" } } }, async (request, reply) => {
    const body = loginSchema.parse(request.body);
    const phone = normalizePhone(body.phone);
    const outcome = await prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<AuthRow[]>`SELECT * FROM auth_get_user(${phone})`;
      const user = rows[0];
      const passwordOk = user ? await verifyPassword(user.password_hash, body.password) : false;
      if (!user || !passwordOk || user.account_status !== "ACTIVE") {
        await setActor(tx, { userId: "", role: "PUBLIC" });
        await audit(tx, null, "auth.login_failed", "user", "unknown", { phoneTail: phone.slice(-4) });
        return null;
      }
      await setActor(tx, { userId: user.id, role: user.role });
      const refreshToken = newRefreshToken();
      const session = await tx.session.create({
        data: {
          userId: user.id,
          refreshHash: hashToken(refreshToken),
          expiresAt: new Date(Date.now() + refreshTtlMs),
          userAgent: userAgent(request),
        },
      });
      await audit(tx, user.id, "auth.login", "user", user.id, {});
      const accessToken = await signAccessToken({
        sub: user.id,
        role: user.role,
        sid: session.id,
        tv: user.token_version,
      });
      return {
        accessToken,
        refreshToken,
        user: publicUser({
          id: user.id,
          role: user.role,
          name: user.name,
          phone: user.phone,
          mustChangePassword: user.must_change_password,
        }),
      };
    });
    if (!outcome) throw new ApiError(401, "INVALID_CREDENTIALS", "The phone number or password is not correct.");
    setRefreshCookie(reply, outcome.refreshToken);
    if (body.client === "mobile") return { accessToken: outcome.accessToken, refreshToken: outcome.refreshToken, user: outcome.user };
    return { accessToken: outcome.accessToken, user: outcome.user };
  });

  app.post("/api/auth/refresh", async (request, reply) => {
    const body = z.object({ refreshToken: z.string().min(20).max(500).optional() }).parse(request.body ?? {});
    const presented = body.refreshToken ?? request.cookies[REFRESH_COOKIE];
    if (!presented) throw new ApiError(401, "UNAUTHORIZED", "Sign in required.");
    const rotated = await prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<
        Array<{
          session_id: string;
          user_id: string;
          expires_at: Date;
          revoked_at: Date | null;
          role: "ADMIN" | "HOMEMAKER";
          account_status: "ACTIVE" | "SUSPENDED";
          must_change_password: boolean;
          token_version: number;
          name: string;
          phone: string;
        }>
      >`SELECT * FROM session_by_refresh_hash(${hashToken(presented)})`;
      const current = rows[0];
      if (!current || current.revoked_at || current.expires_at.getTime() <= Date.now() || current.account_status !== "ACTIVE") {
        return null;
      }
      await setActor(tx, { userId: current.user_id, role: current.role });
      await tx.session.update({ where: { id: current.session_id }, data: { revokedAt: new Date() } });
      const refreshToken = newRefreshToken();
      const session = await tx.session.create({
        data: {
          userId: current.user_id,
          refreshHash: hashToken(refreshToken),
          expiresAt: new Date(Date.now() + refreshTtlMs),
          userAgent: userAgent(request),
        },
      });
      const accessToken = await signAccessToken({
        sub: current.user_id,
        role: current.role,
        sid: session.id,
        tv: current.token_version,
      });
      return {
        accessToken,
        refreshToken,
        clientToken: Boolean(body.refreshToken),
        user: publicUser({
          id: current.user_id,
          role: current.role,
          name: current.name,
          phone: current.phone,
          mustChangePassword: current.must_change_password,
        }),
      };
    });
    if (!rotated) throw new ApiError(401, "UNAUTHORIZED", "Sign in required.");
    setRefreshCookie(reply, rotated.refreshToken);
    return rotated.clientToken
      ? { accessToken: rotated.accessToken, refreshToken: rotated.refreshToken, user: rotated.user }
      : { accessToken: rotated.accessToken, user: rotated.user };
  });

  app.post("/api/auth/logout", async (request, reply) => {
    await authenticate(request);
    const current = actor(request);
    await prisma.$transaction(async (tx) => {
      await setActor(tx, { userId: current.userId, role: current.role });
      await tx.session.update({ where: { id: current.sessionId }, data: { revokedAt: new Date() } });
      await audit(tx, current.userId, "auth.logout", "user", current.userId, {});
    });
    reply.clearCookie(REFRESH_COOKIE, { path: "/api/auth" });
    return { ok: true };
  });

  app.get("/api/auth/me", async (request) => {
    await authenticate(request);
    const current = actor(request);
    return {
      user: publicUser({
        id: current.userId,
        role: current.role,
        name: current.name,
        phone: current.phone,
        mustChangePassword: current.mustChangePassword,
      }),
    };
  });

  app.post("/api/auth/change-password", async (request, reply) => {
    await authenticate(request);
    const current = actor(request);
    const body = passwordSchema.parse(request.body);
    const next = await prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<AuthRow[]>`SELECT * FROM auth_get_user(${current.phone})`;
      const user = rows[0];
      if (!user || !(await verifyPassword(user.password_hash, body.currentPassword))) {
        throw new ApiError(401, "INVALID_CREDENTIALS", "The current password is not correct.");
      }
      await setActor(tx, { userId: current.userId, role: current.role });
      const passwordHash = await hashPassword(body.newPassword);
      const updated = await tx.user.update({
        where: { id: current.userId },
        data: { passwordHash, mustChangePassword: false, tokenVersion: { increment: 1 } },
        select: { id: true, role: true, name: true, phone: true, mustChangePassword: true, tokenVersion: true },
      });
      await tx.session.updateMany({ where: { userId: current.userId, revokedAt: null }, data: { revokedAt: new Date() } });
      const refreshToken = newRefreshToken();
      const session = await tx.session.create({
        data: {
          userId: updated.id,
          refreshHash: hashToken(refreshToken),
          expiresAt: new Date(Date.now() + refreshTtlMs),
          userAgent: userAgent(request),
        },
      });
      await audit(tx, updated.id, "auth.password_changed", "user", updated.id, {});
      const accessToken = await signAccessToken({
        sub: updated.id,
        role: updated.role,
        sid: session.id,
        tv: updated.tokenVersion,
      });
      return { accessToken, refreshToken, user: publicUser(updated) };
    });
    setRefreshCookie(reply, next.refreshToken);
    const client = request.headers["x-client"];
    return client === "mobile"
      ? { accessToken: next.accessToken, refreshToken: next.refreshToken, user: next.user }
      : { accessToken: next.accessToken, user: next.user };
  });
}
