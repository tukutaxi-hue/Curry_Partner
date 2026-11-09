import { PrismaClient, Prisma } from "@prisma/client";
import { DateTime } from "luxon";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { hashPassword } from "../src/auth/passwords.js";
import { setActor, prisma } from "../src/db.js";
import { buildApp } from "../src/app.js";
import type { FastifyInstance } from "fastify";

const owner = new PrismaClient({
  datasources: { db: { url: process.env.MIGRATION_DATABASE_URL } },
});

let app: FastifyInstance;
let adminHash = "";
const adminPassword = "AdminPass-2026";
const homePassword = "HomePass-2026";

beforeAll(async () => {
  adminHash = await hashPassword(adminPassword);
  app = await buildApp();
});

beforeEach(async () => {
  await owner.$executeRawUnsafe(`
    TRUNCATE TABLE
      idempotency_keys, audit_logs, notifications, payout_item_credits, payout_items, payout_batches,
      ledger_entries, stock_movements, stock_lots, inspections, collection_records, commitment_status_events,
      commitments, menu_items, daily_menus, homemaker_profiles, onboarding_requests, stalls, service_areas,
      sessions, users, platform_settings
    RESTART IDENTITY CASCADE
  `);
  await owner.platformSetting.create({ data: { id: "default" } });
  await owner.user.create({
    data: { role: "ADMIN", phone: "+919811110001", name: "Asha Owner", passwordHash: adminHash },
  });
});

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
  await owner.$disconnect();
});

function futureServiceDate() {
  const service = DateTime.utc().plus({ days: 12 }).startOf("day");
  const monday = service.minus({ days: service.weekday - 1 });
  return { serviceDate: service.toISODate()!, weekStart: monday.toISODate()! };
}

async function login(phone: string, password: string, client: "web" | "mobile" = "web") {
  const response = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { phone, password, client },
  });
  return { status: response.statusCode, body: response.json() as Record<string, unknown> };
}

async function tokenFor(phone: string, password: string) {
  const result = await login(phone, password);
  expect(result.status).toBe(200);
  return (result.body.accessToken as string);
}

test("onboarding does not create an account", async () => {
  const area = await owner.serviceArea.create({ data: { name: "T Nagar", code: "TNG", active: true } });
  const created = await app.inject({
    method: "POST",
    url: "/api/onboarding/requests",
    payload: {
      name: "Meena Krishnan",
      phone: "9800000004",
      addressLine: "12 Demo Street, T Nagar, Chennai",
      serviceAreaId: area.id,
      foodPreparationDetails: "I cook South Indian gravies in a home kitchen.",
      agreementAcknowledged: true,
    },
  });
  expect(created.statusCode).toBe(201);
  const body = created.json() as { referenceCode: string; status: string };
  expect(body.status).toBe("SUBMITTED");
  expect(await owner.user.count({ where: { phone: "+919800000004" } })).toBe(0);
  const status = await app.inject({
    method: "POST",
    url: "/api/onboarding/status",
    payload: { referenceCode: body.referenceCode },
  });
  expect(status.statusCode).toBe(200);
  const blocked = await login("+919800000004", "anything-at-all");
  expect(blocked.status).toBe(401);
});

test("approval issues a one-time password and requires a reset", async () => {
  const area = await owner.serviceArea.create({ data: { name: "T Nagar", code: "TNG", active: true } });
  const submitted = await app.inject({
    method: "POST",
    url: "/api/onboarding/requests",
    payload: {
      name: "Lakshmi Iyer",
      phone: "+919800000002",
      addressLine: "18 Kitchen Lane, T Nagar, Chennai",
      serviceAreaId: area.id,
      foodPreparationDetails: "Home cook for Tamil gravies and dry curries.",
      agreementAcknowledged: true,
    },
  });
  const requestId = (await owner.onboardingRequest.findFirstOrThrow({ where: { phone: "+919800000002" } })).id;
  const admin = await tokenFor("+919811110001", adminPassword);
  const approved = await app.inject({
    method: "POST",
    url: `/api/admin/onboarding/${requestId}/approve`,
    headers: { authorization: `Bearer ${admin}` },
  });
  expect(approved.statusCode).toBe(200);
  const approval = approved.json() as { temporaryPassword: string; phone: string };
  expect(approval.temporaryPassword).toBeTruthy();
  expect(JSON.stringify(approved.json())).not.toContain("$argon2");
  const audits = await owner.auditLog.findMany();
  expect(JSON.stringify(audits)).not.toContain(approval.temporaryPassword);

  const first = await login(approval.phone, approval.temporaryPassword, "mobile");
  expect(first.status).toBe(200);
  const access = first.body.accessToken as string;
  const blocked = await app.inject({
    method: "GET",
    url: "/api/homemaker/menus",
    headers: { authorization: `Bearer ${access}` },
  });
  expect(blocked.statusCode).toBe(403);
  expect((blocked.json() as { error: { code: string } }).error.code).toBe("PASSWORD_CHANGE_REQUIRED");

  const changed = await app.inject({
    method: "POST",
    url: "/api/auth/change-password",
    headers: { authorization: `Bearer ${access}`, "x-client": "mobile" },
    payload: { currentPassword: approval.temporaryPassword, newPassword: homePassword },
  });
  expect(changed.statusCode).toBe(200);
  const menus = await app.inject({
    method: "GET",
    url: "/api/homemaker/menus",
    headers: { authorization: `Bearer ${(changed.json() as { accessToken: string }).accessToken}` },
  });
  expect(menus.statusCode).toBe(200);
  expect(submitted.statusCode).toBe(201);
});

