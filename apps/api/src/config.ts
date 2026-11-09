import { config as loadEnv } from "dotenv";
import { resolve } from "node:path";

loadEnv({ path: resolve(process.cwd(), ".env") });

const nodeEnv = process.env.NODE_ENV ?? "development";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable ${name}`);
  return value;
}

const accessTokenSecret = required("ACCESS_TOKEN_SECRET");
const databaseUrl = required("DATABASE_URL");

if (accessTokenSecret.length < 32) {
  throw new Error("ACCESS_TOKEN_SECRET must be at least 32 characters.");
}

if (nodeEnv === "production") {
  const haystack = `${accessTokenSecret}\n${databaseUrl}\n${process.env.MIGRATION_DATABASE_URL ?? ""}`;
  const banned = ["replace-me", "local-dev", "change-me", "DemoAdmin", "DemoHome", "DemoTemp"];
  if (banned.some((item) => haystack.includes(item))) {
    throw new Error("Refusing to start with placeholder credentials in production.");
  }
  if (process.env.COOKIE_SECURE !== "true") {
    throw new Error("COOKIE_SECURE must be true in production.");
  }
}

export const config = {
  nodeEnv,
  isProduction: nodeEnv === "production",
  host: process.env.API_HOST ?? "0.0.0.0",
  port: Number(process.env.API_PORT ?? 4000),
  accessTokenSecret,
  corsOrigins: (process.env.CORS_ORIGINS ?? "http://localhost:5173")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean),
  cookieSecure: process.env.COOKIE_SECURE === "true",
  enableScheduler: process.env.ENABLE_SCHEDULER !== "false" && nodeEnv !== "test",
};
