import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { InspectionResult, LedgerType } from "@prisma/client";
import { transaction } from "../db.js";
import { ApiError } from "../errors.js";
import { actor, requireRoles } from "../http.js";
import { asDateOnly, isoDate, todayInZone } from "../time.js";
import { dec, moneyString, qtyString } from "../money.js";
import { commitmentInclude, presentCommitment, presentSettings } from "../domain/present.js";
import { createCommitment, transitionCommitment, updateCommitmentQuantity, withdrawCommitment } from "../domain/commitments.js";
import { disputeInspection } from "../domain/quality.js";
import { getSettings } from "../domain/support.js";

const quantitySchema = z.object({ quantityKg: z.string().regex(/^\d+(\.\d{1,3})?$/) });

export async function registerHomemakerRoutes(app: FastifyInstance) {
  app.addHook("preHandler", async (request) => {
    await requireRoles(request, ["HOMEMAKER"]);
  });

  app.get("/me", async (request) => {
    const current = actor(request);
    return transaction({ userId: current.userId, role: "HOMEMAKER" }, async (tx) => {
      const profile = await tx.homemakerProfile.findUnique({
        where: { userId: current.userId },
        include: { serviceArea: true },
      });
      if (!profile) throw new ApiError(403, "FORBIDDEN", "An approved homemaker profile is required.");
      const settings = await getSettings(tx);
      return {
        user: { id: current.userId, name: current.name, phone: current.phone, role: current.role },
        profile: {
          addressLine: profile.addressLine,
          serviceArea: profile.serviceArea.name,
          serviceAreaId: profile.serviceAreaId,
          foodPreparationDetails: profile.foodPreparationDetails,
          agreementVersion: profile.agreementVersion,
        },
        limits: presentSettings(settings),
      };
    });
  });

  app.get("/menus", async (request) => {
    const current = actor(request);
    return transaction({ userId: current.userId, role: "HOMEMAKER" }, async (tx) => {
      const profile = await tx.homemakerProfile.findUnique({ where: { userId: current.userId } });
      if (!profile) throw new ApiError(403, "FORBIDDEN", "An approved homemaker profile is required.");
      const settings = await getSettings(tx);
      const today = asDateOnly(todayInZone(settings.timezone));
      const menus = await tx.dailyMenu.findMany({
        where: { status: "PUBLISHED", serviceAreaId: profile.serviceAreaId, serviceDate: { gte: today } },
        include: {
          serviceArea: true,
          items: {
            where: { active: true },
            orderBy: { sortOrder: "asc" },
            include: { commitments: { where: { homemakerProfileId: profile.id } } },
          },
        },
        orderBy: { serviceDate: "asc" },
      });
      const commitments = await tx.commitment.findMany({
        where: { homemakerProfileId: profile.id, serviceDate: { gte: today }, status: { not: "REJECTED" } },
      });
      const used = new Map<string, number>();
      for (const commitment of commitments) {
        const key = isoDate(commitment.serviceDate);
        used.set(key, (used.get(key) ?? 0) + 1);
      }
      return {
        limits: {
          maxCurriesPerHomemakerPerDay: settings.maxCurriesPerHomemakerPerDay,
          maxKgPerCurry: qtyString(settings.maxKgPerCurry),
        },
        menus: menus.map((menu) => ({
          id: menu.id,
          serviceDate: isoDate(menu.serviceDate),
          serviceArea: menu.serviceArea.name,
          cutoffAt: menu.cutoffAt.toISOString(),
          open: menu.cutoffAt.getTime() > Date.now(),
          notes: menu.notes,
          committedCount: used.get(isoDate(menu.serviceDate)) ?? 0,
          items: menu.items.map((item) => ({
            id: item.id,
            name: item.name,
            description: item.description,
            preparationInstructions: item.preparationInstructions,
            compensationPerKg: moneyString(item.compensationPerKg),
            maxKgPerHomemaker: qtyString(
              item.maxKgPerHomemaker && item.maxKgPerHomemaker.lt(settings.maxKgPerCurry) ? item.maxKgPerHomemaker : settings.maxKgPerCurry,
            ),
            commitmentId: item.commitments[0]?.id ?? null,
            committedQuantityKg: item.commitments[0] ? qtyString(item.commitments[0].requestedQuantityKg) : null,
            commitmentStatus: item.commitments[0]?.status ?? null,
          })),
        })),
      };
    });
  });

  app.get("/menus/:id", async (request) => {
    const current = actor(request);
    const params = z.object({ id: z.string() }).parse(request.params);
    return transaction({ userId: current.userId, role: "HOMEMAKER" }, async (tx) => {
      const profile = await tx.homemakerProfile.findUnique({ where: { userId: current.userId } });
      if (!profile) throw new ApiError(403, "FORBIDDEN", "An approved homemaker profile is required.");
      const settings = await getSettings(tx);
      const menu = await tx.dailyMenu.findFirst({
        where: { id: params.id, status: "PUBLISHED", serviceAreaId: profile.serviceAreaId },
        include: {
          serviceArea: true,
          items: { where: { active: true }, orderBy: { sortOrder: "asc" }, include: { commitments: { where: { homemakerProfileId: profile.id } } } },
        },
      });
      if (!menu) throw new ApiError(404, "NOT_FOUND", "That menu is not available in your area.");
      return {
        id: menu.id,
        serviceDate: isoDate(menu.serviceDate),
        serviceArea: menu.serviceArea.name,
        cutoffAt: menu.cutoffAt.toISOString(),
        open: menu.cutoffAt.getTime() > Date.now(),
        notes: menu.notes,
        limits: {
          maxCurriesPerHomemakerPerDay: settings.maxCurriesPerHomemakerPerDay,
          maxKgPerCurry: qtyString(settings.maxKgPerCurry),
        },
        items: menu.items.map((item) => ({
          id: item.id,
          name: item.name,
          description: item.description,
          preparationInstructions: item.preparationInstructions,
          compensationPerKg: moneyString(item.compensationPerKg),
          maxKgPerHomemaker: qtyString(
            item.maxKgPerHomemaker && item.maxKgPerHomemaker.lt(settings.maxKgPerCurry) ? item.maxKgPerHomemaker : settings.maxKgPerCurry,
          ),
          commitmentId: item.commitments[0]?.id ?? null,
          committedQuantityKg: item.commitments[0] ? qtyString(item.commitments[0].requestedQuantityKg) : null,
          commitmentStatus: item.commitments[0]?.status ?? null,
        })),
      };
    });
  });

  app.post("/commitments", async (request, reply) => {
    const current = actor(request);
    const body = quantitySchema.extend({ menuItemId: z.string().min(8) }).parse(request.body);
    const created = await transaction({ userId: current.userId, role: "HOMEMAKER" }, async (tx) => {
      const commitment = await createCommitment(tx, current.userId, body);
      const row = await tx.commitment.findUniqueOrThrow({ where: { id: commitment.id }, include: commitmentInclude });
      return presentCommitment(row, "homemaker");
    });
    return reply.status(201).send(created);
  });

  app.patch("/commitments/:id", async (request) => {
    const current = actor(request);
    const params = z.object({ id: z.string() }).parse(request.params);
    const body = quantitySchema.parse(request.body);
    return transaction({ userId: current.userId, role: "HOMEMAKER" }, async (tx) => {
      await updateCommitmentQuantity(tx, current.userId, params.id, body.quantityKg);
      const row = await tx.commitment.findUniqueOrThrow({ where: { id: params.id }, include: commitmentInclude });
      return presentCommitment(row, "homemaker");
    });
  });

  app.delete("/commitments/:id", async (request) => {
    const current = actor(request);
    const params = z.object({ id: z.string() }).parse(request.params);
    await transaction({ userId: current.userId, role: "HOMEMAKER" }, async (tx) => {
      await withdrawCommitment(tx, current.userId, params.id);
    });
    return { ok: true };
  });

  app.get("/commitments", async (request) => {
    const current = actor(request);
    return transaction({ userId: current.userId, role: "HOMEMAKER" }, async (tx) => {
      const profile = await tx.homemakerProfile.findUnique({ where: { userId: current.userId } });
      if (!profile) throw new ApiError(403, "FORBIDDEN", "An approved homemaker profile is required.");
      const rows = await tx.commitment.findMany({
        where: { homemakerProfileId: profile.id },
        include: commitmentInclude,
        orderBy: [{ serviceDate: "desc" }, { createdAt: "desc" }],
        take: 100,
      });
      return { commitments: rows.map((row) => presentCommitment(row, "homemaker")) };
    });
  });

  app.post("/commitments/:id/status", async (request) => {
    const current = actor(request);
    const params = z.object({ id: z.string() }).parse(request.params);
    const body = z.object({ status: z.enum(["PREPARING", "READY_FOR_COLLECTION"]), note: z.string().max(500).optional() }).parse(request.body);
    return transaction({ userId: current.userId, role: "HOMEMAKER" }, async (tx) => {
      await transitionCommitment(tx, { userId: current.userId, role: "HOMEMAKER" }, params.id, body.status, body.note);
      const row = await tx.commitment.findUniqueOrThrow({ where: { id: params.id }, include: commitmentInclude });
      return presentCommitment(row, "homemaker");
    });
  });

  app.post("/inspections/:id/dispute", async (request) => {
    const current = actor(request);
    const params = z.object({ id: z.string() }).parse(request.params);
    const body = z.object({ reason: z.string().trim().min(8).max(2000) }).parse(request.body);
    await transaction({ userId: current.userId, role: "HOMEMAKER" }, async (tx) => {
      await disputeInspection(tx, { userId: current.userId, role: "HOMEMAKER" }, params.id, body.reason);
    });
    return { ok: true };
  });

  app.get("/wallet", async (request) => {
    const current = actor(request);
    return transaction({ userId: current.userId, role: "HOMEMAKER" }, async (tx) => {
      const profile = await tx.homemakerProfile.findUnique({ where: { userId: current.userId } });
      if (!profile) throw new ApiError(403, "FORBIDDEN", "An approved homemaker profile is required.");
      const settings = await getSettings(tx);
      const entries = await tx.ledgerEntry.findMany({
        where: { homemakerProfileId: profile.id },
        include: { inspection: true },
        orderBy: { createdAt: "desc" },
        take: 200,
      });
      const reversed = new Set(entries.filter((entry) => entry.reversesEntryId).map((entry) => entry.reversesEntryId));
      const paid = new Set(entries.filter((entry) => entry.settlesEntryId).map((entry) => entry.settlesEntryId));
      let unpaid = dec(0);
      let earned = dec(0);
      const presented = entries.map((entry) => {
        const status = walletStatus(entry.type, entry.id, entry.inspection?.result, reversed, paid);
        if (entry.type === "CREDIT" && status === "approved") unpaid = unpaid.add(entry.amount);
        if (entry.type === "CREDIT" && (status === "approved" || status === "paid")) earned = earned.add(entry.amount);
        return {
          id: entry.id,
          type: entry.type,
          status,
          itemName: entry.itemName,
          serviceDate: isoDate(entry.serviceDate),
          acceptedQuantityKg: qtyString(entry.acceptedQuantityKg),
          ratePerKg: moneyString(entry.ratePerKg),
          amount: moneyString(entry.amount),
          note: entry.note,
          createdAt: entry.createdAt.toISOString(),
        };
      });
      return {
        currency: settings.currency,
        unpaidAmount: moneyString(unpaid),
        earnedAmount: moneyString(earned),
        entries: presented,
      };
    });
  });

  app.get("/notifications", async (request) => {
    const current = actor(request);
    return transaction({ userId: current.userId, role: "HOMEMAKER" }, async (tx) => {
      const notifications = await tx.notification.findMany({
        where: { userId: current.userId },
        orderBy: { createdAt: "desc" },
        take: 50,
      });
      return {
        unread: notifications.filter((item) => !item.readAt).length,
        notifications: notifications.map(presentNotification),
      };
    });
  });

  app.post("/notifications/:id/read", async (request) => {
    const current = actor(request);
    const params = z.object({ id: z.string() }).parse(request.params);
    await transaction({ userId: current.userId, role: "HOMEMAKER" }, async (tx) => {
      const row = await tx.notification.findFirst({ where: { id: params.id, userId: current.userId } });
      if (!row) throw new ApiError(404, "NOT_FOUND", "That notification was not found.");
      if (!row.readAt) await tx.notification.update({ where: { id: row.id }, data: { readAt: new Date() } });
    });
    return { ok: true };
  });

  app.post("/notifications/read-all", async (request) => {
    const current = actor(request);
    await transaction({ userId: current.userId, role: "HOMEMAKER" }, async (tx) => {
      await tx.notification.updateMany({ where: { userId: current.userId, readAt: null }, data: { readAt: new Date() } });
    });
    return { ok: true };
  });
}

function walletStatus(
  type: LedgerType,
  id: string,
  inspectionResult: InspectionResult | undefined,
  reversed: Set<string | null>,
  paid: Set<string | null>,
) {
  if (type === "REVERSAL") return "reversed" as const;
  if (type === "PAYOUT") return "paid" as const;
  if (inspectionResult === "DISPUTED") return "disputed" as const;
  if (reversed.has(id)) return "reversed" as const;
  if (paid.has(id)) return "paid" as const;
  return "approved" as const;
}

function presentNotification(item: { id: string; type: string; title: string; body: string; readAt: Date | null; createdAt: Date }) {
  return {
    id: item.id,
    type: item.type,
    title: item.title,
    body: item.body,
    readAt: item.readAt?.toISOString() ?? null,
    createdAt: item.createdAt.toISOString(),
  };
}
