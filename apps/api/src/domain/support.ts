import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { ApiError } from "../errors.js";
import type { Tx } from "../db.js";

const SECRET_KEY = /password|token|secret|authorization/i;

function redact(value: unknown): Prisma.InputJsonValue {
  if (Array.isArray(value)) return value.map((item) => redact(item)) as Prisma.InputJsonValue;
  if (value && typeof value === "object") {
    const output: Record<string, Prisma.InputJsonValue> = {};
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      output[key] = SECRET_KEY.test(key) ? "[redacted]" : redact(inner);
    }
    return output;
  }
  if (value === null) return null as unknown as Prisma.InputJsonValue;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  return String(value);
}

export async function audit(
  tx: Tx,
  actorId: string | null,
  action: string,
  entityType: string,
  entityId: string,
  metadata?: Record<string, unknown>,
) {
  // Insert without RETURNING so a role that may write a log, but not read every log, still succeeds.
  await tx.$executeRawUnsafe(
    `INSERT INTO audit_logs (id, actor_id, action, entity_type, entity_id, metadata, created_at)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, now())`,
    randomUUID(),
    actorId,
    action,
    entityType,
    entityId,
    JSON.stringify(metadata ? redact(metadata) : {}),
  );
}

export async function notifyUser(
  tx: Tx,
  userId: string,
  input: { type: string; title: string; body: string; dedupeKey?: string; data?: Record<string, unknown> },
) {
  try {
    await tx.notification.create({
      data: {
        userId,
        type: input.type,
        title: input.title,
        body: input.body,
        dedupeKey: input.dedupeKey,
        data: input.data ? redact(input.data) : undefined,
      },
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") return;
    throw error;
  }
}

export async function notifyAdmins(
  tx: Tx,
  input: { type: string; title: string; body: string; dedupeKey: string; data?: Record<string, unknown> },
) {
  await tx.$executeRaw`SELECT enqueue_admin_notification(${input.type}, ${input.title}, ${input.body}, ${input.dedupeKey}, ${JSON.stringify(input.data ?? {})})`;
}

export async function getSettings(tx: Tx) {
  const settings = await tx.platformSetting.findUnique({ where: { id: "default" } });
  if (!settings) throw new ApiError(500, "SETTINGS_MISSING", "Platform settings have not been configured.");
  return settings;
}

export async function withIdempotency(
  tx: Tx,
  params: { userId: string; key: string | undefined; method: string; path: string },
  fn: () => Promise<unknown>,
): Promise<{ statusCode: number; body: Prisma.InputJsonValue; replay: boolean }> {
  const key = params.key?.trim();
  if (!key || key.length < 8 || key.length > 200) {
    throw new ApiError(400, "IDEMPOTENCY_KEY_REQUIRED", "Send an Idempotency-Key header between 8 and 200 characters.");
  }
  const existing = await tx.idempotencyKey.findUnique({
    where: { userId_key: { userId: params.userId, key } },
  });
  if (existing) {
    return { statusCode: existing.statusCode, body: existing.responseBody as Prisma.InputJsonValue, replay: true };
  }
  const body = JSON.parse(JSON.stringify(await fn())) as Prisma.InputJsonValue;
  await tx.idempotencyKey.create({
    data: {
      userId: params.userId,
      key,
      method: params.method,
      path: params.path,
      statusCode: 200,
      responseBody: body,
    },
  });
  return { statusCode: 200, body, replay: false };
}

export function uniqueConflict(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}
