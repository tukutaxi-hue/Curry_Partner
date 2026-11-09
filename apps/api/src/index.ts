import { buildApp } from "./app.js";
import { config } from "./config.js";
import { prisma } from "./db.js";
import { startScheduler } from "./scheduler.js";

const app = await buildApp();
if (config.enableScheduler) startScheduler(app.log);

try {
  await app.listen({ host: config.host, port: config.port });
} catch (error) {
  app.log.error(error);
  await prisma.$disconnect();
  process.exit(1);
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    await app.close();
    await prisma.$disconnect();
    process.exit(0);
  });
}
