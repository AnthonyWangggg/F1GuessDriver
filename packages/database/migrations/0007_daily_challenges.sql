-- Phase B proposal only. Expand-only; no production execution authorised.
CREATE TABLE "daily_challenges" (
  "challenge_date" date PRIMARY KEY,
  "answer_driver_id" text NOT NULL,
  "dataset_version" text NOT NULL,
  "rules_version" text NOT NULL,
  "max_attempts" integer NOT NULL DEFAULT 8,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "daily_challenge_version_uq" UNIQUE ("challenge_date","dataset_version","rules_version"),
  CONSTRAINT "daily_answer_snapshot_fk" FOREIGN KEY ("answer_driver_id","dataset_version") REFERENCES "public"."driver_stats"("driver_id","dataset_version"),
  CONSTRAINT "daily_rules_version_fk" FOREIGN KEY ("dataset_version","rules_version") REFERENCES "public"."dataset_versions"("version","rules_version"),
  CONSTRAINT "daily_eight_attempts_check" CHECK ("max_attempts"=8)
);
--> statement-breakpoint
CREATE TABLE "daily_entries" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "challenge_date" date NOT NULL,
  "owner_hash" text NOT NULL,
  "dataset_version" text NOT NULL,
  "rules_version" text NOT NULL,
  "status" text NOT NULL DEFAULT 'playing',
  "attempts_used" integer NOT NULL DEFAULT 0,
  "outcome" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "completed_at" timestamptz,
  CONSTRAINT "daily_owner_date_uq" UNIQUE ("owner_hash","challenge_date"),
  CONSTRAINT "daily_entry_version_uq" UNIQUE ("id","dataset_version"),
  CONSTRAINT "daily_entry_challenge_fk" FOREIGN KEY ("challenge_date","dataset_version","rules_version") REFERENCES "public"."daily_challenges"("challenge_date","dataset_version","rules_version"),
  CONSTRAINT "daily_owner_check" CHECK ("owner_hash" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "daily_entry_state_check" CHECK (
    ("status"='playing' AND "completed_at" IS NULL AND "outcome" IS NULL AND "attempts_used" BETWEEN 0 AND 7)
    OR ("status"='won' AND "completed_at" IS NOT NULL AND "outcome" IS NOT NULL AND "outcome"='success' AND "attempts_used" BETWEEN 1 AND 8)
    OR ("status"='lost' AND "completed_at" IS NOT NULL AND "outcome" IS NOT NULL AND "outcome"='failure' AND "attempts_used"=8)
  )
);
--> statement-breakpoint
CREATE INDEX "daily_entry_date_idx" ON "daily_entries"("challenge_date");
--> statement-breakpoint
CREATE TABLE "daily_guesses" (
  "entry_id" uuid NOT NULL,
  "dataset_version" text NOT NULL,
  "driver_id" text NOT NULL,
  "attempt_number" integer NOT NULL,
  "attributes" jsonb NOT NULL,
  "is_correct" boolean NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("entry_id","attempt_number"),
  CONSTRAINT "daily_guess_driver_uq" UNIQUE ("entry_id","driver_id"),
  CONSTRAINT "daily_guess_entry_fk" FOREIGN KEY ("entry_id","dataset_version") REFERENCES "public"."daily_entries"("id","dataset_version"),
  CONSTRAINT "daily_guess_snapshot_fk" FOREIGN KEY ("driver_id","dataset_version") REFERENCES "public"."driver_stats"("driver_id","dataset_version"),
  CONSTRAINT "daily_guess_attempt_check" CHECK ("attempt_number" BETWEEN 1 AND 8)
);
--> statement-breakpoint
CREATE TABLE "daily_submissions" (
  "entry_id" uuid NOT NULL,
  "idempotency_key" uuid NOT NULL,
  "driver_id" text NOT NULL,
  "response" jsonb NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("entry_id","idempotency_key"),
  CONSTRAINT "daily_submission_guess_fk" FOREIGN KEY ("entry_id","driver_id") REFERENCES "public"."daily_guesses"("entry_id","driver_id")
);
--> statement-breakpoint
CREATE TABLE "daily_rate_limits" (
  "owner_hash" text PRIMARY KEY,
  "window_start" timestamptz NOT NULL,
  "request_count" integer NOT NULL,
  CONSTRAINT "daily_rate_owner_check" CHECK ("owner_hash" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "daily_rate_count_check" CHECK ("request_count">0)
);
