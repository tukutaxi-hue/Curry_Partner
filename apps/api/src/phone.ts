import { ApiError } from "./errors.js";

export function normalizePhone(input: string): string {
  let phone = input.trim().replace(/[\s()-]/g, "");
  if (phone.startsWith("00")) phone = `+${phone.slice(2)}`;
  if (/^\d{10}$/.test(phone)) phone = `+91${phone}`;
  if (!/^\+[1-9]\d{9,14}$/.test(phone)) {
    throw new ApiError(400, "INVALID_PHONE", "Enter a valid phone number with country code.");
  }
  return phone;
}
