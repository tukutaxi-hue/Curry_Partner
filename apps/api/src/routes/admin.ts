import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { transaction } from "../db.js";
import { ApiError } from "../errors.js";
import { actor, idempotencyHeader, requireRoles } from "../http.js";
import { hashPassword, temporaryPassword } from "../auth/passwords.js";
import { asDateOnly, assertClockTime, assertTimeZone, isoDate, todayInZone, zonedPreviousDay } from "../time.js";
import { availableKg, moneyString, parseQty, qtyString } from "../money.js";
import { commitmentInclude, presentCommitment, presentSettings } from "../domain/present.js";
import { transitionCommitment } from "../domain/commitments.js";
import { disputeInspection, recordCollection, recordInspection, resolveInspection } from "../domain/quality.js";
import { applyMovement } from "../domain/stock.js";
import { approvePayoutBatch, createPayoutBatch, failPayoutItem, markPayoutBatchPaid, presentBatch } from "../domain/payouts.js";
import { audit, getSettings, notifyUser, uniqueConflict, withIdempotency } from "../domain/support.js";

const dateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

function csvCell(value: unknown): string {
  const text = value === null || value === undefined ? "" : String(value);
  const guarded = /^[=+\-@]/.test(text) ? `'${text}` : text;
  return `"${guarded.replaceAll('"', '""')}"`;
}

function csv(rows: unknown[][]): string {
  return rows.map((row) => row.map(csvCell).join(",")).join("\n");
}