test("limits, area scope, cutoff, and status changes are enforced on the server", async () => {
  const { serviceDate } = futureServiceDate();
  const area = await owner.serviceArea.create({ data: { name: "T Nagar", code: "TNG" } });
  const other = await owner.serviceArea.create({ data: { name: "Adyar", code: "ADY" } });
  const homeHash = await hashPassword(homePassword);
  const homemaker = await owner.user.create({
    data: {
      role: "HOMEMAKER",
      phone: "+919800000002",
      name: "Lakshmi Iyer",
      passwordHash: homeHash,
      profile: {
        create: {
          addressLine: "18 Kitchen Lane, T Nagar",
          serviceAreaId: area.id,
          foodPreparationDetails: "Home kitchen",
          agreementVersion: "cp-agreement-2026-11",
          agreementAcknowledgedAt: new Date(),
        },
      },
    },
  });
  const admin = await tokenFor("+919811110001", adminPassword);
  const draft = await app.inject({
    method: "POST",
    url: "/api/admin/menus",
    headers: { authorization: `Bearer ${admin}` },
    payload: { serviceDate, serviceAreaId: area.id },
  });
  expect(draft.statusCode).toBe(201);
  const menuId = (draft.json() as { id: string }).id;
  const names = ["Kurma", "Sambar", "Poriyal"];
  const itemIds: string[] = [];
  for (const name of names) {
    const item = await app.inject({
      method: "POST",
      url: `/api/admin/menus/${menuId}/items`,
      headers: { authorization: `Bearer ${admin}` },
      payload: {
        name,
        description: `${name} for the curry point`,
        preparationInstructions: "Cook, cool, and pack in a closed vessel.",
        compensationPerKg: "10.00",
      },
    });
    expect(item.statusCode).toBe(201);
    itemIds.push((item.json() as { id: string }).id);
  }
  const published = await app.inject({
    method: "POST",
    url: `/api/admin/menus/${menuId}/publish`,
    headers: { authorization: `Bearer ${admin}` },
    payload: {},
  });
  expect(published.statusCode).toBe(200);

  const otherMenu = await owner.dailyMenu.create({
    data: {
      serviceDate: new Date(`${serviceDate}T00:00:00.000Z`),
      serviceAreaId: other.id,
      status: "PUBLISHED",
      cutoffAt: new Date(Date.now() + 86_400_000),
      createdById: (await owner.user.findFirstOrThrow({ where: { role: "ADMIN" } })).id,
      items: {
        create: {
          name: "Secret curry",
          description: "Not for this area",
          preparationInstructions: "Hidden",
          compensationPerKg: new Prisma.Decimal("10.00"),
        },
      },
    },
    include: { items: true },
  });

  const home = await tokenFor("+919800000002", homePassword);
  const menus = await app.inject({
    method: "GET",
    url: "/api/homemaker/menus",
    headers: { authorization: `Bearer ${home}` },
  });
  expect(menus.statusCode).toBe(200);
  const menuBody = menus.json() as { menus: Array<{ id: string; items: Array<{ name: string }> }> };
  expect(menuBody.menus.map((menu) => menu.id)).toContain(menuId);
  expect(menuBody.menus.map((menu) => menu.id)).not.toContain(otherMenu.id);
  expect(JSON.stringify(menuBody)).not.toContain("Secret curry");

  const hidden = await app.inject({
    method: "GET",
    url: `/api/homemaker/menus/${otherMenu.id}`,
    headers: { authorization: `Bearer ${home}` },
  });
  expect(hidden.statusCode).toBe(404);

  for (const [index, itemId] of itemIds.entries()) {
    const commitment = await app.inject({
      method: "POST",
      url: "/api/homemaker/commitments",
      headers: { authorization: `Bearer ${home}` },
      payload: { menuItemId: itemId, quantityKg: index === 0 ? "1.005" : "1.000" },
    });
    expect(commitment.statusCode, JSON.stringify(commitment.json())).toBe(index < 2 ? 201 : 409);
  }
  const tooMuch = await app.inject({
    method: "POST",
    url: "/api/homemaker/commitments",
    headers: { authorization: `Bearer ${home}` },
    payload: { menuItemId: itemIds[0], quantityKg: "2.500" },
  });
  expect(tooMuch.statusCode).toBe(409);

  const closed = await owner.dailyMenu.create({
    data: {
      serviceDate: new Date(Date.UTC(2030, 0, 1)),
      serviceAreaId: area.id,
      status: "PUBLISHED",
      cutoffAt: new Date(Date.now() - 60_000),
      createdById: homemaker.id,
      items: {
        create: {
          name: "Late curry",
          description: "Cutoff passed",
          preparationInstructions: "Too late",
          compensationPerKg: new Prisma.Decimal("10.00"),
        },
      },
    },
    include: { items: true },
  });
  const late = await app.inject({
    method: "POST",
    url: "/api/homemaker/commitments",
    headers: { authorization: `Bearer ${home}` },
    payload: { menuItemId: closed.items[0]!.id, quantityKg: "1.000" },
  });
  expect(late.statusCode).toBe(409);

  const mine = await app.inject({
    method: "GET",
    url: "/api/homemaker/commitments",
    headers: { authorization: `Bearer ${home}` },
  });
  const commitmentId = (mine.json() as { commitments: Array<{ id: string }> }).commitments[0]!.id;
  const illegal = await app.inject({
    method: "POST",
    url: `/api/homemaker/commitments/${commitmentId}/status`,
    headers: { authorization: `Bearer ${home}` },
    payload: { status: "COLLECTED" },
  });
  expect(illegal.statusCode).toBe(400);
  const ready = await app.inject({
    method: "POST",
    url: `/api/homemaker/commitments/${commitmentId}/status`,
    headers: { authorization: `Bearer ${home}` },
    payload: { status: "PREPARING" },
  });
  expect(ready.statusCode).toBe(200);
});

