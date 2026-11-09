import { Prisma } from "@prisma/client";
import type { Freshness, Hygiene, InspectionResult, WaterContent } from "@prisma/client";
import { ApiError } from "../errors.js";
import type { Tx } from "../db.js";
import { creditAmount, parseQty } from "../money.js";
import { isoDate } from "../time.js";
import { audit, notifyAdmins, notifyUser } from "./support.js";
import { transitionCommitment } from "./commitments.js";

type Measurement = {
  weightKg: Prisma.Decimal;
  acceptedQuantityKg: Prisma.Decimal;
  waterContent: WaterContent;
  freshness: Freshness;
  hygiene: Hygiene;
  notes?: string | null;
  photoUrl?: string | null;
  result: InspectionResult;
};

function assertMeasurement(input: Measurement, requested: Prisma.Decimal) {
  if (input.weightKg.lte(0)) throw new ApiError(400, "INVALID_QUANTITY", "Record a weight greater than zero.");
  if (input.acceptedQuantityKg.gt(input.weightKg)) {
    throw new ApiError(409, "QUANTITY_ABOVE_WEIGHT", "Accepted quantity cannot exceed the weighed quantity.");
  }
  if (input.acceptedQuantityKg.gt(requested)) {
    throw new ApiError(409, "QUANTITY_ABOVE_REQUEST", "Accepted quantity cannot exceed the requested quantity.");
  }
  const unsafe = input.hygiene === "FAIL" || input.freshness === "POOR";
  if (unsafe && input.result === "PASSED") {
    throw new ApiError(409, "INSPECTION_FAILED_RULE", "Poor freshness or a hygiene failure cannot be passed.");
  }
  if (input.result === "PASSED" && input.acceptedQuantityKg.lte(0)) {
    throw new ApiError(409, "ACCEPTED_QUANTITY_REQUIRED", "A passed inspection needs an accepted quantity.");
  }
  if (input.result === "FAILED" && input.acceptedQuantityKg.gt(0)) {
    throw new ApiError(409, "FAILED_QUANTITY", "A failed inspection must record an accepted quantity of 0.");
  }
}

async function postCredit(
  tx: Tx,
  input: {
    entryKey: string;
    profileId: string;
    commitmentId: string;
    inspectionId: string;
    itemName: string;
    serviceDate: Date;
    quantity: Prisma.Decimal;
    rate: Prisma.Decimal;
    note?: string;
  },
) {
  const amount = creditAmount(input.quantity, input.rate);
  const entry = await tx.ledgerEntry.create({
    data: {
      entryKey: input.entryKey,
      homemakerProfileId: input.profileId,
      commitmentId: input.commitmentId,
      inspectionId: input.inspectionId,
      type: "CREDIT",
      itemName: input.itemName,
      serviceDate: input.serviceDate,
      acceptedQuantityKg: input.quantity,
      ratePerKg: input.rate,
      amount,
      note: input.note,
    },
  });
  return { entry, amount };
}

async function openStock(
  tx: Tx,
  input: {
    commitmentId: string;
    inspectionId: string;
    menuItemId: string;
    serviceAreaId: string;
    quantity: Prisma.Decimal;
  },
) {
  const existing = await tx.stockLot.findUnique({ where: { inspectionId: input.inspectionId } });
  if (existing) return existing;
  return tx.stockLot.create({
    data: {
      commitmentId: input.commitmentId,
      inspectionId: input.inspectionId,
      menuItemId: input.menuItemId,
      serviceAreaId: input.serviceAreaId,
      acceptedKg: input.quantity,
    },
  });
}