export async function registerAdminRoutes(app: FastifyInstance) {
  app.addHook("preHandler", async (request) => {
    await requireRoles(request, ["ADMIN"]);
  });

  app.get("/dashboard", async (request) => {
    const current = actor(request);
    const query = z.object({ date: dateString.optional() }).parse(request.query);
    return transaction({ userId: current.userId, role: "ADMIN" }, async (tx) => {
      const settings = await getSettings(tx);
      const date = query.date ?? todayInZone(settings.timezone);
      const serviceDate = asDateOnly(date);
      const [pendingOnboarding, commitments, openInspections, credits, demoAreas] = await Promise.all([
        tx.onboardingRequest.count({ where: { status: { in: ["SUBMITTED", "MORE_INFO"] } } }),
        tx.commitment.findMany({ where: { serviceDate }, include: commitmentInclude, orderBy: { createdAt: "asc" } }),
        tx.inspection.count({ where: { result: { in: ["FAILED", "DISPUTED"] } } }),
        tx.ledgerEntry.findMany({ where: { type: "CREDIT" }, include: { inspection: true } }),
        tx.serviceArea.count({ where: { isDemo: true } }),
      ]);
      const byStatus: Record<string, number> = {};
      for (const commitment of commitments) byStatus[commitment.status] = (byStatus[commitment.status] ?? 0) + 1;
      const reversed = new Set(credits.filter((entry) => entry.type === "CREDIT").map(() => ""));
      const reversals = await tx.ledgerEntry.findMany({ where: { type: "REVERSAL" }, select: { reversesEntryId: true } });
      const payouts = await tx.ledgerEntry.findMany({ where: { type: "PAYOUT" }, select: { settlesEntryId: true } });
      const reversedIds = new Set(reversals.map((entry) => entry.reversesEntryId));
      const paidIds = new Set(payouts.map((entry) => entry.settlesEntryId));
      let unpaid = new Prisma.Decimal(0);
      for (const credit of credits) {
        if (credit.inspection?.result === "DISPUTED") continue;
        if (reversedIds.has(credit.id) || paidIds.has(credit.id)) continue;
        unpaid = unpaid.add(credit.amount);
      }
      void reversed;
      return {
        date,
        currency: settings.currency,
        pendingOnboarding,
        openInspections,
        unpaidAmount: moneyString(unpaid),
        demoDataPresent: demoAreas > 0,
        commitmentsByStatus: byStatus,
        commitments: commitments.map((row) => presentCommitment(row, "admin")),
      };
    });
  });

  app.get("/onboarding", async (request) => {
    const current = actor(request);
    const query = z.object({ status: z.enum(["SUBMITTED", "MORE_INFO", "APPROVED", "REJECTED"]).optional() }).parse(request.query);
    return transaction({ userId: current.userId, role: "ADMIN" }, async (tx) => {
      const rows = await tx.onboardingRequest.findMany({
        where: { status: query.status },
        include: { serviceArea: true },
        orderBy: { createdAt: "desc" },
        take: 100,
      });
      return {
        requests: rows.map((row) => ({
          id: row.id,
          referenceCode: row.referenceCode,
          name: row.name,
          phone: row.phone,
          addressLine: row.addressLine,
          serviceArea: row.serviceArea.name,
          serviceAreaId: row.serviceAreaId,
          foodPreparationDetails: row.foodPreparationDetails,
          agreementVersion: row.agreementVersion,
          status: row.status,
          adminNotes: row.adminNotes,
          createdAt: row.createdAt.toISOString(),
          isDemo: row.isDemo,
        })),
      };
    });
  });

  app.post("/onboarding/:id/approve", async (request) => {
    const current = actor(request);
    const params = z.object({ id: z.string() }).parse(request.params);
    return transaction({ userId: current.userId, role: "ADMIN" }, async (tx) => {
      const row = await tx.onboardingRequest.findUnique({ where: { id: params.id } });
      if (!row) throw new ApiError(404, "NOT_FOUND", "That request was not found.");
      if (row.status === "APPROVED" || row.status === "REJECTED") {
        throw new ApiError(409, "ALREADY_REVIEWED", "This request has already been closed.");
      }
      const existing = await tx.user.findUnique({ where: { phone: row.phone }, select: { id: true } });
      if (existing) throw new ApiError(409, "PHONE_IN_USE", "An account already uses this phone.");
      const temporary = temporaryPassword();
      const user = await tx.user.create({
        data: {
          role: "HOMEMAKER",
          phone: row.phone,
          name: row.name,
          passwordHash: await hashPassword(temporary),
          mustChangePassword: true,
          accountStatus: "ACTIVE",
          profile: {
            create: {
              addressLine: row.addressLine,
              serviceAreaId: row.serviceAreaId,
              foodPreparationDetails: row.foodPreparationDetails,
              agreementVersion: row.agreementVersion,
              agreementAcknowledgedAt: row.createdAt,
              onboardingRequestId: row.id,
            },
          },
        },
      });
      await tx.onboardingRequest.update({
        where: { id: row.id },
        data: { status: "APPROVED", reviewedById: current.userId, reviewedAt: new Date(), createdUserId: user.id },
      });
      await notifyUser(tx, user.id, {
        type: "account.approved",
        title: "Account approved",
        body: "Your Curry Partner account is approved. Sign in with the temporary password and set a new one.",
        dedupeKey: `account:${user.id}:approved`,
      });
      await audit(tx, current.userId, "onboarding.approve", "onboarding_request", row.id, { userId: user.id });
      return {
        userId: user.id,
        phone: user.phone,
        name: user.name,
        mustChangePassword: true,
        temporaryPassword: temporary,
        message: "Share this temporary password once. It is not stored in a readable form and will not be shown again.",
      };
    });
  });

  app.post("/onboarding/:id/reject", async (request) => review(request, "REJECTED"));
  app.post("/onboarding/:id/more-info", async (request) => review(request, "MORE_INFO"));

  app.get("/homemakers", async (request) => {
    const current = actor(request);
    return transaction({ userId: current.userId, role: "ADMIN" }, async (tx) => {
      const rows = await tx.homemakerProfile.findMany({
        include: { user: { select: { id: true, name: true, phone: true, accountStatus: true, mustChangePassword: true, createdAt: true } }, serviceArea: true },
        orderBy: { createdAt: "desc" },
      });
      return {
        homemakers: rows.map((row) => ({
          id: row.id,
          userId: row.user.id,
          name: row.user.name,
          phone: row.user.phone,
          accountStatus: row.user.accountStatus,
          mustChangePassword: row.user.mustChangePassword,
          addressLine: row.addressLine,
          serviceArea: row.serviceArea.name,
          serviceAreaId: row.serviceAreaId,
          foodPreparationDetails: row.foodPreparationDetails,
          createdAt: row.user.createdAt.toISOString(),
        })),
      };
    });
  });

  app.post("/homemakers/:userId/suspend", async (request) => setHomemakerStatus(request, "SUSPENDED"));
  app.post("/homemakers/:userId/reactivate", async (request) => setHomemakerStatus(request, "ACTIVE"));

  app.get("/areas", async (request) => {
    const current = actor(request);
    return transaction({ userId: current.userId, role: "ADMIN" }, async (tx) => {
      const areas = await tx.serviceArea.findMany({ orderBy: { name: "asc" }, include: { stalls: true } });
      return {
        areas: areas.map((area) => ({
          id: area.id,
          name: area.name,
          code: area.code,
          active: area.active,
          isDemo: area.isDemo,
          stalls: area.stalls.map((stall) => ({ id: stall.id, name: stall.name, addressLine: stall.addressLine, active: stall.active })),
        })),
      };
    });
  });

  app.post("/areas", async (request, reply) => {
    const current = actor(request);
    const body = z.object({ name: z.string().trim().min(2).max(80), code: z.string().trim().min(2).max(12) }).parse(request.body);
    const area = await transaction({ userId: current.userId, role: "ADMIN" }, async (tx) => {
      const created = await tx.serviceArea.create({ data: { name: body.name, code: body.code.toUpperCase(), active: true } });
      await audit(tx, current.userId, "area.create", "service_area", created.id, { name: created.name });
      return created;
    });
    return reply.status(201).send({ id: area.id, name: area.name, code: area.code, active: area.active });
  });

  app.patch("/areas/:id", async (request) => {
    const current = actor(request);
    const params = z.object({ id: z.string() }).parse(request.params);
    const body = z.object({ name: z.string().trim().min(2).max(80).optional(), active: z.boolean().optional() }).parse(request.body);
    return transaction({ userId: current.userId, role: "ADMIN" }, async (tx) => {
      const area = await tx.serviceArea.update({ where: { id: params.id }, data: body });
      await audit(tx, current.userId, "area.update", "service_area", area.id, body);
      return { id: area.id, name: area.name, code: area.code, active: area.active };
    });
  });

  app.get("/stalls", async (request) => {
    const current = actor(request);
    return transaction({ userId: current.userId, role: "ADMIN" }, async (tx) => {
      const stalls = await tx.stall.findMany({ include: { serviceArea: true }, orderBy: { name: "asc" } });
      return {
        stalls: stalls.map((stall) => ({
          id: stall.id,
          name: stall.name,
          addressLine: stall.addressLine,
          active: stall.active,
          isDemo: stall.isDemo,
          serviceAreaId: stall.serviceAreaId,
          serviceArea: stall.serviceArea.name,
        })),
      };
    });
  });

  app.post("/stalls", async (request, reply) => {
    const current = actor(request);
    const body = z.object({
      name: z.string().trim().min(2).max(80),
      serviceAreaId: z.string(),
      addressLine: z.string().trim().min(8).max(300),
    }).parse(request.body);
    const stall = await transaction({ userId: current.userId, role: "ADMIN" }, async (tx) => {
      const created = await tx.stall.create({ data: body });
      await audit(tx, current.userId, "stall.create", "stall", created.id, { name: created.name });
      return created;
    });
    return reply.status(201).send({ id: stall.id, name: stall.name });
  });

  app.patch("/stalls/:id", async (request) => {
    const current = actor(request);
    const params = z.object({ id: z.string() }).parse(request.params);
    const body = z.object({ name: z.string().trim().min(2).max(80).optional(), addressLine: z.string().trim().min(8).max(300).optional(), active: z.boolean().optional() }).parse(request.body);
    return transaction({ userId: current.userId, role: "ADMIN" }, async (tx) => {
      const stall = await tx.stall.update({ where: { id: params.id }, data: body });
      await audit(tx, current.userId, "stall.update", "stall", stall.id, body);
      return { id: stall.id, name: stall.name, active: stall.active };
    });
  });

  app.get("/settings", async (request) => {
    const current = actor(request);
    return transaction({ userId: current.userId, role: "ADMIN" }, async (tx) => presentSettings(await getSettings(tx)));
  });

  app.put("/settings", async (request) => {
    const current = actor(request);
    const body = z.object({
      maxCurriesPerHomemakerPerDay: z.number().int().min(1).max(10),
      maxKgPerCurry: z.string().regex(/^\d+(\.\d{1,3})?$/),
      menuPublishCutoffLocal: z.string(),
      commitmentCutoffLocal: z.string(),
      timezone: z.string().min(3).max(60),
    }).parse(request.body);
    assertClockTime(body.menuPublishCutoffLocal);
    assertClockTime(body.commitmentCutoffLocal);
    assertTimeZone(body.timezone);
    const maxKg = parseQty(body.maxKgPerCurry);
    if (maxKg.gt(20)) throw new ApiError(400, "LIMIT_TOO_HIGH", "The per-curry limit cannot exceed 20 kg.");
    return transaction({ userId: current.userId, role: "ADMIN" }, async (tx) => {
      const settings = await tx.platformSetting.update({
        where: { id: "default" },
        data: {
          maxCurriesPerHomemakerPerDay: body.maxCurriesPerHomemakerPerDay,
          maxKgPerCurry: maxKg,
          menuPublishCutoffLocal: body.menuPublishCutoffLocal,
          commitmentCutoffLocal: body.commitmentCutoffLocal,
          timezone: body.timezone,
        },
      });
      await audit(tx, current.userId, "settings.update", "platform_settings", "default", {
        maxCurriesPerHomemakerPerDay: body.maxCurriesPerHomemakerPerDay,
        maxKgPerCurry: maxKg.toFixed(3),
        menuPublishCutoffLocal: body.menuPublishCutoffLocal,
        commitmentCutoffLocal: body.commitmentCutoffLocal,
        timezone: body.timezone,
      });
      return presentSettings(settings);
    });
  });

  app.get("/menus", async (request) => {
    const current = actor(request);
    const query = z.object({ from: dateString.optional(), to: dateString.optional(), areaId: z.string().optional() }).parse(request.query);
    return transaction({ userId: current.userId, role: "ADMIN" }, async (tx) => {
      const menus = await tx.dailyMenu.findMany({
        where: {
          serviceAreaId: query.areaId,
          serviceDate: {
            gte: query.from ? asDateOnly(query.from) : undefined,
            lte: query.to ? asDateOnly(query.to) : undefined,
          },
        },
        include: { serviceArea: true, items: { orderBy: { sortOrder: "asc" } } },
        orderBy: { serviceDate: "desc" },
        take: 60,
      });
      return { menus: menus.map(presentMenu) };
    });
  });

  app.post("/menus", async (request, reply) => {
    const current = actor(request);
    const body = z.object({ serviceDate: dateString, serviceAreaId: z.string(), notes: z.string().max(500).optional() }).parse(request.body);
    const menu = await transaction({ userId: current.userId, role: "ADMIN" }, async (tx) => {
      const settings = await getSettings(tx);
      try {
        const created = await tx.dailyMenu.create({
          data: {
            serviceDate: asDateOnly(body.serviceDate),
            serviceAreaId: body.serviceAreaId,
            notes: body.notes?.trim() || null,
            cutoffAt: zonedPreviousDay(body.serviceDate, settings.commitmentCutoffLocal, settings.timezone),
            createdById: current.userId,
            status: "DRAFT",
          },
          include: { serviceArea: true, items: true },
        });
        await audit(tx, current.userId, "menu.create", "daily_menu", created.id, { serviceDate: body.serviceDate });
        return created;
      } catch (error) {
        if (uniqueConflict(error)) throw new ApiError(409, "MENU_EXISTS", "A menu already exists for that area and date.");
        throw error;
      }
    });
    return reply.status(201).send(presentMenu(menu));
  });

  app.post("/menus/:id/items", async (request, reply) => {
    const current = actor(request);
    const params = z.object({ id: z.string() }).parse(request.params);
    const body = z.object({
      name: z.string().trim().min(2).max(80),
      description: z.string().trim().min(2).max(500),
      preparationInstructions: z.string().trim().min(2).max(2000),
      compensationPerKg: z.string().regex(/^\d+(\.\d{1,2})?$/),
      maxKgPerHomemaker: z.string().regex(/^\d+(\.\d{1,3})?$/).optional(),
    }).parse(request.body);
    const rate = new Prisma.Decimal(body.compensationPerKg);
    if (rate.lte(0)) throw new ApiError(400, "INVALID_RATE", "Compensation must be greater than zero.");
    const item = await transaction({ userId: current.userId, role: "ADMIN" }, async (tx) => {
      const menu = await tx.dailyMenu.findUnique({ where: { id: params.id } });
      if (!menu) throw new ApiError(404, "NOT_FOUND", "That menu was not found.");
      if (menu.status !== "DRAFT") throw new ApiError(409, "MENU_LOCKED", "Items can only be edited on a draft menu.");
      return tx.menuItem.create({
        data: {
          menuId: menu.id,
          name: body.name,
          description: body.description,
          preparationInstructions: body.preparationInstructions,
          compensationPerKg: rate,
          maxKgPerHomemaker: body.maxKgPerHomemaker ? parseQty(body.maxKgPerHomemaker) : null,
        },
      });
    });
    return reply.status(201).send({ id: item.id, name: item.name });
  });

  app.post("/menus/:id/publish", async (request) => {
    const current = actor(request);
    const params = z.object({ id: z.string() }).parse(request.params);
    const body = z.object({ overrideReason: z.string().trim().min(8).max(500).optional() }).parse(request.body ?? {});
    return transaction({ userId: current.userId, role: "ADMIN" }, async (tx) => {
      const settings = await getSettings(tx);
      const menu = await tx.dailyMenu.findUnique({ where: { id: params.id }, include: { items: true, serviceArea: true } });
      if (!menu) throw new ApiError(404, "NOT_FOUND", "That menu was not found.");
      if (menu.status !== "DRAFT") throw new ApiError(409, "MENU_LOCKED", "Only a draft menu can be published.");
      if (!menu.items.some((item) => item.active)) throw new ApiError(409, "MENU_EMPTY", "Add at least one dish before publishing.");
      const serviceDate = isoDate(menu.serviceDate);
      const deadline = zonedPreviousDay(serviceDate, settings.menuPublishCutoffLocal, settings.timezone);
      if (Date.now() > deadline.getTime() && !body.overrideReason) {
        throw new ApiError(409, "PUBLISH_DEADLINE_PASSED", `The ${settings.menuPublishCutoffLocal} publish deadline has passed. Provide an override reason to publish anyway.`);
      }
      const cutoffAt = zonedPreviousDay(serviceDate, settings.commitmentCutoffLocal, settings.timezone);
      const published = await tx.dailyMenu.update({
        where: { id: menu.id },
        data: { status: "PUBLISHED", publishedAt: new Date(), cutoffAt },
        include: { serviceArea: true, items: { orderBy: { sortOrder: "asc" } } },
      });
      const profiles = await tx.homemakerProfile.findMany({
        where: { serviceAreaId: menu.serviceAreaId, user: { accountStatus: "ACTIVE", role: "HOMEMAKER" } },
        select: { userId: true },
      });
      for (const profile of profiles) {
        await notifyUser(tx, profile.userId, {
          type: "menu.published",
          title: "Tomorrow's menu is open",
          body: `${menu.serviceArea.name} menu for ${serviceDate} is published. Commit before the cutoff.`,
          dedupeKey: `menu:${menu.id}`,
        });
      }
      await audit(tx, current.userId, "menu.publish", "daily_menu", menu.id, { overrideReason: body.overrideReason ?? null });
      return presentMenu(published);
    });
  });

  app.post("/menus/:id/close", async (request) => {
    const current = actor(request);
    const params = z.object({ id: z.string() }).parse(request.params);
    return transaction({ userId: current.userId, role: "ADMIN" }, async (tx) => {
      const menu = await tx.dailyMenu.update({
        where: { id: params.id },
        data: { status: "CLOSED" },
        include: { serviceArea: true, items: true },
      });
      await audit(tx, current.userId, "menu.close", "daily_menu", menu.id, {});
      return presentMenu(menu);
    });
  });

  app.get("/commitments", async (request) => {
    const current = actor(request);
    const query = z.object({
      date: dateString.optional(),
      areaId: z.string().optional(),
      homemakerId: z.string().optional(),
      status: z.enum(["COMMITTED", "PREPARING", "READY_FOR_COLLECTION", "COLLECTED", "REJECTED", "COMPLETED"]).optional(),
    }).parse(request.query);
    return transaction({ userId: current.userId, role: "ADMIN" }, async (tx) => {
      const rows = await tx.commitment.findMany({
        where: {
          serviceDate: query.date ? asDateOnly(query.date) : undefined,
          status: query.status,
          homemakerProfileId: query.homemakerId,
          homemakerProfile: query.areaId ? { serviceAreaId: query.areaId } : undefined,
        },
        include: commitmentInclude,
        orderBy: [{ serviceDate: "desc" }, { createdAt: "asc" }],
        take: 200,
      });
      return { commitments: rows.map((row) => presentCommitment(row, "admin")) };
    });
  });

  app.post("/commitments/:id/status", async (request) => {
    const current = actor(request);
    const params = z.object({ id: z.string() }).parse(request.params);
    const body = z.object({
      status: z.enum(["COLLECTED", "REJECTED", "COMPLETED"]),
      note: z.string().trim().max(500).optional(),
    }).parse(request.body);
    return transaction({ userId: current.userId, role: "ADMIN" }, async (tx) => {
      await transitionCommitment(tx, { userId: current.userId, role: "ADMIN" }, params.id, body.status, body.note);
      const row = await tx.commitment.findUniqueOrThrow({ where: { id: params.id }, include: commitmentInclude });
      return presentCommitment(row, "admin");
    });
  });

  app.post("/commitments/:id/collection", async (request) => {
    const current = actor(request);
    const params = z.object({ id: z.string() }).parse(request.params);
    const body = z.object({
      status: z.enum(["SCHEDULED", "COLLECTED", "MISSED"]),
      collectedAt: z.string().datetime().optional(),
      staffName: z.string().trim().max(80).optional(),
      notes: z.string().trim().max(2000).optional(),
    }).parse(request.body);
    await transaction({ userId: current.userId, role: "ADMIN" }, async (tx) => {
      await recordCollection(tx, current.userId, params.id, body);
    });
    return loadCommitment(current.userId, params.id);
  });

  app.post("/commitments/:id/inspections", async (request, reply) => {
    const current = actor(request);
    const params = z.object({ id: z.string() }).parse(request.params);
    const body = z.object({
      weightKg: z.string(),
      acceptedQuantityKg: z.string(),
      waterContent: z.enum(["LOW", "NORMAL", "HIGH"]),
      freshness: z.enum(["GOOD", "ACCEPTABLE", "POOR"]),
      hygiene: z.enum(["PASS", "FAIL"]),
      notes: z.string().max(2000).optional(),
      photoUrl: z.union([z.string().url().max(500), z.literal("")]).optional(),
      result: z.enum(["PASSED", "FAILED", "DISPUTED"]),
    }).parse(request.body);
    const inspection = await transaction({ userId: current.userId, role: "ADMIN" }, async (tx) =>
      recordInspection(tx, current.userId, params.id, {
        weightKg: parseQty(body.weightKg),
        acceptedQuantityKg: body.result === "FAILED" ? parseQty(body.acceptedQuantityKg, { allowZero: true }) : parseQty(body.acceptedQuantityKg),
        waterContent: body.waterContent,
        freshness: body.freshness,
        hygiene: body.hygiene,
        notes: body.notes,
        photoUrl: body.photoUrl,
        result: body.result,
      }),
    );
    return reply.status(201).send({ id: inspection.id, result: inspection.result });
  });

  app.get("/inspections/queue", async (request) => {
    const current = actor(request);
    return transaction({ userId: current.userId, role: "ADMIN" }, async (tx) => {
      const rows = await tx.inspection.findMany({
        where: { result: { in: ["FAILED", "DISPUTED"] } },
        include: { commitment: { include: commitmentInclude } },
        orderBy: { createdAt: "asc" },
      });
      return {
        inspections: rows.map((row) => ({
          ...presentCommitment(row.commitment, "admin").inspection,
          commitment: presentCommitment(row.commitment, "admin"),
        })),
      };
    });
  });

  app.post("/inspections/:id/resolve", async (request) => {
    const current = actor(request);
    const params = z.object({ id: z.string() }).parse(request.params);
    const body = z.object({
      outcome: z.enum(["accepted", "rejected"]),
      acceptedQuantityKg: z.string().optional(),
      reason: z.string().trim().min(8).max(2000),
    }).parse(request.body);
    await transaction({ userId: current.userId, role: "ADMIN" }, async (tx) => {
      await resolveInspection(tx, current.userId, params.id, body);
    });
    return { ok: true };
  });

  app.post("/inspections/:id/dispute", async (request) => {
    const current = actor(request);
    const params = z.object({ id: z.string() }).parse(request.params);
    const body = z.object({ reason: z.string().trim().min(8).max(2000) }).parse(request.body);
    await transaction({ userId: current.userId, role: "ADMIN" }, async (tx) => {
      await disputeInspection(tx, { userId: current.userId, role: "ADMIN" }, params.id, body.reason);
    });
    return { ok: true };
  });

  app.get("/stock", async (request) => {
    const current = actor(request);
    const query = z.object({ areaId: z.string().optional(), stallId: z.string().optional() }).parse(request.query);
    return transaction({ userId: current.userId, role: "ADMIN" }, async (tx) => {
      const lots = await tx.stockLot.findMany({
        where: { serviceAreaId: query.areaId, stallId: query.stallId },
        include: {
          menuItem: true,
          stall: true,
          commitment: true,
          movements: { orderBy: { createdAt: "desc" }, take: 20 },
        },
        orderBy: { createdAt: "desc" },
        take: 100,
      });
      return {
        lots: lots.map((lot) => ({
          id: lot.id,
          itemName: lot.commitment.itemName,
          serviceDate: isoDate(lot.commitment.serviceDate),
          serviceAreaId: lot.serviceAreaId,
          stallId: lot.stallId,
          stallName: lot.stall?.name ?? null,
          acceptedKg: qtyString(lot.acceptedKg),
          soldKg: qtyString(lot.soldKg),
          wasteKg: qtyString(lot.wasteKg),
          returnedKg: qtyString(lot.returnedKg),
          adjustmentKg: qtyString(lot.adjustmentKg),
          availableKg: qtyString(availableKg(lot)),
          movements: lot.movements.map((movement) => ({
            id: movement.id,
            type: movement.type,
            quantityKg: qtyString(movement.quantityKg),
            reason: movement.reason,
            createdAt: movement.createdAt.toISOString(),
          })),
        })),
      };
    });
  });

  app.post("/stock/movements", async (request, reply) => {
    const current = actor(request);
    const body = z.object({
      lotId: z.string(),
      type: z.enum(["ALLOCATION", "SALE", "WASTE", "RETURN", "ADJUSTMENT"]),
      quantityKg: z.string(),
      reason: z.string().trim().min(3).max(500),
      stallId: z.string().optional(),
    }).parse(request.body);
    const result = await transaction({ userId: current.userId, role: "ADMIN" }, (tx) =>
      withIdempotency(tx, { userId: current.userId, key: idempotencyHeader(request), method: "POST", path: "/api/admin/stock/movements" }, () =>
        applyMovement(tx, current.userId, { ...body, idempotencyKey: `${current.userId}:${idempotencyHeader(request)}` }),
      ),
    );
    return reply.status(result.replay ? 200 : 201).send(result.body);
  });

  app.get("/payouts", async (request) => {
    const current = actor(request);
    return transaction({ userId: current.userId, role: "ADMIN" }, async (tx) => {
      const batches = await tx.payoutBatch.findMany({
        include: { items: { include: { profile: { include: { user: { select: { name: true, phone: true } } } }, credits: true } } },
        orderBy: { createdAt: "desc" },
        take: 30,
      });
      return { batches: batches.map(presentBatch) };
    });
  });

  app.post("/payouts/batches", async (request, reply) => {
    const current = actor(request);
    const body = z.object({ weekStart: dateString }).parse(request.body);
    const result = await transaction({ userId: current.userId, role: "ADMIN" }, (tx) =>
      withIdempotency(tx, { userId: current.userId, key: idempotencyHeader(request), method: "POST", path: "/api/admin/payouts/batches" }, () =>
        createPayoutBatch(tx, current.userId, body.weekStart),
      ),
    );
    return reply.status(result.replay ? 200 : 201).send(result.body);
  });

  app.post("/payouts/batches/:id/approve", async (request) => {
    const current = actor(request);
    const params = z.object({ id: z.string() }).parse(request.params);
    return transaction({ userId: current.userId, role: "ADMIN" }, (tx) => approvePayoutBatch(tx, current.userId, params.id));
  });

  app.post("/payouts/batches/:id/mark-paid", async (request, reply) => {
    const current = actor(request);
    const params = z.object({ id: z.string() }).parse(request.params);
    const body = z.object({ reference: z.string().trim().min(4).max(80) }).parse(request.body);
    const result = await transaction({ userId: current.userId, role: "ADMIN" }, (tx) =>
      withIdempotency(tx, { userId: current.userId, key: idempotencyHeader(request), method: "POST", path: `/api/admin/payouts/batches/${params.id}/mark-paid` }, () =>
        markPayoutBatchPaid(tx, current.userId, params.id, body.reference),
      ),
    );
    return reply.status(200).send(result.body);
  });

  app.post("/payouts/items/:id/fail", async (request) => {
    const current = actor(request);
    const params = z.object({ id: z.string() }).parse(request.params);
    const body = z.object({ failureDetail: z.string().trim().min(8).max(500) }).parse(request.body);
    return transaction({ userId: current.userId, role: "ADMIN" }, (tx) => failPayoutItem(tx, current.userId, params.id, body.failureDetail));
  });

  app.get("/reports/operations", async (request) => report(request, false));
  app.get("/reports/operations.csv", async (request, reply) => {
    const body = await report(request, true);
    reply.header("content-type", "text/csv; charset=utf-8");
    reply.header("content-disposition", "attachment; filename=\"curry-partner-operations.csv\"");
    return reply.send(body.csv ?? "");
  });

  app.get("/reports/financial", async (request) => financial(request, false));
  app.get("/reports/financial.csv", async (request, reply) => {
    const body = await financial(request, true);
    reply.header("content-type", "text/csv; charset=utf-8");
    reply.header("content-disposition", "attachment; filename=\"curry-partner-financial.csv\"");
    return reply.send(body.csv ?? "");
  });

  app.get("/audit", async (request) => {
    const current = actor(request);
    return transaction({ userId: current.userId, role: "ADMIN" }, async (tx) => {
      const logs = await tx.auditLog.findMany({
        orderBy: { createdAt: "desc" },
        take: 100,
        include: { actor: { select: { name: true, role: true } } },
      });
      return {
        logs: logs.map((log) => ({
          id: log.id,
          action: log.action,
          entityType: log.entityType,
          entityId: log.entityId,
          actor: log.actor ? { name: log.actor.name, role: log.actor.role } : null,
          metadata: log.metadata,
          createdAt: log.createdAt.toISOString(),
        })),
      };
    });
  });

  app.get("/notifications", async (request) => {
    const current = actor(request);
    return transaction({ userId: current.userId, role: "ADMIN" }, async (tx) => {
      const notifications = await tx.notification.findMany({ where: { userId: current.userId }, orderBy: { createdAt: "desc" }, take: 50 });
      return {
        unread: notifications.filter((item) => !item.readAt).length,
        notifications: notifications.map((item) => ({
          id: item.id,
          type: item.type,
          title: item.title,
          body: item.body,
          readAt: item.readAt?.toISOString() ?? null,
          createdAt: item.createdAt.toISOString(),
        })),
      };
    });
  });

  app.post("/notifications/read-all", async (request) => {
    const current = actor(request);
    await transaction({ userId: current.userId, role: "ADMIN" }, async (tx) => {
      await tx.notification.updateMany({ where: { userId: current.userId, readAt: null }, data: { readAt: new Date() } });
    });
    return { ok: true };
  });
}

