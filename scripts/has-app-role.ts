import { PrismaClient } from "@prisma/client";

const databaseUrl = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL;
if (!databaseUrl) {
  console.log("no");
  process.exit(0);
}

const prisma = new PrismaClient({ datasourceUrl: databaseUrl });

async function main() {
  const rows = await prisma.$queryRaw<Array<{ present: boolean }>>`
    SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'curry_app') AS present
  `;
  console.log(rows[0]?.present ? "yes" : "no");
  await prisma.$disconnect();
}

main().catch(async (error: unknown) => {
  console.error(error);
  await prisma.$disconnect();
  process.exit(1);
});
