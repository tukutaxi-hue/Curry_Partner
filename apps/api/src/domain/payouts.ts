import { Prisma } from "@prisma/client";
import { ApiError } from "../errors.js";
import type { Tx } from "../db.js";
import { dec, moneyString } from "../money.js";
import { isoDate, mondayWeek } from "../time.js";
import { audit, notifyUser } from "./support.js";

const payableWhere = {
  type: "CREDIT" as const,
  reversedBy: { none: {} },
  settledBy: { is: null },
  payoutLinks: { none: { activeLedgerKey: { not: null } } },
  inspection: { result: { in: ["PASSED" as const, "RESOLVED_ACCEPTED" as const] } },
};

export async function createPayoutBatch(tx: Tx, actorId: string, weekStart: string) {
  const range = mondayWeek(weekStart);
  const credits = await tx.ledgerEntry.findMany({
    where: { ...payableWhere, serviceDate: { gte: range.start, lte: range.end } },
    orderBy: [{ homemakerProfileId: "asc" }, { createdAt: "asc" }],
  });
  if (credits.length === 0) {
    throw new ApiError(409, "NOTHING_TO_PAY", "No unpaid accepted credits fall in that week.");
  }
  const groups = new Map<string, typeof credits>();
  for (const credit of credits) {
    const list = groups.get(credit.homemakerProfileId) ?? [];
    list.push(credit);
    groups.set(credit.homemakerProfileId, list);
  }
  const batch = await tx.payoutBatch.create({
    data: {
      weekStart: range.start,
      weekEnd: range.end,
      status: "DRAFT",
      createdById: actorId,
      items: {
        create: [...groups.entries()].map(([homemakerProfileId, entries]) => ({
          homemakerProfileId,
          amount: entries.reduce((sum, entry) => sum.add(entry.amount), dec(0)),
          status: "PENDING",
          credits: {
            create: entries.map((entry) => ({
              ledgerEntryId: entry.id,
              activeLedgerKey: entry.id,
            })),
          },
        })),
      },
    },
    include: { items: { include: { profile: { include: { user: { select: { name: true, phone: true } } } }, credits: true } } },
  });
  await audit(tx, actorId, "payout.create", "payout_batch", batch.id, {
    weekStart,
    itemCount: batch.items.length,
  });
  return presentBatch(batch);
}

type BatchRow = Prisma.PayoutBatchGetPayload<{
  include: { items: { include: { profile: { include: { user: { select: { name: true; phone: true } } } }; credits: true } } };
}>;

export function presentBatch(batch: BatchRow) {
  return {
    id: batch.id,
    weekStart: isoDate(batch.weekStart),
    weekEnd: isoDate(batch.weekEnd),
    status: batch.status,
    reference: batch.reference,
    failureDetail: batch.failureDetail,
    createdAt: batch.createdAt.toISOString(),
    items: batch.items.map((item) => ({
      id: item.id,
      homemakerProfileId: item.homemakerProfileId,
      name: item.profile.user.name,
      phone: item.profile.user.phone,
      amount: moneyString(item.amount),
      status: item.status,
      reference: item.reference,
      failureDetail: item.failureDetail,
      creditCount: item.credits.length,
    })),
  };
}

const batchInclude = {
  items: { include: { profile: { include: { user: { select: { name: true, phone: true } } } }, credits: true } },
} satisfies Prisma.PayoutBatchInclude;

export async function approvePayoutBatch(tx: Tx, actorId: string, batchId: string) {
  const batch = await tx.payoutBatch.findUnique({ where: { id: batchId }, include: batchInclude });
  if (!batch) throw new ApiError(404, "NOT_FOUND", "That payout batch was not found.");
  if (batch.status !== "DRAFT" && batch.status !== "APPROVED") {
    throw new ApiError(409, "PAYOUT_LOCKED", "This payout batch can no longer be approved.");
  }
  if (batch.status === "DRAFT") {
    await tx.payoutBatch.update({ where: { id: batch.id }, data: { status: "APPROVED" } });
    await tx.payoutItem.updateMany({ where: { batchId: batch.id, status: "PENDING" }, data: { status: "APPROVED" } });
    await audit(tx, actorId, "payout.approve", "payout_batch", batch.id, {});
  }
  const fresh = await tx.payoutBatch.findUniqueOrThrow({ where: { id: batch.id }, include: batchInclude });
  return presentBatch(fresh);
}