export async function recordCollection(
  tx: Tx,
  actorId: string,
  commitmentId: string,
  input: { status: "SCHEDULED" | "COLLECTED" | "MISSED"; collectedAt?: string; staffName?: string; notes?: string },
) {
  const commitment = await tx.commitment.findUnique({ where: { id: commitmentId } });
  if (!commitment) throw new ApiError(404, "NOT_FOUND", "That commitment was not found.");
  if (input.status === "COLLECTED") {
    if (!input.collectedAt || !input.staffName?.trim()) {
      throw new ApiError(400, "COLLECTION_DETAILS_REQUIRED", "Collected items need a staff name and a collection time.");
    }
    if (commitment.status === "READY_FOR_COLLECTION") {
      await transitionCommitment(tx, { userId: actorId, role: "ADMIN" }, commitmentId, "COLLECTED", input.notes);
    } else if (commitment.status !== "COLLECTED" && commitment.status !== "COMPLETED") {
      throw new ApiError(409, "NOT_READY", "Mark the item ready for collection before recording pickup.");
    }
  }
  const collectedAt = input.collectedAt ? new Date(input.collectedAt) : null;
  if (input.collectedAt && Number.isNaN(collectedAt?.getTime())) {
    throw new ApiError(400, "INVALID_DATE", "Collection time must be a valid date and time.");
  }
  const record = await tx.collectionRecord.upsert({
    where: { commitmentId },
    create: {
      commitmentId,
      status: input.status,
      collectedAt,
      staffName: input.staffName?.trim() || null,
      notes: input.notes?.trim() || null,
      updatedById: actorId,
    },
    update: {
      status: input.status,
      collectedAt,
      staffName: input.staffName?.trim() || null,
      notes: input.notes?.trim() || null,
      updatedById: actorId,
    },
  });
  await audit(tx, actorId, "collection.record", "commitment", commitmentId, {
    status: input.status,
    staffName: input.staffName?.trim(),
  });
  return record;
}

export async function recordInspection(
  tx: Tx,
  actorId: string,
  commitmentId: string,
  input: Measurement,
) {
  await tx.$executeRaw`SELECT id FROM commitments WHERE id = ${commitmentId} FOR UPDATE`;
  const commitment = await tx.commitment.findUnique({
    where: { id: commitmentId },
    include: { homemakerProfile: true, menuItem: { include: { menu: true } }, inspection: true },
  });
  if (!commitment) throw new ApiError(404, "NOT_FOUND", "That commitment was not found.");
  if (commitment.status !== "COLLECTED") {
    throw new ApiError(409, "NOT_COLLECTED", "Record collection before inspection.");
  }
  if (commitment.inspection) throw new ApiError(409, "INSPECTION_EXISTS", "This commitment already has an inspection.");
  assertMeasurement(input, commitment.requestedQuantityKg);

  const inspection = await tx.inspection.create({
    data: {
      commitmentId,
      weightKg: input.weightKg,
      waterContent: input.waterContent,
      freshness: input.freshness,
      hygiene: input.hygiene,
      notes: input.notes?.trim() || null,
      photoUrl: input.photoUrl?.trim() || null,
      acceptedQuantityKg: input.acceptedQuantityKg,
      result: input.result,
      resolvedQuantityKg: input.result === "PASSED" ? input.acceptedQuantityKg : null,
      createdById: actorId,
    },
  });

  if (input.result === "PASSED") {
    await openStock(tx, {
      commitmentId,
      inspectionId: inspection.id,
      menuItemId: commitment.menuItemId,
      serviceAreaId: commitment.menuItem.menu.serviceAreaId,
      quantity: input.acceptedQuantityKg,
    });
    const { amount } = await postCredit(tx, {
      entryKey: `credit:${inspection.id}`,
      profileId: commitment.homemakerProfileId,
      commitmentId,
      inspectionId: inspection.id,
      itemName: commitment.itemName,
      serviceDate: commitment.serviceDate,
      quantity: input.acceptedQuantityKg,
      rate: commitment.ratePerKg,
      note: "Accepted at inspection",
    });
    await transitionCommitment(tx, { userId: actorId, role: "ADMIN" }, commitmentId, "COMPLETED", "Inspection accepted");
    await notifyUser(tx, commitment.homemakerProfile.userId, {
      type: "wallet.credit",
      title: "Wallet credited",
      body: `${commitment.itemName}: ${input.acceptedQuantityKg.toFixed(3)} kg accepted, ₹${amount.toFixed(2)}.`,
      dedupeKey: `credit:${inspection.id}`,
    });
  } else {
    await notifyUser(tx, commitment.homemakerProfile.userId, {
      type: "inspection.review",
      title: "Inspection needs review",
      body: `${commitment.itemName} on ${isoDate(commitment.serviceDate)} was marked ${input.result.toLowerCase()}. Payment waits until it is resolved.`,
      dedupeKey: `inspection:${inspection.id}:opened`,
    });
    await notifyAdmins(tx, {
      type: "inspection.review",
      title: "Inspection needs a decision",
      body: `${commitment.itemName} was recorded as ${input.result.toLowerCase()}.`,
      dedupeKey: `inspection:${inspection.id}:admins`,
    });
  }

  await audit(tx, actorId, "inspection.record", "inspection", inspection.id, {
    result: input.result,
    acceptedQuantityKg: input.acceptedQuantityKg.toFixed(3),
  });
  return inspection;
}

