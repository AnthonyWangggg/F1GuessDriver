ALTER TABLE game_sessions ADD COLUMN mode_contract text NOT NULL DEFAULT 'legacy';
ALTER TABLE game_sessions ADD COLUMN principal_id uuid REFERENCES identity_principals(id);
ALTER TABLE game_sessions ADD COLUMN revision integer NOT NULL DEFAULT 1;
ALTER TABLE game_sessions ADD CONSTRAINT game_principal_pair_uq UNIQUE(id,principal_id);
ALTER TABLE game_sessions ADD CONSTRAINT game_owner_principal_fk FOREIGN KEY(owner_hash,principal_id) REFERENCES identity_owners(owner_hash,principal_id);
ALTER TABLE game_sessions DROP CONSTRAINT game_attempts_check;
ALTER TABLE game_sessions ADD CONSTRAINT game_attempts_check CHECK (attempts_used BETWEEN 0 AND max_attempts AND ((mode_contract='legacy' AND principal_id IS NULL AND ((difficulty IN ('beginner','normal') AND max_attempts=8) OR (difficulty='historical' AND max_attempts=10))) OR (mode_contract='quick-v2' AND principal_id IS NOT NULL AND rules_version='v3' AND max_attempts=8)) AND revision>0);
CREATE UNIQUE INDEX quick_one_active_uq ON game_sessions(principal_id) WHERE mode_contract='quick-v2' AND status IN ('active','playing');
--> statement-breakpoint
CREATE TABLE quick_active_slots(principal_id uuid PRIMARY KEY REFERENCES identity_principals(id),game_id uuid NOT NULL UNIQUE,FOREIGN KEY(game_id,principal_id) REFERENCES game_sessions(id,principal_id));
--> statement-breakpoint
CREATE TABLE mode_requests(principal_id uuid NOT NULL REFERENCES identity_principals(id),idempotency_key uuid NOT NULL,digest text NOT NULL,response jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(principal_id,idempotency_key));
--> statement-breakpoint
CREATE TABLE daily_v2_challenges(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),challenge_date date NOT NULL,difficulty text NOT NULL CHECK(difficulty IN ('beginner','normal','historical')),answer_driver_id text NOT NULL,dataset_version text NOT NULL,comparison_rules_version text NOT NULL CHECK(comparison_rules_version='v3'),mode_contract text NOT NULL DEFAULT 'daily-v2' CHECK(mode_contract='daily-v2'),max_attempts integer NOT NULL DEFAULT 8 CHECK(max_attempts=8),submit_before timestamptz NOT NULL,
 UNIQUE(challenge_date,difficulty),UNIQUE(challenge_date,answer_driver_id),UNIQUE(id,dataset_version),
 FOREIGN KEY(answer_driver_id,dataset_version) REFERENCES driver_stats(driver_id,dataset_version),FOREIGN KEY(dataset_version,comparison_rules_version) REFERENCES dataset_versions(version,rules_version),
 CHECK(submit_before=((challenge_date+2)::timestamp AT TIME ZONE 'Asia/Shanghai'))
);
--> statement-breakpoint
CREATE TABLE daily_v2_entries(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),principal_id uuid NOT NULL REFERENCES identity_principals(id),challenge_id uuid NOT NULL REFERENCES daily_v2_challenges(id),dataset_version text NOT NULL,status text NOT NULL DEFAULT 'playing',attempts_used integer NOT NULL DEFAULT 0,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),completed_at timestamptz,
 UNIQUE(principal_id,challenge_id),UNIQUE(id,principal_id),UNIQUE(id,dataset_version),FOREIGN KEY(challenge_id,dataset_version) REFERENCES daily_v2_challenges(id,dataset_version),
 CHECK((status='playing' AND completed_at IS NULL AND attempts_used BETWEEN 0 AND 7) OR (status='won' AND completed_at IS NOT NULL AND attempts_used BETWEEN 1 AND 8) OR (status='lost' AND completed_at IS NOT NULL AND attempts_used=8))
);
--> statement-breakpoint
CREATE TABLE daily_v2_guesses(
 entry_id uuid NOT NULL,dataset_version text NOT NULL,driver_id text NOT NULL,attempt_number integer NOT NULL CHECK(attempt_number BETWEEN 1 AND 8),attributes jsonb NOT NULL,is_correct boolean NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(entry_id,attempt_number),UNIQUE(entry_id,driver_id),FOREIGN KEY(entry_id,dataset_version) REFERENCES daily_v2_entries(id,dataset_version),FOREIGN KEY(driver_id,dataset_version) REFERENCES driver_stats(driver_id,dataset_version)
);
--> statement-breakpoint
ALTER TABLE points_ledger ADD COLUMN daily_entry_id uuid;
ALTER TABLE points_ledger ADD CONSTRAINT points_daily_entry_fk FOREIGN KEY(daily_entry_id,principal_id) REFERENCES daily_v2_entries(id,principal_id);
ALTER TABLE points_ledger ADD CONSTRAINT points_daily_source_check CHECK((source_kind='daily-v2' AND daily_entry_id IS NOT NULL AND daily_entry_id=source_id) OR (source_kind<>'daily-v2' AND daily_entry_id IS NULL));
CREATE INDEX daily_v2_principal_idx ON daily_v2_entries(principal_id,created_at);
