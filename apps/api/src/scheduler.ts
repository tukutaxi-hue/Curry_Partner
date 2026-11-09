import type { FastifyBaseLogger } from "fastify";
import { transaction } from "./db.js";
import { notifyUser } from "./domain/support.js";
import { isoDate } from "./time.js";

export function startScheduler(log: FastifyBaseLogger) {
  const timer = setInterval(() => {
    void sendCutoffReminders(log);
  }, 60_000);
  timer.unref();
}

async function sendCutoffReminders(log: FastifyBaseLogger) {
  try {
    await transaction({ userId: "scheduler", role: "ADMIN" }, async (tx) => {
      const now = new Date();
      const soon = new Date(now.getTime() + 2 * 60 * 60 * 1000);
      const menus = await tx.dailyMenu.findMany({
        where: { status: "PUBLISHED", cutoffAt: { gt: now, lte: soon } },
        include: { serviceArea: true },
      });
      for (const menu of menus) {
        const profiles = await tx.homemakerProfile.findMany({
          where: { serviceAreaId: menu.serviceAreaId, user: { accountStatus: "ACTIVE", role: "HOMEMAKER" } },
          select: { userId: true },
        });
        for (const profile of profiles) {
          await notifyUser(tx, profile.userId, {
            type: "menu.cutoff",
            title: "Commitment cutoff is close",
            body: `${menu.serviceArea.name} commitments for ${isoDate(menu.serviceDate)} close within two hours.`,
            dedupeKey: `cutoff:${menu.id}`,
          });
        }
      }
    });
  } catch (error) {
    log.error({ err: error }, "cutoff reminder failed");
  }
}