export async function disputeInspection(
  tx: Tx,
  actor: { userId: string; role: "ADMIN" | "HOMEMAKER" },
  inspectionId: string,
  reason: string,
) {
  const inspection = await tx.inspection.findUnique({
    where: { id: inspectionId },
    include: {
      commitment: { include: { homemakerProfile: true, ledger: true } },
    },
  });
  if (!inspection) throw new ApiError(404, "NOT_FOUND", "That inspection was not found.");
  if (actor.role === "HOMEMAKER" && inspection.commitment.homemakerProfile.userId !== actor.userId) {
    throw new ApiError(404, "NOT_FOUND", "That inspection was not found.");
  }
  if (inspection.result !== "PASSED" && inspection.result !== "FAILED") {
    throw new ApiError(409, "NOT_DISPUTABLE", "This inspection is already under review or resolved.");
  }
  const note = reason.trim();
  if (note.length < 8) throw new ApiError(400, "REASON_REQUIRED", "Describe the dispute in at least 8 characters.");
  const credit = inspection.commitment.ledger.find((entry) => entry.type === "CREDIT" && entry.inspectionId === inspection.id);
  if (credit) {
    const paid = inspection.commitment.ledger.some((entry) => entry.settlesEntryId === credit.id);
    if (paid) throw new ApiError(409, "PAYOUT_ALREADY_SENT", "This amount was already paid out. Ask an admin to review it.");
    const already = inspection.commitment.ledger.some((entry) => entry.reversesEntryId === credit.id);
    if (!already) {
      await tx.ledgerEntry.create({
        data: {
          entryKey: `reversal:dispute:${inspection.id}`,
          homemakerProfileId: inspection.commitment.homemakerProfileId,
          commitmentId: inspection.commitmentId,
          inspectionId: inspection.id,
          reversesEntryId: credit.id,
          type: "REVERSAL",
          itemName: inspection.commitment.itemName,
          serviceDate: inspection.commitment.serviceDate,
          acceptedQuantityKg: credit.acceptedQuantityKg,
          ratePerKg: credit.ratePerKg,
          amount: credit.amount,
          note: `Dispute opened: ${note}`,
        },
      });
    }
  }
  await tx.inspection.update({ where: { id: inspection.id }, data: { result: "DISPUTED" } });
  await notifyUser(tx, inspection.commitment.homemakerProfile.userId, {
    type: "inspection.disputed",
    title: "Dispute recorded",
    body: `${inspection.commitment.itemName} is on hold until an admin resolves it.`,
    dedupeKey: `inspection:${inspection.id}:disputed`,
  });
  await notifyAdmins(tx, {
    type: "inspection.disputed",
    title: "Homemaker disputed an inspection",
    body: `${inspection.commitment.itemName}: ${note}`,
    dedupeKey: `inspection:${inspection.id}:dispute-admin`,
  });
  await audit(tx, actor.userId, "inspection.dispute", "inspection", inspection.id, { reason: note });
}

