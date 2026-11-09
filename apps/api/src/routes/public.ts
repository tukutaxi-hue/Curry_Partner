import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { config } from "../config.js";
import { AGREEMENT_TEXT } from "../agreement.js";
import { prisma, setActor } from "../db.js";
import { ApiError } from "../errors.js";
import { randomUUID } from "node:crypto";
import { referenceCode } from "../auth/passwords.js";
import { normalizePhone } from "../phone.js";
import { audit, getSettings, uniqueConflict } from "../domain/support.js";
import { presentSettings } from "../domain/present.js";

const requestSchema = z.object({
  name: z.string().trim().min(2).max(120),
  phone: z.string().min(8).max(20),
  addressLine: z.string().trim().min(10).max(500),
  serviceAreaId: z.string().min(8).max(40),
  foodPreparationDetails: z.string().trim().min(10).max(2000),
  agreementAcknowledged: z.literal(true),
});

export async function registerPublicRoutes(app: FastifyInstance) {
  app.get("/api/health", async () => {
    await prisma.$queryRaw`SELECT 1`;
    return { ok: true, service: "curry-partner-api" };
  });

  app.get("/api/public/agreement", async () => {
    const settings = await prisma.$transaction(async (tx) => {
      await setActor(tx, { userId: "", role: "PUBLIC" });
      return getSettings(tx);
    });
    return { version: settings.agreementVersion, text: AGREEMENT_TEXT, settings: presentSettings(settings) };
  });

  app.get("/api/public/service-areas", async () => {
    const areas = await prisma.$transaction(async (tx) => {
      await setActor(tx, { userId: "", role: "PUBLIC" });
      return tx.serviceArea.findMany({ where: { active: true }, orderBy: { name: "asc" } });
    });
    return {
      areas: areas.map((area) => ({ id: area.id, name: area.name, code: area.code })),
    };
  });

  app.post(
    "/api/onboarding/requests",
    { config: { rateLimit: { max: config.nodeEnv === "test" ? 1000 : 20, timeWindow: "10 minutes" } } },
    async (request, reply) => {
      const body = requestSchema.parse(request.body);
      const phone = normalizePhone(body.phone);
      try {
        const created = await prisma.$transaction(async (tx) => {
          await setActor(tx, { userId: "", role: "PUBLIC" });
          const area = await tx.serviceArea.findFirst({ where: { id: body.serviceAreaId, active: true } });
          if (!area) throw new ApiError(400, "UNKNOWN_AREA", "Choose an active service area.");
          const settings = await getSettings(tx);
          const blocked = await tx.$queryRaw<Array<{ blocked: boolean }>>`SELECT onboarding_phone_blocked(${phone}) AS blocked`;
          if (blocked[0]?.blocked) {
            throw new ApiError(409, "ALREADY_REGISTERED", "This phone already has an application or account. Contact Curry Partner if you need help.");
          }
          const id = randomUUID();
          const code = referenceCode();
          await tx.$executeRaw`
            INSERT INTO onboarding_requests (
              id, reference_code, name, phone, address_line, service_area_id,
              food_preparation_details, agreement_acknowledged, agreement_version, status,
              is_demo, created_at, updated_at
            ) VALUES (
              ${id}, ${code}, ${body.name}, ${phone}, ${body.addressLine}, ${area.id},
              ${body.foodPreparationDetails}, true, ${settings.agreementVersion}, 'SUBMITTED',
              false, now(), now()
            )
          `;
          await audit(tx, null, "onboarding.submit", "onboarding_request", id, { phoneTail: phone.slice(-4) });
          return { referenceCode: code, status: "SUBMITTED" as const };
        });
        return reply.status(201).send({
          referenceCode: created.referenceCode,
          status: created.status,
          message: "Request received. Save the reference code. Submitting this form does not grant app access.",
        });
      } catch (error) {
        if (uniqueConflict(error)) throw new ApiError(409, "REQUEST_OPEN", "A request for this phone is already open.");
        throw error;
      }
    },
  );

  app.post("/api/onboarding/status", { config: { rateLimit: { max: 30, timeWindow: "10 minutes" } } }, async (request) => {
    const body = z.object({ referenceCode: z.string().trim().min(4).max(40) }).parse(request.body);
    const rows = await prisma.$queryRaw<Array<{ reference_code: string; status: string; admin_notes: string | null }>>`
      SELECT * FROM lookup_onboarding(${body.referenceCode})
    `;
    const row = rows[0];
    if (!row) throw new ApiError(404, "NOT_FOUND", "No request matches that reference code.");
    return { referenceCode: row.reference_code, status: row.status, adminNotes: row.admin_notes };
  });
}