test("inspection credits only accepted quantity and stock cannot be oversold", async () => {
  const { serviceDate, weekStart } = futureServiceDate();
  const area = await owner.serviceArea.create({ data: { name: "T Nagar", code: "TNG" } });
  const stall = await owner.stall.create({
    data: { name: "T Nagar Point", serviceAreaId: area.id, addressLine: "Curry point, T Nagar" },
  });
  const homeHash = await hashPassword(homePassword);
  await owner.user.create({
    data: {
      role: "HOMEMAKER",
      phone: "+919800000002",
      name: "Lakshmi Iyer",
      passwordHash: homeHash,
      profile: {
        create: {
          addressLine: "18 Kitchen Lane, T Nagar",
          serviceAreaId: area.id,
          foodPreparationDetails: "Home kitchen",
          agreementVersion: "cp-agreement-2026-11",
          agreementAcknowledgedAt: new Date(),
        },
      },
    },
  });
  const admin = await tokenFor("+919811110001", adminPassword);
  const menu = await app.inject({
    method: "POST",
    url: "/api/admin/menus",
    headers: { authorization: `Bearer ${admin}` },
    payload: { serviceDate, serviceAreaId: area.id },
  });
  const menuId = (menu.json() as { id: string }).id;
  const item = await app.inject({
    method: "POST",
    url: `/api/admin/menus/${menuId}/items`,
    headers: { authorization: `Bearer ${admin}` },
    payload: {
      name: "Pepper chicken",
      description: "Home-style pepper chicken",
      preparationInstructions: "Rest the gravy before packing.",
      compensationPerKg: "10.00",
    },
  });
  const itemId = (item.json() as { id: string }).id;
  expect((await app.inject({
    method: "POST",
    url: `/api/admin/menus/${menuId}/publish`,
    headers: { authorization: `Bearer ${admin}` },
    payload: {},
  })).statusCode).toBe(200);

  const home = await tokenFor("+919800000002", homePassword);
  const committed = await app.inject({
    method: "POST",
    url: "/api/homemaker/commitments",
    headers: { authorization: `Bearer ${home}` },
    payload: { menuItemId: itemId, quantityKg: "1.005" },
  });
  const commitmentId = (committed.json() as { id: string }).id;
  expect((await app.inject({
    method: "POST",
    url: `/api/homemaker/commitments/${commitmentId}/status`,
    headers: { authorization: `Bearer ${home}` },
    payload: { status: "PREPARING" },
  })).statusCode).toBe(200);
  expect((await app.inject({
    method: "POST",
    url: `/api/homemaker/commitments/${commitmentId}/status`,
    headers: { authorization: `Bearer ${home}` },
    payload: { status: "READY_FOR_COLLECTION" },
  })).statusCode).toBe(200);
  expect((await app.inject({
    method: "POST",
    url: `/api/admin/commitments/${commitmentId}/collection`,
    headers: { authorization: `Bearer ${admin}` },
    payload: { status: "COLLECTED", collectedAt: new Date().toISOString(), staffName: "Ravi", notes: "Picked up on time" },
  })).statusCode).toBe(200);

  const failed = await app.inject({
    method: "POST",
    url: `/api/admin/commitments/${commitmentId}/inspections`,
    headers: { authorization: `Bearer ${admin}` },
    payload: {
      weightKg: "1.005",
      acceptedQuantityKg: "0",
      waterContent: "HIGH",
      freshness: "ACCEPTABLE",
      hygiene: "FAIL",
      result: "FAILED",
      notes: "Vessel was open",
    },
  });
  expect(failed.statusCode).toBe(201);
  const emptyWallet = await app.inject({ method: "GET", url: "/api/homemaker/wallet", headers: { authorization: `Bearer ${home}` } });
  expect((emptyWallet.json() as { unpaidAmount: string }).unpaidAmount).toBe("0.00");

  const inspectionId = (await owner.inspection.findFirstOrThrow()).id;
  const resolved = await app.inject({
    method: "POST",
    url: `/api/admin/inspections/${inspectionId}/resolve`,
    headers: { authorization: `Bearer ${admin}` },
    payload: { outcome: "accepted", acceptedQuantityKg: "1.005", reason: "Reweighed after a clean repack." },
  });
  expect(resolved.statusCode).toBe(200);
  const wallet = await app.inject({ method: "GET", url: "/api/homemaker/wallet", headers: { authorization: `Bearer ${home}` } });
  const walletBody = wallet.json() as { unpaidAmount: string; entries: Array<{ amount: string; acceptedQuantityKg: string; ratePerKg: string }> };
  expect(walletBody.unpaidAmount).toBe("10.05");
  expect(walletBody.entries[0]?.amount).toBe("10.05");

  const foreign = await app.inject({ method: "GET", url: "/api/admin/payouts", headers: { authorization: `Bearer ${home}` } });
  expect(foreign.statusCode).toBe(403);

  const lotId = (await owner.stockLot.findFirstOrThrow()).id;
  const allocate = await app.inject({
    method: "POST",
    url: "/api/admin/stock/movements",
    headers: { authorization: `Bearer ${admin}`, "idempotency-key": "allocate-pepper-001" },
    payload: { lotId, type: "ALLOCATION", quantityKg: "1.005", reason: "Send to the T Nagar point", stallId: stall.id },
  });
  expect(allocate.statusCode).toBe(201);
  const oversell = await app.inject({
    method: "POST",
    url: "/api/admin/stock/movements",
    headers: { authorization: `Bearer ${admin}`, "idempotency-key": "sale-too-much-001" },
    payload: { lotId, type: "SALE", quantityKg: "2.000", reason: "Dinner rush", stallId: stall.id },
  });
  expect(oversell.statusCode).toBe(409);
  const vague = await app.inject({
    method: "POST",
    url: "/api/admin/stock/movements",
    headers: { authorization: `Bearer ${admin}`, "idempotency-key": "adjust-vague-001" },
    payload: { lotId, type: "ADJUSTMENT", quantityKg: "-0.100", reason: "short", stallId: stall.id },
  });
  expect(vague.statusCode).toBe(400);
  const sale = await app.inject({
    method: "POST",
    url: "/api/admin/stock/movements",
    headers: { authorization: `Bearer ${admin}`, "idempotency-key": "sale-pepper-001" },
    payload: { lotId, type: "SALE", quantityKg: "0.500", reason: "Dinner service", stallId: stall.id },
  });
  expect(sale.statusCode).toBe(201);
  const replay = await app.inject({
    method: "POST",
    url: "/api/admin/stock/movements",
    headers: { authorization: `Bearer ${admin}`, "idempotency-key": "sale-pepper-001" },
    payload: { lotId, type: "SALE", quantityKg: "0.500", reason: "Dinner service", stallId: stall.id },
  });
  expect(replay.statusCode).toBe(200);
  expect(replay.json()).toEqual(sale.json());
  const lot = await owner.stockLot.findFirstOrThrow();
  expect(lot.soldKg.toFixed(3)).toBe("0.500");

  const batch = await app.inject({
    method: "POST",
    url: "/api/admin/payouts/batches",
    headers: { authorization: `Bearer ${admin}`, "idempotency-key": "week-batch-0001" },
    payload: { weekStart },
  });
  expect(batch.statusCode, JSON.stringify(batch.json())).toBe(201);
  const batchId = (batch.json() as { id: string }).id;
  expect((await app.inject({
    method: "POST",
    url: `/api/admin/payouts/batches/${batchId}/approve`,
    headers: { authorization: `Bearer ${admin}` },
  })).statusCode).toBe(200);
  const paid = await app.inject({
    method: "POST",
    url: `/api/admin/payouts/batches/${batchId}/mark-paid`,
    headers: { authorization: `Bearer ${admin}`, "idempotency-key": "week-paid-0001" },
    payload: { reference: "DEMO-UTR-1001" },
  });
  expect(paid.statusCode).toBe(200);
  const paidAgain = await app.inject({
    method: "POST",
    url: `/api/admin/payouts/batches/${batchId}/mark-paid`,
    headers: { authorization: `Bearer ${admin}`, "idempotency-key": "week-paid-0001" },
    payload: { reference: "DEMO-UTR-1001" },
  });
  expect(paidAgain.json()).toEqual(paid.json());
  expect(await owner.ledgerEntry.count({ where: { type: "PAYOUT" } })).toBe(1);
  const afterPay = await app.inject({ method: "GET", url: "/api/homemaker/wallet", headers: { authorization: `Bearer ${home}` } });
  expect((afterPay.json() as { unpaidAmount: string }).unpaidAmount).toBe("0.00");

  const hiddenLedger = await prisma.$transaction(async (tx) => tx.ledgerEntry.findMany());
  expect(hiddenLedger).toHaveLength(0);
  const ownLedger = await prisma.$transaction(async (tx) => {
    const profile = await owner.homemakerProfile.findFirstOrThrow();
    await setActor(tx, { userId: profile.userId, role: "HOMEMAKER" });
    return tx.ledgerEntry.findMany();
  });
  expect(ownLedger.length).toBeGreaterThan(0);
  expect(ownLedger.every((entry) => entry.homemakerProfileId === ownLedger[0]!.homemakerProfileId)).toBe(true);
});

