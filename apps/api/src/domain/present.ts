import type { CommitmentStatus, Prisma } from "@prisma/client";
import { isoDate } from "../time.js";
import { availableKg, moneyString, qtyString } from "../money.js";
import { adminTransitions, homemakerTransitions } from "./transitions.js";

export const commitmentInclude = {
  homemakerProfile: { include: { user: { select: { id: true, name: true, phone: true } }, serviceArea: true } },
  collection: true,
  inspection: true,
  lot: { include: { stall: true } },
} satisfies Prisma.CommitmentInclude;

type CommitmentRow = Prisma.CommitmentGetPayload<{ include: typeof commitmentInclude }>;

export function presentInspection(row: NonNullable<CommitmentRow["inspection"]>) {
  return {
    id: row.id,
    commitmentId: row.commitmentId,
    weightKg: qtyString(row.weightKg),
    waterContent: row.waterContent,
    freshness: row.freshness,
    hygiene: row.hygiene,
    notes: row.notes,
    photoUrl: row.photoUrl,
    acceptedQuantityKg: qtyString(row.acceptedQuantityKg),
    resolvedQuantityKg: row.resolvedQuantityKg ? qtyString(row.resolvedQuantityKg) : null,
    result: row.result,
    resolutionReason: row.resolutionReason,
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

export function presentCommitment(row: CommitmentRow, viewer: "admin" | "homemaker") {
  const transitions = viewer === "admin" ? adminTransitions : homemakerTransitions;
  return {
    id: row.id,
    serviceDate: isoDate(row.serviceDate),
    menuItemId: row.menuItemId,
    itemName: row.itemName,
    requestedQuantityKg: qtyString(row.requestedQuantityKg),
    ratePerKg: moneyString(row.ratePerKg),
    preparationInstructions: row.preparationInstructions,
    status: row.status,
    allowedTransitions: transitions[row.status as CommitmentStatus],
    updatedAt: row.updatedAt.toISOString(),
    homemaker:
      viewer === "admin"
        ? {
            id: row.homemakerProfile.id,
            userId: row.homemakerProfile.user.id,
            name: row.homemakerProfile.user.name,
            phone: row.homemakerProfile.user.phone,
            addressLine: row.homemakerProfile.addressLine,
            serviceAreaId: row.homemakerProfile.serviceAreaId,
            serviceArea: row.homemakerProfile.serviceArea.name,
          }
        : undefined,
    collection: row.collection
      ? {
          status: row.collection.status,
          collectedAt: row.collection.collectedAt?.toISOString() ?? null,
          staffName: row.collection.staffName,
          notes: row.collection.notes,
        }
      : null,
    inspection: row.inspection ? presentInspection(row.inspection) : null,
    stock: row.lot
      ? {
          id: row.lot.id,
          stallId: row.lot.stallId,
          stallName: row.lot.stall?.name ?? null,
          availableKg: qtyString(availableKg(row.lot)),
        }
      : null,
  };
}

export function presentSettings(row: {
  maxCurriesPerHomemakerPerDay: number;
  maxKgPerCurry: Prisma.Decimal;
  menuPublishCutoffLocal: string;
  commitmentCutoffLocal: string;
  timezone: string;
  agreementVersion: string;
  currency: string;
  updatedAt: Date;
}) {
  return {
    maxCurriesPerHomemakerPerDay: row.maxCurriesPerHomemakerPerDay,
    maxKgPerCurry: qtyString(row.maxKgPerCurry),
    menuPublishCutoffLocal: row.menuPublishCutoffLocal,
    commitmentCutoffLocal: row.commitmentCutoffLocal,
    timezone: row.timezone,
    agreementVersion: row.agreementVersion,
    currency: row.currency,
    updatedAt: row.updatedAt.toISOString(),
  };
}
