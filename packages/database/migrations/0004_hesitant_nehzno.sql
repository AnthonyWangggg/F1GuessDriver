CREATE TABLE "pole_audits" (
	"id" text PRIMARY KEY NOT NULL,
	"source_release" text NOT NULL,
	"cutoff" date NOT NULL,
	"report" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "race_poles" (
	"audit_id" text NOT NULL,
	"race_id" text NOT NULL,
	"driver_id" text NOT NULL,
	"source_driver_id" text NOT NULL,
	"source_race_id" integer NOT NULL,
	"evidence" jsonb NOT NULL,
	CONSTRAINT "race_poles_audit_id_race_id_pk" PRIMARY KEY("audit_id","race_id")
);
--> statement-breakpoint
ALTER TABLE "game_sessions" DROP CONSTRAINT "game_state_check";--> statement-breakpoint
ALTER TABLE "dataset_versions" ADD COLUMN "rules_version" text DEFAULT 'v1' NOT NULL;--> statement-breakpoint
ALTER TABLE "dataset_versions" ADD COLUMN "pole_audit_id" text;--> statement-breakpoint
ALTER TABLE "driver_stats" ADD COLUMN "pole_positions" integer;--> statement-breakpoint
ALTER TABLE "game_sessions" ADD COLUMN "rules_version" text DEFAULT 'v1' NOT NULL;--> statement-breakpoint
ALTER TABLE "race_poles" ADD CONSTRAINT "race_poles_audit_id_pole_audits_id_fk" FOREIGN KEY ("audit_id") REFERENCES "public"."pole_audits"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "race_poles" ADD CONSTRAINT "race_poles_race_id_races_id_fk" FOREIGN KEY ("race_id") REFERENCES "public"."races"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "race_poles" ADD CONSTRAINT "race_poles_driver_id_drivers_id_fk" FOREIGN KEY ("driver_id") REFERENCES "public"."drivers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "pole_driver_idx" ON "race_poles" USING btree ("audit_id","driver_id");--> statement-breakpoint
ALTER TABLE "dataset_versions" ADD CONSTRAINT "dataset_versions_pole_audit_id_pole_audits_id_fk" FOREIGN KEY ("pole_audit_id") REFERENCES "public"."pole_audits"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "driver_stats" ADD CONSTRAINT "stats_poles_check" CHECK ("driver_stats"."pole_positions" IS NULL OR "driver_stats"."pole_positions" >= 0);--> statement-breakpoint
ALTER TABLE "game_sessions" ADD CONSTRAINT "game_rules_check" CHECK ("game_sessions"."rules_version" IN ('v1','v2') AND ("game_sessions"."status"<>'active' OR "game_sessions"."rules_version"='v1') AND ("game_sessions"."status"<>'playing' OR "game_sessions"."rules_version"='v2'));--> statement-breakpoint
ALTER TABLE "game_sessions" ADD CONSTRAINT "game_state_check" CHECK (("game_sessions"."status" IN ('active','playing') AND "game_sessions"."ended_at" IS NULL AND "game_sessions"."attempts_used"<"game_sessions"."max_attempts") OR ("game_sessions"."status"='won' AND "game_sessions"."ended_at" IS NOT NULL AND "game_sessions"."attempts_used">0) OR ("game_sessions"."status"='lost' AND "game_sessions"."ended_at" IS NOT NULL AND "game_sessions"."attempts_used"="game_sessions"."max_attempts") OR ("game_sessions"."status"='revealed' AND "game_sessions"."ended_at" IS NOT NULL AND "game_sessions"."attempts_used"<"game_sessions"."max_attempts"));