function presentMenu(menu: {
  id: string;
  serviceDate: Date;
  status: string;
  cutoffAt: Date;
  publishedAt: Date | null;
  notes: string | null;
  serviceArea: { id: string; name: string };
  items: Array<{ id: string; name: string; description: string; preparationInstructions: string; compensationPerKg: Prisma.Decimal; maxKgPerHomemaker: Prisma.Decimal | null; active: boolean }>;
}) {
  return {
    id: menu.id,
    serviceDate: isoDate(menu.serviceDate),
    status: menu.status,
    serviceAreaId: menu.serviceArea.id,
    serviceArea: menu.serviceArea.name,
    cutoffAt: menu.cutoffAt.toISOString(),
    publishedAt: menu.publishedAt?.toISOString() ?? null,
    notes: menu.notes,
    items: menu.items.map((item) => ({
      id: item.id,
      name: item.name,
      description: item.description,
      preparationInstructions: item.preparationInstructions,
      compensationPerKg: moneyString(item.compensationPerKg),
      maxKgPerHomemaker: item.maxKgPerHomemaker ? qtyString(item.maxKgPerHomemaker) : null,
      active: item.active,
    })),
  };
}

async function review(request: { params: unknown; body: unknown; auth?: { userId: string } }, status: "REJECTED" | "MORE_INFO") {
  const current = actor(request as never);
  const params = z.object({ id: z.string() }).parse(request.params);
  const body = z.object({ adminNotes: z.string().trim().min(8).max(2000) }).parse(request.body);
  return transaction({ userId: current.userId, role: "ADMIN" }, async (tx) => {
    const row = await tx.onboardingRequest.findUnique({ where: { id: params.id } });
    if (!row) throw new ApiError(404, "NOT_FOUND", "That request was not found.");
    if (row.status === "APPROVED" || row.status === "REJECTED") throw new ApiError(409, "ALREADY_REVIEWED", "This request has already been closed.");
    await tx.onboardingRequest.update({
      where: { id: row.id },
      data: { status, adminNotes: body.adminNotes, reviewedById: current.userId, reviewedAt: new Date() },
    });
    await audit(tx, current.userId, status === "REJECTED" ? "onboarding.reject" : "onboarding.more_info", "onboarding_request", row.id, {});
    return { id: row.id, status };
  });
}

