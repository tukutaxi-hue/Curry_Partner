import "dotenv/config";
import { Prisma, PrismaClient } from "@prisma/client";
import { DateTime } from "luxon";
import { hashPassword } from "../src/auth/passwords.js";
import { creditAmount } from "../src/money.js";

if (process.env.NODE_ENV === "production" && process.env.ALLOW_DEMO_SEED !== "true") {
  console.error("Refusing to seed while NODE_ENV=production. Set ALLOW_DEMO_SEED=true only for a labeled demo.");
  process.exit(1);
}

process.env.DATABASE_URL = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL;
const prisma = new PrismaClient();

const adminPhone = process.env.SEED_ADMIN_PHONE ?? "+919800000001";
const adminPassword = process.env.SEED_ADMIN_PASSWORD ?? "DemoAdmin-2026";
const homePhone = process.env.SEED_HOMEMAKER_PHONE ?? "+919800000002";
const homePassword = process.env.SEED_HOMEMAKER_PASSWORD ?? "DemoHome-2026";
const invitedPhone = process.env.SEED_INVITED_PHONE ?? "+919800000003";
const invitedPassword = process.env.SEED_INVITED_PASSWORD ?? "DemoTemp-2026";

function dateOnly(day: DateTime): Date {
  return new Date(`${day.toISODate()}T00:00:00.000Z`);
}

