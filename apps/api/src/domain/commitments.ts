import { Prisma } from "@prisma/client";
import type { CommitmentStatus } from "@prisma/client";
import { ApiError } from "../errors.js";
import type { Tx } from "../db.js";
import { parseQty } from "../money.js";
import { isoDate } from "../time.js";
import { adminTransitions, homemakerTransitions } from "./transitions.js";
import { audit, getSettings, notifyUser, uniqueConflict } from "./support.js";

async function lockHomemakerDay(tx: Tx, profileId: string, serviceDate: Date) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`${profileId}:${serviceDate.toISOString()}`}))`;
}

export async function createCommitment(tx: Tx, userId: string, input: { menuItemId: string; quantityKg: string }) {
  const profile = await tx.homemakerProfile.findUnique({ where: { userId } });
  if (!profile) throw new ApiError(403, "FORBIDDEN", "An approved homemaker profile is required.");

  const item = await tx.menuItem.findFirst({
    where: { id: input.menuItemId, active: true },
    include: { menu: true },
  });
  if (!item || item.menu.status !== "PUBLISHED") {
    throw new ApiError(404, "MENU_NOT_FOUND", "That menu item is not available.");
  }
  if (item.menu.serviceAreaId !== profile.serviceAreaId) {
    throw new ApiError(403, "OUTSIDE_SERVICE_AREA", "This menu is outside your service area.");
  }
  if (item.menu.cutoffAt.getTime() <= Date.now()) {
    throw new ApiError(409, "CUTOFF_PASSED", "The commitment cutoff for this menu has passed.");
  }

  await lockHomemakerDay(tx, profile.id, item.menu.serviceDate);
  const settings = await getSettings(tx);
  const quantity = parseQty(input.quantityKg);
  const cap = item.maxKgPerHomemaker
    ? Prisma.Decimal.min(item.maxKgPerHomemaker, settings.maxKgPerCurry)
    : settings.maxKgPerCurry;
  if (quantity.gt(cap)) {
    throw new ApiError(409, "LIMIT_EXCEEDED", `The maximum for this curry is ${cap.toFixed(3)} kg.`);
  }

  const count = await tx.commitment.count({
    where: {
      homemakerProfileId: profile.id,
      serviceDate: item.menu.serviceDate,
      status: { not: "REJECTED" },
    },
  });
  if (count >= settings.maxCurriesPerHomemakerPerDay) {
    throw new ApiError(
      409,
      "LIMIT_EXCEEDED",
      `You can commit to ${settings.maxCurriesPerHomemakerPerDay} curries on a service day.`,
    );
  }

  try {
    const commitment = await tx.commitment.create({
      data: {
        homemakerProfileId: profile.id,
        menuItemId: item.id,
        serviceDate: item.menu.serviceDate,
        requestedQuantityKg: quantity,
        itemName: item.name,
        ratePerKg: item.compensationPerKg,
        preparationInstructions: item.preparationInstructions,
        status: "COMMITTED",
        events: { create: { toStatus: "COMMITTED", actorId: userId, note: "Commitment submitted" } },
      },
    });
    await notifyUser(tx, userId, {
      type: "commitment.confirmed",
      title: "Commitment confirmed",
      body: `${item.name} · ${quantity.toFixed(3)} kg for ${isoDate(item.menu.serviceDate)}.`,
      dedupeKey: `commitment:${commitment.id}:created`,
    });
    await audit(tx, userId, "commitment.create", "commitment", commitment.id, {
      menuItemId: item.id,
      quantityKg: quantity.toFixed(3),
    });
    return commitment;
  } catch (error) {
    if (uniqueConflict(error)) {
      throw new ApiError(409, "ALREADY_COMMITTED", "You already committed to this menu item.");
    }
    throw error;
  }
}

export async function updateCommitmentQuantity(tx: Tx, userId: string, commitmentId: string, quantityKg: string) {
  const profile = await tx.homemakerProfile.findUnique({ where: { userId } });
  if (!profile) throw new ApiError(403, "FORBIDDEN", "An approved homemaker profile is required.");
  const commitment = await tx.commitment.findFirst({
    where: { id: commitmentId, homemakerProfileId: profile.id },
    include: { menuItem: { include: { menu: true } } },
  });
  if (!commitment) throw new ApiError(404, "NOT_FOUND", "That commitment was not found.");
  if (commitment.status !== "COMMITTED") {
    throw new ApiError(409, "LOCKED", "Quantity can only change while the commitment is still committed.");
  }
  if (commitment.menuItem.menu.cutoffAt.getTime() <= Date.now()) {
    throw new ApiError(409, "CUTOFF_PASSED", "The commitment cutoff for this menu has passed.");
  }
  const settings = await getSettings(tx);
  const quantity = parseQty(quantityKg);
  const cap = commitment.menuItem.maxKgPerHomemaker
    ? Prisma.Decimal.min(commitment.menuItem.maxKgPerHomemaker, settings.maxKgPerCurry)
    : settings.maxKgPerCurry;
  if (quantity.gt(cap)) {
    throw new ApiError(409, "LIMIT_EXCEEDED", `The maximum for this curry is ${cap.toFixed(3)} kg.`);
  }
  const updated = await tx.commitment.update({
    where: { id: commitment.id },
    data: { requestedQuantityKg: quantity },
  });
  await audit(tx, userId, "commitment.quantity", "commitment", commitment.id, { quantityKg: quantity.toFixed(3) });
  return updated;
}

export async function withdrawCommitment(tx: Tx, userId: string, commitmentId: string) {
  const profile = await tx.homemakerProfile.findUnique({ where: { userId } });
  if (!profile) throw new ApiError(403, "FORBIDDEN", "An approved homemaker profile is required.");
  const commitment = await tx.commitment.findFirst({
    where: { id: commitmentId, homemakerProfileId: profile.id },
    include: { menuItem: { include: { menu: true } } },
  });
  if (!commitment) throw new ApiError(404, "NOT_FOUND", "That commitment was not found.");
  if (commitment.status !== "COMMITTED") {
    throw new ApiError(409, "LOCKED", "Only a committed item can be withdrawn.");
  }
  if (commitment.menuItem.menu.cutoffAt.getTime() <= Date.now()) {
    throw new ApiError(409, "CUTOFF_PASSED", "The commitment cutoff for this menu has passed.");
  }
  await audit(tx, userId, "commitment.withdraw", "commitment", commitment.id, { itemName: commitment.itemName });
  await tx.commitment.delete({ where: { id: commitment.id } });
}

export async function transitionCommitment(
  tx: Tx,
  actor: { userId: string; role: "ADMIN" | "HOMEMAKER" },
  commitmentId: string,
  toStatus: CommitmentStatus,
  note?: string,
) {
  await tx.$executeRaw`SELECT id FROM commitments WHERE id = ${commitmentId} FOR UPDATE`;
  const commitment = await tx.commitment.findUnique({
    where: { id: commitmentId },
    include: { homemakerProfile: true, inspection: true, ledger: true },
  });
  if (!commitment) throw new ApiError(404, "NOT_FOUND", "That commitment was not found.");
  if (actor.role === "HOMEMAKER" && commitment.homemakerProfile.userId !== actor.userId) {
    throw new ApiError(404, "NOT_FOUND", "That commitment was not found.");
  }
  const allowed = (actor.role === "ADMIN" ? adminTransitions : homemakerTransitions)[commitment.status];
  if (!allowed.includes(toStatus)) {
    throw new ApiError(409, "INVALID_TRANSITION", `A ${commitment.status.toLowerCase()} commitment cannot move to ${toStatus.toLowerCase()}.`);
  }
  if (toStatus === "COMPLETED") {
    const result = commitment.inspection?.result;
    if (result !== "PASSED" && result !== "RESOLVED_ACCEPTED") {
      throw new ApiError(409, "INSPECTION_REQUIRED", "Complete the commitment only after an accepted inspection.");
    }
  }
  if (toStatus === "REJECTED") {
    const liveCredit = commitment.ledger.find((entry) => entry.type === "CREDIT");
    if (liveCredit) {
      const reversed = commitment.ledger.some((entry) => entry.reversesEntryId === liveCredit.id);
      const paid = commitment.ledger.some((entry) => entry.settlesEntryId === liveCredit.id);
      if (paid) {
        throw new ApiError(409, "PAYOUT_ALREADY_SENT", "This credit was already paid. Record the payout outcome before rejecting it.");
      }
      if (!reversed) {
        await tx.ledgerEntry.create({
          data: {
            entryKey: `reversal:reject:${commitment.id}:${liveCredit.id}`,
            homemakerProfileId: commitment.homemakerProfileId,
            commitmentId: commitment.id,
            inspectionId: commitment.inspection?.id,
            reversesEntryId: liveCredit.id,
            type: "REVERSAL",
            itemName: commitment.itemName,
            serviceDate: commitment.serviceDate,
            acceptedQuantityKg: liveCredit.acceptedQuantityKg,
            ratePerKg: liveCredit.ratePerKg,
            amount: liveCredit.amount,
            note: note?.trim() || "Commitment rejected",
          },
        });
      }
    }
  }
  const updated = await tx.commitment.update({
    where: { id: commitment.id },
    data: {
      status: toStatus,
      events: { create: { fromStatus: commitment.status, toStatus, actorId: actor.userId, note: note?.trim() || null } },
    },
  });
  await notifyUser(tx, commitment.homemakerProfile.userId, {
    type: "commitment.status",
    title: "Preparation update",
    body: `${commitment.itemName} is now ${toStatus.toLowerCase().replaceAll("_", " ")}.`,
    dedupeKey: `commitment:${commitment.id}:${toStatus}`,
  });
  await audit(tx, actor.userId, "commitment.transition", "commitment", commitment.id, {
    from: commitment.status,
    to: toStatus,
    note: note?.trim(),
  });
  return updated;
}