async function setHomemakerStatus(request: { params: unknown; auth?: { userId: string } }, accountStatus: "ACTIVE" | "SUSPENDED") {
  const current = actor(request as never);
  const params = z.object({ userId: z.string() }).parse(request.params);
  return transaction({ userId: current.userId, role: "ADMIN" }, async (tx) => {
    const user = await tx.user.findUnique({ where: { id: params.userId } });
    if (!user || user.role !== "HOMEMAKER") throw new ApiError(404, "NOT_FOUND", "That homemaker was not found.");
    await tx.user.update({
      where: { id: user.id },
      data: { accountStatus, tokenVersion: accountStatus === "SUSPENDED" ? { increment: 1 } : undefined },
    });
    if (accountStatus === "SUSPENDED") {
      await tx.session.updateMany({ where: { userId: user.id, revokedAt: null }, data: { revokedAt: new Date() } });
    }
    await audit(tx, current.userId, accountStatus === "SUSPENDED" ? "homemaker.suspend" : "homemaker.reactivate", "user", user.id, {});
    return { userId: user.id, accountStatus };
  });
}

async function loadCommitment(userId: string, id: string) {
  return transaction({ userId, role: "ADMIN" }, async (tx) => {
    const row = await tx.commitment.findUnique({ where: { id }, include: commitmentInclude });
    if (!row) throw new ApiError(404, "NOT_FOUND", "That commitment was not found.");
    return presentCommitment(row, "admin");
  });
}