export async function failPayoutItem(tx: Tx, actorId: string, itemId: string, failureDetail: string) {
  const detail = failureDetail.trim();
  if (detail.length < 8) throw new ApiError(400, "REASON_REQUIRED", "Describe the failure in at least 8 characters.");
  const item = await tx.payoutItem.findUnique({ where: { id: itemId }, include: { batch: true } });
  if (!item) throw new ApiError(404, "NOT_FOUND", "That payout line was not found.");
  if (item.status === "PAID" || item.batch.status === "PAID") {
    throw new ApiError(409, "PAYOUT_LOCKED", "A paid line cannot be marked failed.");
  }
  if (item.status !== "FAILED") {
    await tx.payoutItem.update({ where: { id: item.id }, data: { status: "FAILED", failureDetail: detail } });
    await tx.payoutItemCredit.updateMany({ where: { payoutItemId: item.id }, data: { activeLedgerKey: null } });
    await audit(tx, actorId, "payout.fail", "payout_item", item.id, { failureDetail: detail });
  }
  const fresh = await tx.payoutBatch.findUniqueOrThrow({ where: { id: item.batchId }, include: batchInclude });
  return presentBatch(fresh);
}

export async function markPayoutBatchPaid(tx: Tx, actorId: string, batchId: string, reference: string) {
  const payoutReference = reference.trim();
  if (payoutReference.length < 4) throw new ApiError(400, "REFERENCE_REQUIRED", "Enter the payout reference.");
  const batch = await tx.payoutBatch.findUnique({
    where: { id: batchId },
    include: { items: { include: { credits: { include: { ledgerEntry: true } }, profile: true } } },
  });
  if (!batch) throw new ApiError(404, "NOT_FOUND", "That payout batch was not found.");
  if (batch.status !== "APPROVED" && batch.status !== "PAID") {
    throw new ApiError(409, "PAYOUT_NOT_APPROVED", "Approve the batch before marking it paid.");
  }
  if (batch.status !== "PAID") {
    for (const item of batch.items) {
      if (item.status === "FAILED" || item.status === "REVERSED") continue;
      for (const link of item.credits) {
        const credit = link.ledgerEntry;
        if (credit.type !== "CREDIT") continue;
        const existing = await tx.ledgerEntry.findUnique({ where: { settlesEntryId: credit.id } });
        if (!existing) {
          await tx.ledgerEntry.create({
            data: {
              entryKey: `payout:${credit.id}`,
              homemakerProfileId: credit.homemakerProfileId,
              commitmentId: credit.commitmentId,
              inspectionId: credit.inspectionId,
              settlesEntryId: credit.id,
              type: "PAYOUT",
              itemName: credit.itemName,
              serviceDate: credit.serviceDate,
              acceptedQuantityKg: credit.acceptedQuantityKg,
              ratePerKg: credit.ratePerKg,
              amount: credit.amount,
              note: `Payout ${payoutReference}`,
            },
          });
        }
      }
      await tx.payoutItem.update({
        where: { id: item.id },
        data: { status: "PAID", reference: payoutReference },
      });
      await notifyUser(tx, item.profile.userId, {
        type: "payout.paid",
        title: "Payout sent",
        body: `₹${moneyString(item.amount)} was marked paid. Reference ${payoutReference}.`,
        dedupeKey: `payout-item:${item.id}:paid`,
      });
    }
    const failed = batch.items.filter((item) => item.status === "FAILED").length;
    await tx.payoutBatch.update({
      where: { id: batch.id },
      data: {
        status: failed === batch.items.length ? "FAILED" : "PAID",
        reference: payoutReference,
        failureDetail: failed ? `${failed} line(s) were already marked failed.` : null,
      },
    });
    await audit(tx, actorId, "payout.paid", "payout_batch", batch.id, { reference: payoutReference });
  }
  const fresh = await tx.payoutBatch.findUniqueOrThrow({ where: { id: batch.id }, include: batchInclude });
  return presentBatch(fresh);
}
