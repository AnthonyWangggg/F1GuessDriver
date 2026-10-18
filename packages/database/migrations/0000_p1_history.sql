CREATE TABLE "constructor_aliases" (
	"constructor_id" text NOT NULL,
	"alias" text NOT NULL,
	"normalized" text NOT NULL,
	"source_url" text NOT NULL,
	CONSTRAINT "constructor_aliases_constructor_id_normalized_pk" PRIMARY KEY("constructor_id","normalized")
);
--> statement-breakpoint
CREATE TABLE "constructors" (
	"id" text PRIMARY KEY NOT NULL,
	"external_id" text NOT NULL,
	"name" text NOT NULL,
	"nationality" text,
	"source_url" text,
	CONSTRAINT "constructors_external_id_unique" UNIQUE("external_id")
);
--> statement-breakpoint
CREATE TABLE "dataset_versions" (
	"version" text PRIMARY KEY NOT NULL,
	"stats_as_of" date NOT NULL,
	"source" text NOT NULL,
	"algorithm_version" text NOT NULL,
	"content_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"validation_status" text DEFAULT 'pending' NOT NULL,
	"report" jsonb,
	CONSTRAINT "dataset_versions_content_hash_unique" UNIQUE("content_hash")
);
--> statement-breakpoint
CREATE TABLE "driver_aliases" (
	"driver_id" text NOT NULL,
	"alias" text NOT NULL,
	"normalized" text NOT NULL,
	"language" text NOT NULL,
	"kind" text NOT NULL,
	"source_url" text NOT NULL,
	CONSTRAINT "driver_aliases_driver_id_normalized_pk" PRIMARY KEY("driver_id","normalized")
);
--> statement-breakpoint
CREATE TABLE "driver_constructor_stints" (
	"driver_id" text NOT NULL,
	"constructor_id" text NOT NULL,
	"season" integer NOT NULL,
	"first_round" integer NOT NULL,
	"last_round" integer NOT NULL,
	CONSTRAINT "driver_constructor_stints_driver_id_constructor_id_season_pk" PRIMARY KEY("driver_id","constructor_id","season"),
	CONSTRAINT "stint_rounds_check" CHECK ("driver_constructor_stints"."first_round" > 0 AND "driver_constructor_stints"."last_round" >= "driver_constructor_stints"."first_round")
);
--> statement-breakpoint
CREATE TABLE "driver_seasons" (
	"driver_id" text NOT NULL,
	"season" integer NOT NULL,
	"position" integer,
	"position_text" text,
	"points" text,
	"is_champion" boolean,
	"source_url" text NOT NULL,
	CONSTRAINT "driver_seasons_driver_id_season_pk" PRIMARY KEY("driver_id","season")
);
--> statement-breakpoint
CREATE TABLE "driver_stats" (
	"driver_id" text NOT NULL,
	"dataset_version" text NOT NULL,
	"nationality_code" text,
	"debut_year" integer,
	"last_start_year" integer,
	"championships" integer,
	"wins" integer,
	"podiums" integer,
	"race_starts" integer,
	"constructor_ids" text[],
	"active_decades" integer[],
	"eligible" boolean NOT NULL,
	"issues" jsonb NOT NULL,
	CONSTRAINT "driver_stats_driver_id_dataset_version_pk" PRIMARY KEY("driver_id","dataset_version"),
	CONSTRAINT "stats_nonnegative_check" CHECK (("driver_stats"."championships" IS NULL OR "driver_stats"."championships" >= 0) AND ("driver_stats"."wins" IS NULL OR "driver_stats"."wins" >= 0) AND ("driver_stats"."podiums" IS NULL OR "driver_stats"."podiums" >= 0) AND ("driver_stats"."race_starts" IS NULL OR "driver_stats"."race_starts" >= 0)),
	CONSTRAINT "stats_eligible_check" CHECK (NOT "driver_stats"."eligible" OR ("driver_stats"."debut_year" IS NOT NULL AND "driver_stats"."last_start_year" IS NOT NULL AND "driver_stats"."race_starts" > 0 AND "driver_stats"."championships" IS NOT NULL AND "driver_stats"."wins" IS NOT NULL AND "driver_stats"."podiums" IS NOT NULL AND "driver_stats"."constructor_ids" IS NOT NULL AND "driver_stats"."active_decades" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "drivers" (
	"id" text PRIMARY KEY NOT NULL,
	"external_id" text NOT NULL,
	"given_name" text NOT NULL,
	"family_name" text NOT NULL,
	"display_name_zh" text,
	"nationality" text,
	"nationality_code" text,
	"birth_date" date,
	"source_url" text,
	CONSTRAINT "drivers_external_id_unique" UNIQUE("external_id")
);
--> statement-breakpoint
CREATE TABLE "import_pages" (
	"run_id" text NOT NULL,
	"endpoint" text NOT NULL,
	"offset" integer NOT NULL,
	"next_offset" integer NOT NULL,
	"total" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"payload" jsonb NOT NULL,
	CONSTRAINT "import_pages_run_id_endpoint_offset_pk" PRIMARY KEY("run_id","endpoint","offset"),
	CONSTRAINT "page_offset_check" CHECK ("import_pages"."offset" >= 0 AND "import_pages"."next_offset" >= "import_pages"."offset" AND "import_pages"."total" >= "import_pages"."next_offset")
);
--> statement-breakpoint
CREATE TABLE "import_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"stats_as_of" date NOT NULL,
	"source" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "race_results" (
	"id" text PRIMARY KEY NOT NULL,
	"race_id" text NOT NULL,
	"driver_id" text NOT NULL,
	"constructor_id" text NOT NULL,
	"car_number" text,
	"grid" integer,
	"position" integer,
	"position_text" text,
	"laps" integer,
	"status" text,
	"points" text,
	"started" boolean,
	"credited_win" boolean,
	"credited_podium" boolean,
	"issues" jsonb NOT NULL,
	"review_source" text,
	"raw" jsonb NOT NULL,
	CONSTRAINT "result_laps_check" CHECK ("race_results"."laps" IS NULL OR "race_results"."laps" >= 0)
);
--> statement-breakpoint
CREATE TABLE "races" (
	"id" text PRIMARY KEY NOT NULL,
	"external_id" text NOT NULL,
	"season" integer NOT NULL,
	"round" integer NOT NULL,
	"race_date" date NOT NULL,
	"name" text NOT NULL,
	"circuit_external_id" text NOT NULL,
	"is_indy500" boolean NOT NULL,
	"results_complete" boolean DEFAULT false NOT NULL,
	"source_result_count" integer,
	"source_url" text NOT NULL,
	CONSTRAINT "races_external_id_unique" UNIQUE("external_id"),
	CONSTRAINT "race_round_check" CHECK ("races"."round" > 0)
);
--> statement-breakpoint
CREATE TABLE "seasons" (
	"year" integer PRIMARY KEY NOT NULL,
	"calendar_complete" boolean DEFAULT false NOT NULL,
	"results_complete" boolean DEFAULT false NOT NULL,
	"standings_complete" boolean DEFAULT false NOT NULL,
	"is_final" boolean DEFAULT false NOT NULL,
	"standings_round" integer,
	CONSTRAINT "season_year_check" CHECK ("seasons"."year" >= 1950)
);
--> statement-breakpoint
ALTER TABLE "constructor_aliases" ADD CONSTRAINT "constructor_aliases_constructor_id_constructors_id_fk" FOREIGN KEY ("constructor_id") REFERENCES "public"."constructors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "driver_aliases" ADD CONSTRAINT "driver_aliases_driver_id_drivers_id_fk" FOREIGN KEY ("driver_id") REFERENCES "public"."drivers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "driver_constructor_stints" ADD CONSTRAINT "driver_constructor_stints_driver_id_drivers_id_fk" FOREIGN KEY ("driver_id") REFERENCES "public"."drivers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "driver_constructor_stints" ADD CONSTRAINT "driver_constructor_stints_constructor_id_constructors_id_fk" FOREIGN KEY ("constructor_id") REFERENCES "public"."constructors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "driver_constructor_stints" ADD CONSTRAINT "driver_constructor_stints_season_seasons_year_fk" FOREIGN KEY ("season") REFERENCES "public"."seasons"("year") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "driver_seasons" ADD CONSTRAINT "driver_seasons_driver_id_drivers_id_fk" FOREIGN KEY ("driver_id") REFERENCES "public"."drivers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "driver_seasons" ADD CONSTRAINT "driver_seasons_season_seasons_year_fk" FOREIGN KEY ("season") REFERENCES "public"."seasons"("year") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "driver_stats" ADD CONSTRAINT "driver_stats_driver_id_drivers_id_fk" FOREIGN KEY ("driver_id") REFERENCES "public"."drivers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "driver_stats" ADD CONSTRAINT "driver_stats_dataset_version_dataset_versions_version_fk" FOREIGN KEY ("dataset_version") REFERENCES "public"."dataset_versions"("version") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_pages" ADD CONSTRAINT "import_pages_run_id_import_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."import_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "race_results" ADD CONSTRAINT "race_results_race_id_races_id_fk" FOREIGN KEY ("race_id") REFERENCES "public"."races"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "race_results" ADD CONSTRAINT "race_results_driver_id_drivers_id_fk" FOREIGN KEY ("driver_id") REFERENCES "public"."drivers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "race_results" ADD CONSTRAINT "race_results_constructor_id_constructors_id_fk" FOREIGN KEY ("constructor_id") REFERENCES "public"."constructors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "races" ADD CONSTRAINT "races_season_seasons_year_fk" FOREIGN KEY ("season") REFERENCES "public"."seasons"("year") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "constructor_alias_search_idx" ON "constructor_aliases" USING btree ("normalized");--> statement-breakpoint
CREATE INDEX "driver_alias_search_idx" ON "driver_aliases" USING btree ("normalized");--> statement-breakpoint
CREATE INDEX "stint_constructor_idx" ON "driver_constructor_stints" USING btree ("constructor_id");--> statement-breakpoint
CREATE INDEX "driver_season_year_idx" ON "driver_seasons" USING btree ("season");--> statement-breakpoint
CREATE INDEX "stats_version_idx" ON "driver_stats" USING btree ("dataset_version");--> statement-breakpoint
CREATE INDEX "result_driver_idx" ON "race_results" USING btree ("driver_id");--> statement-breakpoint
CREATE INDEX "result_race_idx" ON "race_results" USING btree ("race_id");--> statement-breakpoint
CREATE INDEX "result_constructor_idx" ON "race_results" USING btree ("constructor_id");--> statement-breakpoint
CREATE UNIQUE INDEX "race_season_round_uq" ON "races" USING btree ("season","round");--> statement-breakpoint
CREATE INDEX "race_date_idx" ON "races" USING btree ("race_date");