async function report(request: { query: unknown; auth?: { userId: string } }, asCsv: boolean) {
  const current = actor(request as never);
  const query = z.object({
    from: dateString,
    to: dateString,
    areaId: z.string().optional(),
    stallId: z.string().optional(),
    homemakerId: z.string().optional(),
    dish: z.string().max(80).optional(),
  }).parse(request.query);
  assertRange(query.from, query.to);
  return transaction({ userId: current.userId, role: "ADMIN" }, async (tx) => {
    const rows = await tx.commitment.findMany({
      where: {
        serviceDate: { gte: asDateOnly(query.from), lte: asDateOnly(query.to) },
        homemakerProfileId: query.homemakerId,
        homemakerProfile: query.areaId ? { serviceAreaId: query.areaId } : undefined,
        itemName: query.dish ? { contains: query.dish, mode: "insensitive" } : undefined,
        lot: query.stallId ? { stallId: query.stallId } : undefined,
      },
      include: commitmentInclude,
      orderBy: [{ serviceDate: "asc" }, { itemName: "asc" }],
      take: 5000,
    });
    const presented = rows.map((row) => ({
      serviceDate: isoDate(row.serviceDate),
      area: row.homemakerProfile.serviceArea.name,
      homemaker: row.homemakerProfile.user.name,
      dish: row.itemName,
      requestedKg: qtyString(row.requestedQuantityKg),
      status: row.status,
      acceptedKg: row.inspection?.resolvedQuantityKg
        ? qtyString(row.inspection.resolvedQuantityKg)
        : row.inspection
          ? qtyString(row.inspection.acceptedQuantityKg)
          : "",
      stall: row.lot?.stall?.name ?? "",
      soldKg: row.lot ? qtyString(row.lot.soldKg) : "",
      wasteKg: row.lot ? qtyString(row.lot.wasteKg) : "",
      availableKg: row.lot ? qtyString(availableKg(row.lot)) : "",
    }));
    const table = [
      ["serviceDate", "area", "homemaker", "dish", "requestedKg", "status", "acceptedKg", "stall", "soldKg", "wasteKg", "availableKg"],
      ...presented.map((row) => [row.serviceDate, row.area, row.homemaker, row.dish, row.requestedKg, row.status, row.acceptedKg, row.stall, row.soldKg, row.wasteKg, row.availableKg]),
    ];
    return { csv: asCsv ? csv(table) : null, rows: presented };
  });
}