async function main() {
  const existing = await prisma.user.findUnique({ where: { phone: adminPhone } });
  if (existing) {
    console.log("Demo seed already present. Skipping.");
    return;
  }

  const zone = "Asia/Kolkata";
  const today = DateTime.now().setZone(zone).startOf("day");
  const tomorrow = today.plus({ days: 1 });
  const yesterday = today.minus({ days: 1 });
  const dayAfter = today.plus({ days: 2 });
  const adminHash = await hashPassword(adminPassword);
  const homeHash = await hashPassword(homePassword);
  const invitedHash = await hashPassword(invitedPassword);

  const admin = await prisma.user.create({
    data: { role: "ADMIN", phone: adminPhone, name: "DEMO Asha Menon", passwordHash: adminHash, isDemo: true },
  });
  await prisma.platformSetting.upsert({
    where: { id: "default" },
    update: {},
    create: { id: "default" },
  });

  const tnagar = await prisma.serviceArea.create({
    data: { name: "DEMO T. Nagar", code: "DEMO-TNG", isDemo: true },
  });
  const adyar = await prisma.serviceArea.create({
    data: { name: "DEMO Adyar", code: "DEMO-ADY", isDemo: true },
  });
  const stall = await prisma.stall.create({
    data: {
      name: "DEMO T. Nagar Curry Point",
      serviceAreaId: tnagar.id,
      addressLine: "DEMO 14 Usman Road, T. Nagar, Chennai",
      isDemo: true,
    },
  });
  await prisma.stall.create({
    data: {
      name: "DEMO Adyar Curry Point",
      serviceAreaId: adyar.id,
      addressLine: "DEMO 8 LB Road, Adyar, Chennai",
      isDemo: true,
    },
  });

  const lakshmi = await prisma.user.create({
    data: {
      role: "HOMEMAKER",
      phone: homePhone,
      name: "DEMO Lakshmi Iyer",
      passwordHash: homeHash,
      isDemo: true,
      profile: {
        create: {
          addressLine: "DEMO 18 Ranganathan Street, T. Nagar, Chennai",
          serviceAreaId: tnagar.id,
          foodPreparationDetails: "DEMO home kitchen. Tamil gravies, sambar, and dry curries. Weekday evenings.",
          agreementVersion: "cp-agreement-2026-11",
          agreementAcknowledgedAt: new Date(),
        },
      },
    },
    include: { profile: true },
  });
  await prisma.user.create({
    data: {
      role: "HOMEMAKER",
      phone: invitedPhone,
      name: "DEMO Fatima Shah",
      passwordHash: invitedHash,
      mustChangePassword: true,
      isDemo: true,
      profile: {
        create: {
          addressLine: "DEMO 6 Bazullah Road, T. Nagar, Chennai",
          serviceAreaId: tnagar.id,
          foodPreparationDetails: "DEMO home kitchen. Chicken and vegetable curries.",
          agreementVersion: "cp-agreement-2026-11",
          agreementAcknowledgedAt: new Date(),
        },
      },
    },
  });
  await prisma.onboardingRequest.create({
    data: {
      referenceCode: "CP-DEMO0001",
      name: "DEMO Meena Krishnan",
      phone: "+919800000004",
      addressLine: "DEMO 21 North Usman Road, T. Nagar, Chennai",
      serviceAreaId: tnagar.id,
      foodPreparationDetails: "DEMO I cook sambar, rasam, and poriyal for my family and can take two curries a day.",
      agreementAcknowledged: true,
      agreementVersion: "cp-agreement-2026-11",
      status: "SUBMITTED",
      isDemo: true,
    },
  });

  const profileId = lakshmi.profile!.id;
  const chickenRate = new Prisma.Decimal("180.00");
  const accepted = new Prisma.Decimal("1.400");
  const yesterdayMenu = await prisma.dailyMenu.create({
    data: {
      serviceDate: dateOnly(yesterday),
      serviceAreaId: tnagar.id,
      status: "PUBLISHED",
      publishedAt: yesterday.minus({ days: 1 }).toJSDate(),
      cutoffAt: yesterday.minus({ hours: 3 }).toJSDate(),
      createdById: admin.id,
      isDemo: true,
      notes: "DEMO fixture for yesterday's service.",
      items: {
        create: [
          {
            name: "DEMO Chettinad chicken",
            description: "DEMO pepper chicken gravy.",
            preparationInstructions: "DEMO cook, rest 20 minutes, pack in a closed vessel.",
            compensationPerKg: chickenRate,
            sortOrder: 1,
          },
          {
            name: "DEMO Sambar",
            description: "DEMO mixed vegetable sambar.",
            preparationInstructions: "DEMO keep the tempering fresh and the vessel covered.",
            compensationPerKg: new Prisma.Decimal("90.00"),
            sortOrder: 2,
          },
        ],
      },
    },
    include: { items: true },
  });
  const chicken = yesterdayMenu.items.find((item) => item.name.includes("chicken"))!;
  const sambar = yesterdayMenu.items.find((item) => item.name.includes("Sambar"))!;
  const chickenCommitment = await prisma.commitment.create({
    data: {
      homemakerProfileId: profileId,
      menuItemId: chicken.id,
      serviceDate: dateOnly(yesterday),
      requestedQuantityKg: new Prisma.Decimal("1.500"),
      itemName: chicken.name,
      ratePerKg: chickenRate,
      preparationInstructions: chicken.preparationInstructions,
      status: "COMPLETED",
      events: { create: [{ toStatus: "COMMITTED", actorId: lakshmi.id, note: "DEMO seed" }, { fromStatus: "COMMITTED", toStatus: "COMPLETED", actorId: admin.id, note: "DEMO inspection accepted" }] },
      collection: { create: { status: "COLLECTED", collectedAt: yesterday.set({ hour: 10 }).toJSDate(), staffName: "DEMO Ravi", notes: "DEMO picked up from the ground floor." } },
    },
  });
  const chickenInspection = await prisma.inspection.create({
    data: {
      commitmentId: chickenCommitment.id,
      weightKg: new Prisma.Decimal("1.450"),
      waterContent: "NORMAL",
      freshness: "GOOD",
      hygiene: "PASS",
      notes: "DEMO accepted after a small weight difference.",
      acceptedQuantityKg: accepted,
      resolvedQuantityKg: accepted,
      result: "PASSED",
      createdById: admin.id,
    },
  });
  await prisma.ledgerEntry.create({
    data: {
      entryKey: `credit:${chickenInspection.id}`,
      homemakerProfileId: profileId,
      commitmentId: chickenCommitment.id,
      inspectionId: chickenInspection.id,
      type: "CREDIT",
      itemName: chicken.name,
      serviceDate: dateOnly(yesterday),
      acceptedQuantityKg: accepted,
      ratePerKg: chickenRate,
      amount: creditAmount(accepted, chickenRate),
      note: "DEMO accepted at inspection",
    },
  });
  const lot = await prisma.stockLot.create({
    data: {
      commitmentId: chickenCommitment.id,
      inspectionId: chickenInspection.id,
      menuItemId: chicken.id,
      serviceAreaId: tnagar.id,
      stallId: stall.id,
      acceptedKg: accepted,
      soldKg: new Prisma.Decimal("0.400"),
    },
  });
  await prisma.stockMovement.createMany({
    data: [
      { lotId: lot.id, stallId: stall.id, type: "ALLOCATION", quantityKg: accepted, reason: "DEMO assigned to the T. Nagar point", actorId: admin.id },
      { lotId: lot.id, stallId: stall.id, type: "SALE", quantityKg: new Prisma.Decimal("0.400"), reason: "DEMO dinner service", actorId: admin.id },
    ],
  });
  const sambarCommitment = await prisma.commitment.create({
    data: {
      homemakerProfileId: profileId,
      menuItemId: sambar.id,
      serviceDate: dateOnly(yesterday),
      requestedQuantityKg: new Prisma.Decimal("1.000"),
      itemName: sambar.name,
      ratePerKg: new Prisma.Decimal("90.00"),
      preparationInstructions: sambar.preparationInstructions,
      status: "COLLECTED",
      collection: { create: { status: "COLLECTED", collectedAt: yesterday.set({ hour: 10, minute: 20 }).toJSDate(), staffName: "DEMO Ravi", notes: "DEMO collected with the chicken." } },
    },
  });
  await prisma.inspection.create({
    data: {
      commitmentId: sambarCommitment.id,
      weightKg: new Prisma.Decimal("1.000"),
      waterContent: "HIGH",
      freshness: "ACCEPTABLE",
      hygiene: "FAIL",
      notes: "DEMO vessel lid was loose. Waiting for a decision.",
      acceptedQuantityKg: new Prisma.Decimal("0"),
      result: "FAILED",
      createdById: admin.id,
    },
  });

  const tomorrowMenu = await prisma.dailyMenu.create({
    data: {
      serviceDate: dateOnly(tomorrow),
      serviceAreaId: tnagar.id,
      status: "PUBLISHED",
      publishedAt: new Date(),
      cutoffAt: DateTime.now().plus({ hours: 36 }).toJSDate(),
      createdById: admin.id,
      isDemo: true,
      notes: "DEMO cutoff is extended so this menu stays open for review.",
      items: {
        create: [
          {
            name: "DEMO Vegetable kurma",
            description: "DEMO coconut kurma for the evening stall.",
            preparationInstructions: "DEMO grind coconut fresh, simmer, and cool before packing.",
            compensationPerKg: new Prisma.Decimal("160.00"),
            sortOrder: 1,
          },
          {
            name: "DEMO Beans poriyal",
            description: "DEMO dry beans with coconut.",
            preparationInstructions: "DEMO keep it dry and uncovered only while cooling.",
            compensationPerKg: new Prisma.Decimal("140.00"),
            sortOrder: 2,
          },
          {
            name: "DEMO Egg curry",
            description: "DEMO onion tomato egg curry.",
            preparationInstructions: "DEMO boil eggs separately and add them at the end.",
            compensationPerKg: new Prisma.Decimal("170.00"),
            sortOrder: 3,
          },
        ],
      },
    },
    include: { items: true },
  });
  const kurma = tomorrowMenu.items.find((item) => item.name.includes("kurma"))!;
  await prisma.commitment.create({
    data: {
      homemakerProfileId: profileId,
      menuItemId: kurma.id,
      serviceDate: dateOnly(tomorrow),
      requestedQuantityKg: new Prisma.Decimal("2.000"),
      itemName: kurma.name,
      ratePerKg: kurma.compensationPerKg,
      preparationInstructions: kurma.preparationInstructions,
      status: "COMMITTED",
      events: { create: { toStatus: "COMMITTED", actorId: lakshmi.id, note: "DEMO seed" } },
    },
  });
  await prisma.dailyMenu.create({
    data: {
      serviceDate: dateOnly(dayAfter),
      serviceAreaId: tnagar.id,
      status: "DRAFT",
      cutoffAt: dayAfter.minus({ days: 1 }).set({ hour: 21 }).toJSDate(),
      createdById: admin.id,
      isDemo: true,
      notes: "DEMO draft. Publish it from the dashboard.",
      items: {
        create: {
          name: "DEMO Pumpkin kootu",
          description: "DEMO lentil and pumpkin.",
          preparationInstructions: "DEMO cook the dal soft and finish with coconut paste.",
          compensationPerKg: new Prisma.Decimal("130.00"),
        },
      },
    },
  });
  await prisma.notification.createMany({
    data: [
      {
        userId: lakshmi.id,
        type: "menu.published",
        title: "Tomorrow's menu is open",
        body: "DEMO T. Nagar menu is published. One curry is already committed.",
        dedupeKey: `seed:menu:${tomorrowMenu.id}`,
      },
      {
        userId: lakshmi.id,
        type: "wallet.credit",
        title: "Wallet credited",
        body: "DEMO Chettinad chicken: 1.400 kg accepted, ₹252.00.",
        dedupeKey: `seed:credit:${chickenInspection.id}`,
      },
      {
        userId: admin.id,
        type: "inspection.review",
        title: "Inspection needs a decision",
        body: "DEMO Sambar was recorded as failed.",
        dedupeKey: "seed:sambar-review",
      },
    ],
  });
  await prisma.auditLog.create({
    data: {
      actorId: admin.id,
      action: "seed.demo",
      entityType: "platform",
      entityId: "demo",
      metadata: { note: "Demo fixtures. Not production records." },
    },
  });

  console.log("Seeded DEMO fixtures. Passwords are in the README and are not for production.");
  console.log(`Admin ${adminPhone}`);
  console.log(`Homemaker ${homePhone}`);
  console.log(`First-login homemaker ${invitedPhone}`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
