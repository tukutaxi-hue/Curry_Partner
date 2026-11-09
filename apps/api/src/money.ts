import { Prisma } from "@prisma/client";
import { ApiError } from "./errors.js";

export function dec(value: Prisma.Decimal | string | number): Prisma.Decimal {
  return new Prisma.Decimal(value);
}

export function qtyString(value: Prisma.Decimal | string | number): string {
  return dec(value).toFixed(3);
}

export function moneyString(value: Prisma.Decimal | string | number): string {
  return dec(value).toFixed(2);
}

export function creditAmount(quantity: Prisma.Decimal, rate: Prisma.Decimal): Prisma.Decimal {
  return quantity.mul(rate).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
}

export function parseQty(value: string, options?: { allowZero?: boolean }): Prisma.Decimal {
  if (!/^\d+(\.\d{1,3})?$/.test(value)) {
    throw new ApiError(400, "INVALID_QUANTITY", "Enter kilograms with up to 3 decimal places.");
  }
  const parsed = new Prisma.Decimal(value);
  if (options?.allowZero ? parsed.isNeg() : parsed.lte(0)) {
    throw new ApiError(400, "INVALID_QUANTITY", "Quantity must be greater than zero.");
  }
  return parsed;
}

export function parseSignedQty(value: string): Prisma.Decimal {
  if (!/^-?\d+(\.\d{1,3})?$/.test(value)) {
    throw new ApiError(400, "INVALID_QUANTITY", "Enter an adjustment with up to 3 decimal places.");
  }
  const parsed = new Prisma.Decimal(value);
  if (parsed.isZero()) {
    throw new ApiError(400, "INVALID_QUANTITY", "An adjustment cannot be zero.");
  }
  return parsed;
}

export function availableKg(lot: {
  acceptedKg: Prisma.Decimal;
  adjustmentKg: Prisma.Decimal;
  soldKg: Prisma.Decimal;
  wasteKg: Prisma.Decimal;
  returnedKg: Prisma.Decimal;
}): Prisma.Decimal {
  return lot.acceptedKg.add(lot.adjustmentKg).sub(lot.soldKg).sub(lot.wasteKg).sub(lot.returnedKg);
}