test("a passed inspection can be disputed and is not payable until resolved", async () => {
  const { serviceDate, weekStart } = futureServiceDate();
  const area = await owner.serviceArea.create({ data: { name: "T Nagar", code: "TNG" } });
  const homeHash = await hashPassword(homePassword);
  await owner.user.create({
    data: {
      role: "HOMEMAKER",
      phone: "+919800000002",
      name: "Lakshmi Iyer",
      passwordHash: homeHash,
      profile: {
        create: {
          addressLine: "18 Kitchen Lane, T Nagar",
          serviceAreaId: area.id,
          foodPreparationDetails: "Home kitchen",
          agreementVersion: "cp-agreement-2026-11",
          agreementAcknowledgedAt: new Date(),
        },
      },
    },
  });
  const admin = await tokenFor("+919811110001", adminPassword);
  const menu = await app.inject({
    method: "POST",
    url: "/api/admin/menus",
    headers: { authorization: `Bearer ${admin}` },
    payload: { serviceDate, serviceAreaId: area.id },
  });
  const menuId = (menu.json() as { id: string }).id;
  const item = await app.inject({
    method: "POST",
    url: `/api/admin/menus/${menuId}/items`,
    headers: { authorization: `Bearer ${admin}` },
    payload: {
      name: "Beans poriyal",
      description: "Dry beans",
      preparationInstructions: "Keep it dry.",
      compensationPerKg: "20.00",
    },
  });
  await app.inject({
    method: "POST",
    url: `/api/admin/menus/${menuId}/publish`,
    headers: { authorization: `Bearer ${admin}` },
    payload: {},
  });
  const home = await tokenFor("+919800000002", homePassword);
  const commitment = await app.inject({
    method: "POST",
    url: "/api/homemaker/commitments",
    headers: { authorization: `Bearer ${home}` },
    payload: { menuItemId: (item.json() as { id: string }).id, quantityKg: "1.000" },
  });
  const commitmentId = (commitment.json() as { id: string }).id;
  await app.inject({
    method: "POST",
    url: `/api/homemaker/commitments/${commitmentId}/status`,
    headers: { authorization: `Bearer ${home}` },
    payload: { status: "PREPARING" },
  });
  await app.inject({
    method: "POST",
    url: `/api/homemaker/commitments/${commitmentId}/status`,
    headers: { authorization: `Bearer ${home}` },
    payload: { status: "READY_FOR_COLLECTION" },
  });
  await app.inject({
    method: "POST",
    url: `/api/admin/commitments/${commitmentId}/collection`,
    headers: { authorization: `Bearer ${admin}` },
    payload: { status: "COLLECTED", collectedAt: new Date().toISOString(), staffName: "Ravi" },
  });
  const passed = await app.inject({
    method: "POST",
    url: `/api/admin/commitments/${commitmentId}/inspections`,
    headers: { authorization: `Bearer ${admin}` },
    payload: {
      weightKg: "1.000",
      acceptedQuantityKg: "1.000",
      waterContent: "NORMAL",
      freshness: "GOOD",
      hygiene: "PASS",
      result: "PASSED",
    },
  });
  expect(passed.statusCode).toBe(201);
  const inspectionId = (passed.json() as { id: string }).id;
  const dispute = await app.inject({
    method: "POST",
    url: `/api/homemaker/inspections/${inspectionId}/dispute`,
    headers: { authorization: `Bearer ${home}` },
    payload: { reason: "The accepted weight looks short." },
  });
  expect(dispute.statusCode).toBe(200);
  const batch = await app.inject({
    method: "POST",
    url: "/api/admin/payouts/batches",
    headers: { authorization: `Bearer ${admin}`, "idempotency-key": "dispute-week-0001" },
    payload: { weekStart },
  });
  expect(batch.statusCode).toBe(409);
  const wallet = await app.inject({ method: "GET", url: "/api/homemaker/wallet", headers: { authorization: `Bearer ${home}` } });
  expect((wallet.json() as { unpaidAmount: string }).unpaidAmount).toBe("0.00");
  expect((wallet.json() as { entries: Array<{ status: string }> }).entries.some((entry) => entry.status === "disputed")).toBe(true);
});

