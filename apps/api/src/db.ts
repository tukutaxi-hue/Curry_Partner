import { Prisma, PrismaClient } from "@prisma/client";

export const prisma = new PrismaClient();
export type Tx = Prisma.TransactionClient;
export type ActorRole = "ADMIN" | "HOMEMAKER" | "PUBLIC";

export async function setActor(tx: Tx, actor: { userId: string; role: ActorRole }) {
  await tx.$executeRaw`SELECT set_config('app.user_id', ${actor.userId}, true)`;
  await tx.$executeRaw`SELECT set_config('app.role', ${actor.role}, true)`;
}

export async function transaction<T>(
  actor: { userId: string; role: ActorRole },
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await setActor(tx, actor);
    return fn(tx);
  });
}
