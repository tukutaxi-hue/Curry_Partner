import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import Fastify from "fastify";
import { config } from "./config.js";
import { sendError } from "./http.js";
import { registerAdminRoutes } from "./routes/admin.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerHomemakerRoutes } from "./routes/homemaker.js";
import { registerPublicRoutes } from "./routes/public.js";

export async function buildApp() {
  const app = Fastify({
    logger: {
      level: config.nodeEnv === "test" ? "silent" : "info",
      redact: {
        paths: [
          "req.headers.authorization",
          "req.headers.cookie",
          "req.body.password",
          "req.body.currentPassword",
          "req.body.newPassword",
          "req.body.refreshToken",
          "req.body.temporaryPassword",
        ],
        censor: "[redacted]",
      },
    },
    bodyLimit: 1_000_000,
  });

  await app.register(helmet, {
    global: true,
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: { policy: "cross-origin" },
  });
  await app.register(cors, { origin: config.corsOrigins, credentials: true });
  await app.register(cookie);
  await app.register(rateLimit, { global: true, max: config.nodeEnv === "test" ? 10_000 : 300, timeWindow: "1 minute" });
  app.setErrorHandler((error, _request, reply) => {
    if (reply.sent) return;
    sendError(reply, error);
  });

  await registerPublicRoutes(app);
  await registerAuthRoutes(app);
  await app.register(registerAdminRoutes, { prefix: "/api/admin" });
  await app.register(registerHomemakerRoutes, { prefix: "/api/homemaker" });
  return app;
}
