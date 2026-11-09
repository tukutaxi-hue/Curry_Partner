-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "user_role" AS ENUM ('ADMIN', 'HOMEMAKER');

-- CreateEnum
CREATE TYPE "account_status" AS ENUM ('ACTIVE', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "onboarding_status" AS ENUM ('SUBMITTED', 'MORE_INFO', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "menu_status" AS ENUM ('DRAFT', 'PUBLISHED', 'CLOSED');

-- CreateEnum
CREATE TYPE "commitment_status" AS ENUM ('COMMITTED', 'PREPARING', 'READY_FOR_COLLECTION', 'COLLECTED', 'REJECTED', 'COMPLETED');

-- CreateEnum
CREATE TYPE "collection_status" AS ENUM ('SCHEDULED', 'COLLECTED', 'MISSED');

-- CreateEnum
CREATE TYPE "water_content" AS ENUM ('LOW', 'NORMAL', 'HIGH');

-- CreateEnum
CREATE TYPE "freshness" AS ENUM ('GOOD', 'ACCEPTABLE', 'POOR');

-- CreateEnum
CREATE TYPE "hygiene" AS ENUM ('PASS', 'FAIL');

-- CreateEnum
CREATE TYPE "inspection_result" AS ENUM ('PASSED', 'FAILED', 'DISPUTED', 'RESOLVED_ACCEPTED', 'RESOLVED_REJECTED');

-- CreateEnum
CREATE TYPE "stock_movement_type" AS ENUM ('ALLOCATION', 'SALE', 'WASTE', 'RETURN', 'ADJUSTMENT');

-- CreateEnum
CREATE TYPE "ledger_type" AS ENUM ('CREDIT', 'REVERSAL', 'PAYOUT');

-- CreateEnum
CREATE TYPE "payout_batch_status" AS ENUM ('DRAFT', 'APPROVED', 'PAID', 'FAILED');

-- CreateEnum
CREATE TYPE "payout_item_status" AS ENUM ('PENDING', 'APPROVED', 'PAID', 'FAILED', 'REVERSED');

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "role" "user_role" NOT NULL,
    "phone" TEXT NOT NULL,
    "email" TEXT,
    "name" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "must_change_password" BOOLEAN NOT NULL DEFAULT false,
    "account_status" "account_status" NOT NULL DEFAULT 'ACTIVE',
    "token_version" INTEGER NOT NULL DEFAULT 0,
    "is_demo" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "refresh_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "revoked_at" TIMESTAMP(3),
    "user_agent" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "service_areas" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "is_demo" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "service_areas_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stalls" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "service_area_id" TEXT NOT NULL,
    "address_line" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "is_demo" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "stalls_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "onboarding_requests" (
    "id" TEXT NOT NULL,
    "reference_code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "address_line" TEXT NOT NULL,
    "service_area_id" TEXT NOT NULL,
    "food_preparation_details" TEXT NOT NULL,
    "agreement_acknowledged" BOOLEAN NOT NULL,
    "agreement_version" TEXT NOT NULL,
    "status" "onboarding_status" NOT NULL DEFAULT 'SUBMITTED',
    "admin_notes" TEXT,
    "reviewed_by_id" TEXT,
    "reviewed_at" TIMESTAMP(3),
    "created_user_id" TEXT,
    "is_demo" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "onboarding_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "homemaker_profiles" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "address_line" TEXT NOT NULL,
    "service_area_id" TEXT NOT NULL,
    "food_preparation_details" TEXT NOT NULL,
    "agreement_version" TEXT NOT NULL,
    "agreement_acknowledged_at" TIMESTAMP(3) NOT NULL,
    "onboarding_request_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "homemaker_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_settings" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "max_curries_per_homemaker_per_day" INTEGER NOT NULL DEFAULT 2,
    "max_kg_per_curry" DECIMAL(10,3) NOT NULL DEFAULT 2,
    "menu_publish_cutoff_local" TEXT NOT NULL DEFAULT '17:00',
    "commitment_cutoff_local" TEXT NOT NULL DEFAULT '21:00',
    "timezone" TEXT NOT NULL DEFAULT 'Asia/Kolkata',
    "agreement_version" TEXT NOT NULL DEFAULT 'cp-agreement-2026-11',
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "platform_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "daily_menus" (
    "id" TEXT NOT NULL,
    "service_date" DATE NOT NULL,
    "service_area_id" TEXT NOT NULL,
    "status" "menu_status" NOT NULL DEFAULT 'DRAFT',
    "published_at" TIMESTAMP(3),
    "cutoff_at" TIMESTAMP(3) NOT NULL,
    "notes" TEXT,
    "created_by_id" TEXT NOT NULL,
    "is_demo" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "daily_menus_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "menu_items" (
    "id" TEXT NOT NULL,
    "menu_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "preparation_instructions" TEXT NOT NULL,
    "compensation_per_kg" DECIMAL(12,2) NOT NULL,
    "max_kg_per_homemaker" DECIMAL(10,3),
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "menu_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "commitments" (
    "id" TEXT NOT NULL,
    "homemaker_profile_id" TEXT NOT NULL,
    "menu_item_id" TEXT NOT NULL,
    "service_date" DATE NOT NULL,
    "requested_quantity_kg" DECIMAL(10,3) NOT NULL,
    "item_name" TEXT NOT NULL,
    "rate_per_kg" DECIMAL(12,2) NOT NULL,
    "preparation_instructions" TEXT NOT NULL,
    "status" "commitment_status" NOT NULL DEFAULT 'COMMITTED',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "commitments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "commitment_status_events" (
    "id" TEXT NOT NULL,
    "commitment_id" TEXT NOT NULL,
    "from_status" "commitment_status",
    "to_status" "commitment_status" NOT NULL,
    "actor_id" TEXT,
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "commitment_status_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "collection_records" (
    "id" TEXT NOT NULL,
    "commitment_id" TEXT NOT NULL,
    "status" "collection_status" NOT NULL DEFAULT 'SCHEDULED',
    "collected_at" TIMESTAMP(3),
    "staff_name" TEXT,
    "notes" TEXT,
    "updated_by_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "collection_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inspections" (
    "id" TEXT NOT NULL,
    "commitment_id" TEXT NOT NULL,
    "weight_kg" DECIMAL(10,3) NOT NULL,
    "water_content" "water_content" NOT NULL,
    "freshness" "freshness" NOT NULL,
    "hygiene" "hygiene" NOT NULL,
    "notes" TEXT,
    "photo_url" TEXT,
    "accepted_quantity_kg" DECIMAL(10,3) NOT NULL,
    "result" "inspection_result" NOT NULL,
    "resolution_reason" TEXT,
    "resolved_quantity_kg" DECIMAL(10,3),
    "resolved_at" TIMESTAMP(3),
    "resolved_by_id" TEXT,
    "created_by_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inspections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_lots" (
    "id" TEXT NOT NULL,
    "commitment_id" TEXT NOT NULL,
    "inspection_id" TEXT NOT NULL,
    "menu_item_id" TEXT NOT NULL,
    "service_area_id" TEXT NOT NULL,
    "stall_id" TEXT,
    "accepted_kg" DECIMAL(10,3) NOT NULL,
    "sold_kg" DECIMAL(10,3) NOT NULL DEFAULT 0,
    "waste_kg" DECIMAL(10,3) NOT NULL DEFAULT 0,
    "returned_kg" DECIMAL(10,3) NOT NULL DEFAULT 0,
    "adjustment_kg" DECIMAL(10,3) NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "stock_lots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_movements" (
    "id" TEXT NOT NULL,
    "lot_id" TEXT NOT NULL,
    "stall_id" TEXT,
    "type" "stock_movement_type" NOT NULL,
    "quantity_kg" DECIMAL(10,3) NOT NULL,
    "reason" TEXT NOT NULL,
    "actor_id" TEXT NOT NULL,
    "idempotency_key" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stock_movements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ledger_entries" (
    "id" TEXT NOT NULL,
    "entry_key" TEXT NOT NULL,
    "homemaker_profile_id" TEXT NOT NULL,
    "commitment_id" TEXT,
    "inspection_id" TEXT,
    "reverses_entry_id" TEXT,
    "settles_entry_id" TEXT,
    "type" "ledger_type" NOT NULL,
    "item_name" TEXT NOT NULL,
    "service_date" DATE NOT NULL,
    "accepted_quantity_kg" DECIMAL(10,3) NOT NULL,
    "rate_per_kg" DECIMAL(12,2) NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ledger_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payout_batches" (
    "id" TEXT NOT NULL,
    "week_start" DATE NOT NULL,
    "week_end" DATE NOT NULL,
    "status" "payout_batch_status" NOT NULL DEFAULT 'DRAFT',
    "reference" TEXT,
    "failure_detail" TEXT,
    "created_by_id" TEXT NOT NULL,
    "is_demo" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payout_batches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payout_items" (
    "id" TEXT NOT NULL,
    "batch_id" TEXT NOT NULL,
    "homemaker_profile_id" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "status" "payout_item_status" NOT NULL DEFAULT 'PENDING',
    "reference" TEXT,
    "failure_detail" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payout_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payout_item_credits" (
    "id" TEXT NOT NULL,
    "payout_item_id" TEXT NOT NULL,
    "ledger_entry_id" TEXT NOT NULL,
    "active_ledger_key" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payout_item_credits_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "data" JSONB,
    "dedupe_key" TEXT,
    "read_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" TEXT NOT NULL,
    "actor_id" TEXT,
    "action" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" TEXT NOT NULL,
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "idempotency_keys" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "status_code" INTEGER NOT NULL,
    "response_body" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "idempotency_keys_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_phone_key" ON "users"("phone");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_refresh_hash_key" ON "sessions"("refresh_hash");

-- CreateIndex
CREATE INDEX "sessions_user_id_idx" ON "sessions"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "service_areas_name_key" ON "service_areas"("name");

-- CreateIndex
CREATE UNIQUE INDEX "service_areas_code_key" ON "service_areas"("code");

-- CreateIndex
CREATE INDEX "stalls_service_area_id_idx" ON "stalls"("service_area_id");

-- CreateIndex
CREATE UNIQUE INDEX "onboarding_requests_reference_code_key" ON "onboarding_requests"("reference_code");

-- CreateIndex
CREATE INDEX "onboarding_requests_phone_status_idx" ON "onboarding_requests"("phone", "status");

-- CreateIndex
CREATE UNIQUE INDEX "homemaker_profiles_user_id_key" ON "homemaker_profiles"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "homemaker_profiles_onboarding_request_id_key" ON "homemaker_profiles"("onboarding_request_id");

-- CreateIndex
CREATE INDEX "homemaker_profiles_service_area_id_idx" ON "homemaker_profiles"("service_area_id");

-- CreateIndex
CREATE INDEX "daily_menus_status_service_date_idx" ON "daily_menus"("status", "service_date");

-- CreateIndex
CREATE UNIQUE INDEX "daily_menus_service_date_service_area_id_key" ON "daily_menus"("service_date", "service_area_id");

-- CreateIndex
CREATE INDEX "menu_items_menu_id_idx" ON "menu_items"("menu_id");

-- CreateIndex
CREATE INDEX "commitments_service_date_status_idx" ON "commitments"("service_date", "status");

-- CreateIndex
CREATE UNIQUE INDEX "commitments_homemaker_profile_id_menu_item_id_key" ON "commitments"("homemaker_profile_id", "menu_item_id");

-- CreateIndex
CREATE INDEX "commitment_status_events_commitment_id_created_at_idx" ON "commitment_status_events"("commitment_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "collection_records_commitment_id_key" ON "collection_records"("commitment_id");

-- CreateIndex
CREATE UNIQUE INDEX "inspections_commitment_id_key" ON "inspections"("commitment_id");

-- CreateIndex
CREATE INDEX "inspections_result_idx" ON "inspections"("result");

-- CreateIndex
CREATE UNIQUE INDEX "stock_lots_commitment_id_key" ON "stock_lots"("commitment_id");

-- CreateIndex
CREATE UNIQUE INDEX "stock_lots_inspection_id_key" ON "stock_lots"("inspection_id");

-- CreateIndex
CREATE INDEX "stock_lots_service_area_id_stall_id_idx" ON "stock_lots"("service_area_id", "stall_id");

-- CreateIndex
CREATE UNIQUE INDEX "stock_movements_idempotency_key_key" ON "stock_movements"("idempotency_key");

-- CreateIndex
CREATE INDEX "stock_movements_lot_id_created_at_idx" ON "stock_movements"("lot_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "ledger_entries_entry_key_key" ON "ledger_entries"("entry_key");

-- CreateIndex
CREATE UNIQUE INDEX "ledger_entries_settles_entry_id_key" ON "ledger_entries"("settles_entry_id");

-- CreateIndex
CREATE INDEX "ledger_entries_homemaker_profile_id_service_date_idx" ON "ledger_entries"("homemaker_profile_id", "service_date");

-- CreateIndex
CREATE INDEX "payout_batches_week_start_idx" ON "payout_batches"("week_start");

-- CreateIndex
CREATE INDEX "payout_items_batch_id_idx" ON "payout_items"("batch_id");

-- CreateIndex
CREATE INDEX "payout_items_homemaker_profile_id_idx" ON "payout_items"("homemaker_profile_id");

-- CreateIndex
CREATE UNIQUE INDEX "payout_item_credits_active_ledger_key_key" ON "payout_item_credits"("active_ledger_key");

-- CreateIndex
CREATE UNIQUE INDEX "payout_item_credits_payout_item_id_ledger_entry_id_key" ON "payout_item_credits"("payout_item_id", "ledger_entry_id");

-- CreateIndex
CREATE INDEX "notifications_user_id_created_at_idx" ON "notifications"("user_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "notifications_user_id_dedupe_key_key" ON "notifications"("user_id", "dedupe_key");

-- CreateIndex
CREATE INDEX "audit_logs_entity_type_entity_id_idx" ON "audit_logs"("entity_type", "entity_id");

-- CreateIndex
CREATE INDEX "audit_logs_created_at_idx" ON "audit_logs"("created_at");

-- CreateIndex
CREATE UNIQUE INDEX "idempotency_keys_user_id_key_key" ON "idempotency_keys"("user_id", "key");

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stalls" ADD CONSTRAINT "stalls_service_area_id_fkey" FOREIGN KEY ("service_area_id") REFERENCES "service_areas"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "onboarding_requests" ADD CONSTRAINT "onboarding_requests_service_area_id_fkey" FOREIGN KEY ("service_area_id") REFERENCES "service_areas"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "onboarding_requests" ADD CONSTRAINT "onboarding_requests_reviewed_by_id_fkey" FOREIGN KEY ("reviewed_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "onboarding_requests" ADD CONSTRAINT "onboarding_requests_created_user_id_fkey" FOREIGN KEY ("created_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "homemaker_profiles" ADD CONSTRAINT "homemaker_profiles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "homemaker_profiles" ADD CONSTRAINT "homemaker_profiles_service_area_id_fkey" FOREIGN KEY ("service_area_id") REFERENCES "service_areas"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "homemaker_profiles" ADD CONSTRAINT "homemaker_profiles_onboarding_request_id_fkey" FOREIGN KEY ("onboarding_request_id") REFERENCES "onboarding_requests"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "daily_menus" ADD CONSTRAINT "daily_menus_service_area_id_fkey" FOREIGN KEY ("service_area_id") REFERENCES "service_areas"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "menu_items" ADD CONSTRAINT "menu_items_menu_id_fkey" FOREIGN KEY ("menu_id") REFERENCES "daily_menus"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commitments" ADD CONSTRAINT "commitments_homemaker_profile_id_fkey" FOREIGN KEY ("homemaker_profile_id") REFERENCES "homemaker_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commitments" ADD CONSTRAINT "commitments_menu_item_id_fkey" FOREIGN KEY ("menu_item_id") REFERENCES "menu_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commitment_status_events" ADD CONSTRAINT "commitment_status_events_commitment_id_fkey" FOREIGN KEY ("commitment_id") REFERENCES "commitments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "collection_records" ADD CONSTRAINT "collection_records_commitment_id_fkey" FOREIGN KEY ("commitment_id") REFERENCES "commitments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inspections" ADD CONSTRAINT "inspections_commitment_id_fkey" FOREIGN KEY ("commitment_id") REFERENCES "commitments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_lots" ADD CONSTRAINT "stock_lots_commitment_id_fkey" FOREIGN KEY ("commitment_id") REFERENCES "commitments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_lots" ADD CONSTRAINT "stock_lots_inspection_id_fkey" FOREIGN KEY ("inspection_id") REFERENCES "inspections"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_lots" ADD CONSTRAINT "stock_lots_menu_item_id_fkey" FOREIGN KEY ("menu_item_id") REFERENCES "menu_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_lots" ADD CONSTRAINT "stock_lots_stall_id_fkey" FOREIGN KEY ("stall_id") REFERENCES "stalls"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_lot_id_fkey" FOREIGN KEY ("lot_id") REFERENCES "stock_lots"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_stall_id_fkey" FOREIGN KEY ("stall_id") REFERENCES "stalls"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_homemaker_profile_id_fkey" FOREIGN KEY ("homemaker_profile_id") REFERENCES "homemaker_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_commitment_id_fkey" FOREIGN KEY ("commitment_id") REFERENCES "commitments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_inspection_id_fkey" FOREIGN KEY ("inspection_id") REFERENCES "inspections"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_reverses_entry_id_fkey" FOREIGN KEY ("reverses_entry_id") REFERENCES "ledger_entries"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_settles_entry_id_fkey" FOREIGN KEY ("settles_entry_id") REFERENCES "ledger_entries"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payout_items" ADD CONSTRAINT "payout_items_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "payout_batches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payout_items" ADD CONSTRAINT "payout_items_homemaker_profile_id_fkey" FOREIGN KEY ("homemaker_profile_id") REFERENCES "homemaker_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payout_item_credits" ADD CONSTRAINT "payout_item_credits_payout_item_id_fkey" FOREIGN KEY ("payout_item_id") REFERENCES "payout_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payout_item_credits" ADD CONSTRAINT "payout_item_credits_ledger_entry_id_fkey" FOREIGN KEY ("ledger_entry_id") REFERENCES "ledger_entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