test("publishing after the deadline needs an override reason", async () => {
  const area = await owner.serviceArea.create({ data: { name: "T Nagar", code: "TNG" } });
  const admin = await tokenFor("+919811110001", adminPassword);
  const yesterday = DateTime.utc().minus({ days: 1 }).toISODate()!;
  const menu = await app.inject({
    method: "POST",
    url: "/api/admin/menus",
    headers: { authorization: `Bearer ${admin}` },
    payload: { serviceDate: yesterday, serviceAreaId: area.id },
  });
  const menuId = (menu.json() as { id: string }).id;
  await app.inject({
    method: "POST",
    url: `/api/admin/menus/${menuId}/items`,
    headers: { authorization: `Bearer ${admin}` },
    payload: {
      name: "Rasam",
      description: "Pepper rasam",
      preparationInstructions: "Temper at the end.",
      compensationPerKg: "80.00",
    },
  });
  const blocked = await app.inject({
    method: "POST",
    url: `/api/admin/menus/${menuId}/publish`,
    headers: { authorization: `Bearer ${admin}` },
    payload: {},
  });
  expect(blocked.statusCode).toBe(409);
  const forced = await app.inject({
    method: "POST",
    url: `/api/admin/menus/${menuId}/publish`,
    headers: { authorization: `Bearer ${admin}` },
    payload: { overrideReason: "Stall still needs this service." },
  });
  expect(forced.statusCode).toBe(200);
});
