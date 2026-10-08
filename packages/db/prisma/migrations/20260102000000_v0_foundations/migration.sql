-- CreateEnum
CREATE TYPE "OutboxStatus" AS ENUM ('PENDING', 'PUBLISHED', 'FAILED');

-- CreateEnum
CREATE TYPE "TaskStatus" AS ENUM ('OPEN', 'IN_PROGRESS', 'DONE', 'CANCELLED');

-- CreateEnum
CREATE TYPE "TaskPriority" AS ENUM ('LOW', 'NORMAL', 'HIGH');

-- CreateEnum
CREATE TYPE "IntegrationStatus" AS ENUM ('ACTIVE', 'REVOKED', 'ERROR');

-- CreateEnum
CREATE TYPE "AiRunStatus" AS ENUM ('SUCCEEDED', 'FAILED');

-- CreateEnum
CREATE TYPE "AiProposalStatus" AS ENUM ('PENDING_REVIEW', 'APPROVED', 'REJECTED');

-- CreateTable
CREATE TABLE "login_trusted_ip" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "ip_hash" TEXT NOT NULL,
    "last_success_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "login_trusted_ip_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outbox_event" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "event_type" TEXT NOT NULL,
    "event_version" INTEGER NOT NULL DEFAULT 1,
    "aggregate_type" TEXT NOT NULL,
    "aggregate_id" TEXT NOT NULL,
    "organisation_id" UUID,
    "actor_user_id" UUID,
    "payload" JSONB NOT NULL,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "correlation_id" TEXT NOT NULL,
    "causation_id" TEXT,
    "idempotency_key" TEXT,
    "status" "OutboxStatus" NOT NULL DEFAULT 'PENDING',
    "retry_count" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "next_attempt_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "published_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "outbox_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "event_consumption" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "event_id" UUID NOT NULL,
    "consumer" TEXT NOT NULL,
    "organisation_id" UUID,
    "processed_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "event_consumption_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflow_instance" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organisation_id" UUID NOT NULL,
    "company_id" UUID,
    "type" TEXT NOT NULL,
    "definition_version" INTEGER NOT NULL,
    "state" TEXT NOT NULL,
    "subject_type" TEXT NOT NULL,
    "subject_id" TEXT NOT NULL,
    "context" JSONB NOT NULL DEFAULT '{}',
    "version" INTEGER NOT NULL DEFAULT 1,
    "started_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ(3),

    CONSTRAINT "workflow_instance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflow_transition" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organisation_id" UUID NOT NULL,
    "instance_id" UUID NOT NULL,
    "from_state" TEXT,
    "to_state" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "actor_user_id" UUID,
    "comment" TEXT,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workflow_transition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "task" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organisation_id" UUID NOT NULL,
    "company_id" UUID,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "status" "TaskStatus" NOT NULL DEFAULT 'OPEN',
    "priority" "TaskPriority" NOT NULL DEFAULT 'NORMAL',
    "due_date" DATE,
    "assignee_user_id" UUID,
    "created_by_user_id" UUID NOT NULL,
    "subject_type" TEXT,
    "subject_id" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ(3),

    CONSTRAINT "task_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organisation_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL DEFAULT '',
    "entity_type" TEXT,
    "entity_id" TEXT,
    "read_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "integration_connection" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organisation_id" UUID NOT NULL,
    "company_id" UUID,
    "provider" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "status" "IntegrationStatus" NOT NULL DEFAULT 'ACTIVE',
    "credentials_encrypted" TEXT,
    "scopes" TEXT[],
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_checked_at" TIMESTAMPTZ(3),
    "last_error" TEXT,

    CONSTRAINT "integration_connection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_run" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organisation_id" UUID NOT NULL,
    "user_id" UUID,
    "purpose" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "input_hash" TEXT NOT NULL,
    "output_hash" TEXT,
    "status" "AiRunStatus" NOT NULL,
    "prompt_tokens" INTEGER,
    "completion_tokens" INTEGER,
    "latency_ms" INTEGER,
    "error" TEXT,
    "correlation_id" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_run_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_proposal" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organisation_id" UUID NOT NULL,
    "company_id" UUID,
    "ai_run_id" UUID,
    "kind" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "AiProposalStatus" NOT NULL DEFAULT 'PENDING_REVIEW',
    "workflow_instance_id" UUID,
    "requested_by_user_id" UUID,
    "decided_by_user_id" UUID,
    "decided_at" TIMESTAMPTZ(3),
    "decision_comment" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_proposal_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "login_trusted_ip_user_id_ip_hash_key" ON "login_trusted_ip"("user_id", "ip_hash");

-- CreateIndex
CREATE UNIQUE INDEX "outbox_event_idempotency_key_key" ON "outbox_event"("idempotency_key");

-- CreateIndex
CREATE INDEX "outbox_event_status_next_attempt_at_idx" ON "outbox_event"("status", "next_attempt_at");

-- CreateIndex
CREATE INDEX "outbox_event_organisation_id_occurred_at_idx" ON "outbox_event"("organisation_id", "occurred_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "event_consumption_event_id_consumer_key" ON "event_consumption"("event_id", "consumer");

-- CreateIndex
CREATE INDEX "workflow_instance_organisation_id_type_state_idx" ON "workflow_instance"("organisation_id", "type", "state");

-- CreateIndex
CREATE INDEX "workflow_instance_organisation_id_subject_type_subject_id_idx" ON "workflow_instance"("organisation_id", "subject_type", "subject_id");

-- CreateIndex
CREATE UNIQUE INDEX "workflow_instance_organisation_id_id_key" ON "workflow_instance"("organisation_id", "id");

-- CreateIndex
CREATE INDEX "workflow_transition_instance_id_occurred_at_idx" ON "workflow_transition"("instance_id", "occurred_at");

-- CreateIndex
CREATE INDEX "task_organisation_id_status_idx" ON "task"("organisation_id", "status");

-- CreateIndex
CREATE INDEX "task_organisation_id_assignee_user_id_idx" ON "task"("organisation_id", "assignee_user_id");

-- CreateIndex
CREATE INDEX "notification_organisation_id_user_id_created_at_idx" ON "notification"("organisation_id", "user_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "integration_connection_organisation_id_provider_idx" ON "integration_connection"("organisation_id", "provider");

-- CreateIndex
CREATE INDEX "ai_run_organisation_id_created_at_idx" ON "ai_run"("organisation_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "ai_proposal_organisation_id_status_idx" ON "ai_proposal"("organisation_id", "status");

-- AddForeignKey
ALTER TABLE "workflow_transition" ADD CONSTRAINT "workflow_transition_organisation_id_instance_id_fkey" FOREIGN KEY ("organisation_id", "instance_id") REFERENCES "workflow_instance"("organisation_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

