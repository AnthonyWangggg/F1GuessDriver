CREATE TABLE "game_guesses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"game_id" uuid NOT NULL,
	"dataset_version" text NOT NULL,
	"driver_id" text NOT NULL,
	"attempt_number" integer NOT NULL,
	"attributes" jsonb NOT NULL,
	"is_correct" boolean NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "guess_attempt_check" CHECK ("game_guesses"."attempt_number">0 AND "game_guesses"."attempt_number"<=10)
);
--> statement-breakpoint
CREATE TABLE "game_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_hash" text NOT NULL,
	"answer_driver_id" text NOT NULL,
	"dataset_version" text NOT NULL,
	"difficulty" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"max_attempts" integer NOT NULL,
	"attempts_used" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	CONSTRAINT "game_id_version_uq" UNIQUE("id","dataset_version"),
	CONSTRAINT "game_owner_hash_check" CHECK ("game_sessions"."owner_hash" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "game_difficulty_check" CHECK ("game_sessions"."difficulty" IN ('beginner','normal','historical')),
	CONSTRAINT "game_attempts_check" CHECK ("game_sessions"."attempts_used" >= 0 AND "game_sessions"."attempts_used" <= "game_sessions"."max_attempts" AND (("game_sessions"."difficulty" IN ('beginner','normal') AND "game_sessions"."max_attempts"=8) OR ("game_sessions"."difficulty"='historical' AND "game_sessions"."max_attempts"=10))),
	CONSTRAINT "game_state_check" CHECK (("game_sessions"."status"='active' AND "game_sessions"."ended_at" IS NULL AND "game_sessions"."attempts_used"<"game_sessions"."max_attempts") OR ("game_sessions"."status"='won' AND "game_sessions"."ended_at" IS NOT NULL AND "game_sessions"."attempts_used">0) OR ("game_sessions"."status"='lost' AND "game_sessions"."ended_at" IS NOT NULL AND "game_sessions"."attempts_used"="game_sessions"."max_attempts"))
);
--> statement-breakpoint
ALTER TABLE "game_guesses" ADD CONSTRAINT "guess_game_version_fk" FOREIGN KEY ("game_id","dataset_version") REFERENCES "public"."game_sessions"("id","dataset_version") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "game_guesses" ADD CONSTRAINT "guess_driver_snapshot_fk" FOREIGN KEY ("driver_id","dataset_version") REFERENCES "public"."driver_stats"("driver_id","dataset_version") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "game_sessions" ADD CONSTRAINT "game_sessions_dataset_version_dataset_versions_version_fk" FOREIGN KEY ("dataset_version") REFERENCES "public"."dataset_versions"("version") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "game_sessions" ADD CONSTRAINT "game_answer_snapshot_fk" FOREIGN KEY ("answer_driver_id","dataset_version") REFERENCES "public"."driver_stats"("driver_id","dataset_version") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "game_guess_driver_uq" ON "game_guesses" USING btree ("game_id","driver_id");--> statement-breakpoint
CREATE UNIQUE INDEX "game_guess_attempt_uq" ON "game_guesses" USING btree ("game_id","attempt_number");--> statement-breakpoint
CREATE INDEX "game_owner_idx" ON "game_sessions" USING btree ("owner_hash","created_at");