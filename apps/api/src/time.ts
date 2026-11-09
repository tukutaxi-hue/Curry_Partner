import { DateTime } from "luxon";
import { ApiError } from "./errors.js";

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function assertClockTime(value: string) {
  if (!TIME.test(value)) {
    throw new ApiError(400, "INVALID_TIME", "Use a 24-hour time like 17:00.");
  }
}

export function assertTimeZone(value: string) {
  const zoned = DateTime.now().setZone(value);
  if (!zoned.isValid) throw new ApiError(400, "INVALID_TIMEZONE", "That timezone is not recognized.");
}

export function asDateOnly(isoDate: string): Date {
  if (!DATE.test(isoDate)) throw new ApiError(400, "INVALID_DATE", "Use a YYYY-MM-DD date.");
  return new Date(`${isoDate}T00:00:00.000Z`);
}

export function isoDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

export function zonedPreviousDay(serviceDate: string, time: string, zone: string): Date {
  assertClockTime(time);
  const [hour, minute] = time.split(":").map((part) => Number(part));
  const zoned = DateTime.fromISO(serviceDate, { zone }).minus({ days: 1 }).set({
    hour,
    minute,
    second: 0,
    millisecond: 0,
  });
  if (!zoned.isValid) throw new ApiError(400, "INVALID_DATE", "That service date is not valid in the configured timezone.");
  return zoned.toJSDate();
}

export function todayInZone(zone: string): string {
  const today = DateTime.now().setZone(zone).toISODate();
  if (!today) throw new ApiError(500, "CLOCK_ERROR", "Could not resolve today's date.");
  return today;
}

export function mondayWeek(weekStart: string): { start: Date; end: Date } {
  const start = DateTime.fromISO(weekStart, { zone: "utc" });
  if (!start.isValid || !DATE.test(weekStart) || start.weekday !== 1) {
    throw new ApiError(400, "INVALID_WEEK", "weekStart must be a Monday written as YYYY-MM-DD.");
  }
  return {
    start: asDateOnly(weekStart),
    end: asDateOnly(start.plus({ days: 6 }).toISODate()!),
  };
}