async function financial(request: { query: unknown; auth?: { userId: string } }, asCsv: boolean) {
  const current = actor(request as never);
  const query = z.object({
    from: dateString,
    to: dateString,
    homemakerId: z.string().optional(),
    areaId: z.string().optional(),
  }).parse(request.query);
  assertRange(query.from, query.to);
  return transaction({ userId: current.userId, role: "ADMIN" }, async (tx) => {
    const entries = await tx.ledgerEntry.findMany({
      where: {
        serviceDate: { gte: asDateOnly(query.from), lte: asDateOnly(query.to) },
        homemakerProfileId: query.homemakerId,
        profile: query.areaId ? { serviceAreaId: query.areaId } : undefined,
      },
      include: { profile: { include: { user: { select: { name: true } }, serviceArea: true } }, inspection: true },
      orderBy: { createdAt: "asc" },
      take: 5000,
    });
    const reversed = new Set(entries.filter((entry) => entry.reversesEntryId).map((entry) => entry.reversesEntryId));
    const paid = new Set(entries.filter((entry) => entry.settlesEntryId).map((entry) => entry.settlesEntryId));
    const rows = entries.map((entry) => ({
      serviceDate: isoDate(entry.serviceDate),
      area: entry.profile.serviceArea.name,
      homemaker: entry.profile.user.name,
      dish: entry.itemName,
      type: entry.type,
      status:
        entry.type === "CREDIT"
          ? entry.inspection?.result === "DISPUTED"
            ? "disputed"
            : reversed.has(entry.id)
              ? "reversed"
              : paid.has(entry.id)
                ? "paid"
                : "approved"
          : entry.type === "PAYOUT"
            ? "paid"
            : "reversed",
      acceptedKg: qtyString(entry.acceptedQuantityKg),
      ratePerKg: moneyString(entry.ratePerKg),
      amount: moneyString(entry.amount),
      note: entry.note ?? "",
    }));
    const table = [
      ["serviceDate", "area", "homemaker", "dish", "type", "status", "acceptedKg", "ratePerKg", "amount", "note"],
      ...rows.map((row) => [row.serviceDate, row.area, row.homemaker, row.dish, row.type, row.status, row.acceptedKg, row.ratePerKg, row.amount, row.note]),
    ];
    return { csv: asCsv ? csv(table) : null, rows };
  });
}

function assertRange(from: string, to: string) {
  const start = asDateOnly(from).getTime();
  const end = asDateOnly(to).getTime();
  if (end < start) throw new ApiError(400, "INVALID_RANGE", "The end date is before the start date.");
  if (end - start > 366 * 24 * 60 * 60 * 1000) throw new ApiError(400, "INVALID_RANGE", "Choose a range of one year or less.");
}
