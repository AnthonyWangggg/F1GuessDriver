CREATE TABLE "driver_career_timelines" (
	"driver_id" text NOT NULL,
	"dataset_version" text NOT NULL,
	"last_constructor_id" text,
	"stages" jsonb NOT NULL,
	"issues" jsonb NOT NULL,
	"evidence_hash" text NOT NULL,
	CONSTRAINT "driver_career_timelines_driver_id_dataset_version_pk" PRIMARY KEY("driver_id","dataset_version")
);
--> statement-breakpoint
ALTER TABLE "dataset_versions" DROP CONSTRAINT "dataset_rules_check";--> statement-breakpoint
ALTER TABLE "game_sessions" DROP CONSTRAINT "game_rules_check";--> statement-breakpoint
ALTER TABLE "driver_career_timelines" ADD CONSTRAINT "driver_career_timelines_last_constructor_id_constructors_id_fk" FOREIGN KEY ("last_constructor_id") REFERENCES "public"."constructors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "driver_career_timelines" ADD CONSTRAINT "timeline_snapshot_fk" FOREIGN KEY ("driver_id","dataset_version") REFERENCES "public"."driver_stats"("driver_id","dataset_version") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dataset_versions" ADD CONSTRAINT "dataset_rules_check" CHECK ("dataset_versions"."rules_version" IN ('v1','v2','v3') AND ("dataset_versions"."rules_version"='v1' OR "dataset_versions"."pole_audit_id" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "game_sessions" ADD CONSTRAINT "game_rules_check" CHECK ("game_sessions"."rules_version" IN ('v1','v2','v3') AND ("game_sessions"."status"<>'active' OR "game_sessions"."rules_version"='v1') AND ("game_sessions"."status"<>'playing' OR "game_sessions"."rules_version" IN ('v2','v3')));