export async function resolveInspection(
  tx: Tx,
  actorId: string,
  inspectionId: string,
  input: { outcome: "accepted" | "rejected"; acceptedQuantityKg?: string; reason: string },
) {
  await tx.$executeRaw`SELECT id FROM inspections WHERE id = ${inspectionId} FOR UPDATE`;
  const inspection = await tx.inspection.findUnique({
    where: { id: inspectionId },
    include: {
      commitment: { include: { homemakerProfile: true, menuItem: { include: { menu: true } }, ledger: true } },
    },
  });
  if (!inspection) throw new ApiError(404, "NOT_FOUND", "That inspection was not found.");
  if (inspection.result !== "FAILED" && inspection.result !== "DISPUTED") {
    throw new ApiError(409, "NOT_OPEN", "Only a failed or disputed inspection can be resolved.");
  }
  const reason = input.reason.trim();
  if (reason.length < 8) throw new ApiError(400, "REASON_REQUIRED", "Record a resolution reason of at least 8 characters.");
  const commitment = inspection.commitment;

  if (input.outcome === "rejected") {
    await tx.inspection.update({
      where: { id: inspection.id },
      data: {
        result: "RESOLVED_REJECTED",
        resolutionReason: reason,
        resolvedAt: new Date(),
        resolvedById: actorId,
        resolvedQuantityKg: new Prisma.Decimal(0),
      },
    });
    if (commitment.status !== "REJECTED") {
      await transitionCommitment(tx, { userId: actorId, role: "ADMIN" }, commitment.id, "REJECTED", reason);
    }
    await notifyUser(tx, commitment.homemakerProfile.userId, {
      type: "inspection.resolved",
      title: "Inspection closed",
      body: `${commitment.itemName} was not accepted. ${reason}`,
      dedupeKey: `inspection:${inspection.id}:resolved`,
    });
    await audit(tx, actorId, "inspection.resolve", "inspection", inspection.id, { outcome: "rejected", reason });
    return;
  }

  if (!input.acceptedQuantityKg) {
    throw new ApiError(400, "ACCEPTED_QUANTITY_REQUIRED", "Enter the accepted quantity.");
  }
  const quantity = parseQty(input.acceptedQuantityKg);
  if (quantity.gt(inspection.weightKg)) {
    throw new ApiError(409, "QUANTITY_ABOVE_WEIGHT", "Accepted quantity cannot exceed the weighed quantity.");
  }
  if (quantity.gt(commitment.requestedQuantityKg)) {
    throw new ApiError(409, "QUANTITY_ABOVE_REQUEST", "Accepted quantity cannot exceed the requested quantity.");
  }
  await tx.inspection.update({
    where: { id: inspection.id },
    data: {
      result: "RESOLVED_ACCEPTED",
      resolutionReason: reason,
      resolvedAt: new Date(),
      resolvedById: actorId,
      resolvedQuantityKg: quantity,
    },
  });
  await openStock(tx, {
    commitmentId: commitment.id,
    inspectionId: inspection.id,
    menuItemId: commitment.menuItemId,
    serviceAreaId: commitment.menuItem.menu.serviceAreaId,
    quantity,
  });
  const { amount } = await postCredit(tx, {
    entryKey: `credit:resolved:${inspection.id}`,
    profileId: commitment.homemakerProfileId,
    commitmentId: commitment.id,
    inspectionId: inspection.id,
    itemName: commitment.itemName,
    serviceDate: commitment.serviceDate,
    quantity,
    rate: commitment.ratePerKg,
    note: `Accepted on review: ${reason}`,
  });
  if (commitment.status === "COLLECTED") {
    await transitionCommitment(tx, { userId: actorId, role: "ADMIN" }, commitment.id, "COMPLETED", reason);
  }
  await notifyUser(tx, commitment.homemakerProfile.userId, {
    type: "wallet.credit",
    title: "Inspection accepted",
    body: `${commitment.itemName}: ${quantity.toFixed(3)} kg credited, ₹${amount.toFixed(2)}.`,
    dedupeKey: `credit:resolved:${inspection.id}`,
  });
  await audit(tx, actorId, "inspection.resolve", "inspection", inspection.id, {
    outcome: "accepted",
    quantityKg: quantity.toFixed(3),
    reason,
  });
}
