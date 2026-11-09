import { Prisma } from "@prisma/client";
import type { StockMovementType } from "@prisma/client";
import { ApiError } from "../errors.js";
import type { Tx } from "../db.js";
import { availableKg, parseQty, parseSignedQty, qtyString } from "../money.js";
import { audit } from "./support.js";

export async function applyMovement(
  tx: Tx,
  actorId: string,
  input: {
    lotId: string;
    type: StockMovementType;
    quantityKg: string;
    reason: string;
    stallId?: string;
    idempotencyKey: string;
  },
) {
  await tx.$executeRaw`SELECT id FROM stock_lots WHERE id = ${input.lotId} FOR UPDATE`;
  const lot = await tx.stockLot.findUnique({ where: { id: input.lotId } });
  if (!lot) throw new ApiError(404, "LOT_NOT_FOUND", "That stock lot does not exist.");
  const reason = input.reason.trim();
  const available = availableKg(lot);

  if (input.type === "ALLOCATION") {
    if (!input.stallId) throw new ApiError(400, "STALL_REQUIRED", "Choose a stall for this stock.");
    if (reason.length < 3) throw new ApiError(400, "REASON_REQUIRED", "Add a short note for the allocation.");
    const stall = await tx.stall.findUnique({ where: { id: input.stallId } });
    if (!stall || !stall.active) throw new ApiError(404, "STALL_NOT_FOUND", "That stall is not available.");
    if (stall.serviceAreaId !== lot.serviceAreaId) {
      throw new ApiError(409, "STALL_AREA_MISMATCH", "Choose a stall in the same service area as the cook.");
    }
    await tx.stockLot.update({ where: { id: lot.id }, data: { stallId: stall.id } });
    const movement = await tx.stockMovement.create({
      data: {
        lotId: lot.id,
        stallId: stall.id,
        type: "ALLOCATION",
        quantityKg: available,
        reason,
        actorId,
        idempotencyKey: input.idempotencyKey,
      },
    });
    await audit(tx, actorId, "stock.allocate", "stock_lot", lot.id, { stallId: stall.id, quantityKg: qtyString(available) });
    return { movementId: movement.id, lotId: lot.id, availableKg: qtyString(available), stallId: stall.id };
  }

  if (!lot.stallId) throw new ApiError(409, "ALLOCATE_FIRST", "Allocate this lot to a stall before recording stock movement.");
  if (input.stallId && input.stallId !== lot.stallId) {
    throw new ApiError(409, "STALL_MISMATCH", "This lot is allocated to a different stall.");
  }

  if (input.type === "ADJUSTMENT") {
    if (reason.length < 8) {
      throw new ApiError(400, "REASON_REQUIRED", "Explain the adjustment in at least 8 characters.");
    }
    const signed = parseSignedQty(input.quantityKg);
    if (signed.isNeg() && signed.abs().gt(available)) {
      throw new ApiError(409, "INSUFFICIENT_STOCK", "That adjustment would take available stock below zero.");
    }
    const movement = await tx.stockMovement.create({
      data: {
        lotId: lot.id,
        stallId: lot.stallId,
        type: "ADJUSTMENT",
        quantityKg: signed,
        reason,
        actorId,
        idempotencyKey: input.idempotencyKey,
      },
    });
    await tx.stockLot.update({ where: { id: lot.id }, data: { adjustmentKg: lot.adjustmentKg.add(signed) } });
    const next = available.add(signed);
    await audit(tx, actorId, "stock.adjust", "stock_lot", lot.id, { quantityKg: signed.toFixed(3), reason });
    return { movementId: movement.id, lotId: lot.id, availableKg: qtyString(next), stallId: lot.stallId };
  }

  if (reason.length < 3) throw new ApiError(400, "REASON_REQUIRED", "Add a short note for this stock movement.");
  const quantity = parseQty(input.quantityKg);
  if (quantity.gt(available)) {
    throw new ApiError(409, "INSUFFICIENT_STOCK", `Only ${available.toFixed(3)} kg is available.`);
  }
  const data: Prisma.StockLotUpdateInput =
    input.type === "SALE"
      ? { soldKg: lot.soldKg.add(quantity) }
      : input.type === "WASTE"
        ? { wasteKg: lot.wasteKg.add(quantity) }
        : input.type === "RETURN"
          ? { returnedKg: lot.returnedKg.add(quantity) }
          : {};
  if (!("soldKg" in data) && !("wasteKg" in data) && !("returnedKg" in data)) {
    throw new ApiError(400, "INVALID_MOVEMENT", "Choose sale, waste, return, adjustment, or allocation.");
  }
  const movement = await tx.stockMovement.create({
    data: {
      lotId: lot.id,
      stallId: lot.stallId,
      type: input.type,
      quantityKg: quantity,
      reason,
      actorId,
      idempotencyKey: input.idempotencyKey,
    },
  });
  await tx.stockLot.update({ where: { id: lot.id }, data });
  await audit(tx, actorId, "stock.move", "stock_lot", lot.id, { type: input.type, quantityKg: quantity.toFixed(3) });
  return {
    movementId: movement.id,
    lotId: lot.id,
    availableKg: qtyString(available.sub(quantity)),
    stallId: lot.stallId,
  };
}
