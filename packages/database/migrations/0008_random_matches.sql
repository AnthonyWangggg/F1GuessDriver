-- Stage C proposal. Expand-only. No production execution authorized.
CREATE TABLE matches (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), answer_driver_id text NOT NULL,
 dataset_version text NOT NULL, rules_version text NOT NULL,
 status text NOT NULL DEFAULT 'active', starts_at timestamptz NOT NULL,
 deadline_at timestamptz NOT NULL, revision integer NOT NULL DEFAULT 1,
 settled_at timestamptz, winner_slot integer, settlement_reason text,
 CONSTRAINT match_version_uq UNIQUE(id,dataset_version),
 CONSTRAINT match_answer_snapshot_fk FOREIGN KEY(answer_driver_id,dataset_version) REFERENCES "public".driver_stats(driver_id,dataset_version),
 CONSTRAINT match_rules_fk FOREIGN KEY(dataset_version,rules_version) REFERENCES "public".dataset_versions(version,rules_version),
 CONSTRAINT match_rules_check CHECK(rules_version='v3'),
 CONSTRAINT match_deadline_check CHECK(deadline_at=starts_at+interval '10 minutes'),
 CONSTRAINT match_revision_check CHECK(revision>0),
 CONSTRAINT match_state_check CHECK(
  (status='active' AND settled_at IS NULL AND winner_slot IS NULL AND settlement_reason IS NULL)
  OR (status='finished' AND settled_at IS NOT NULL AND (winner_slot IS NULL OR winner_slot IN (0,1))
      AND settlement_reason IS NOT NULL AND settlement_reason IN ('players-locked','deadline')))
);
--> statement-breakpoint
CREATE INDEX match_deadline_idx ON matches(deadline_at) WHERE status='active';
--> statement-breakpoint
CREATE TABLE match_queue (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),owner_hash text NOT NULL,status text NOT NULL DEFAULT 'queued',
 position bigint GENERATED ALWAYS AS IDENTITY NOT NULL,CONSTRAINT match_queue_position_uq UNIQUE(position),
 created_at timestamptz NOT NULL DEFAULT now(),expires_at timestamptz NOT NULL,match_id uuid REFERENCES "public".matches(id),
 CONSTRAINT match_queue_owner_check CHECK(owner_hash ~ '^[a-f0-9]{64}$'),
 CONSTRAINT match_queue_expiry_check CHECK(expires_at=created_at+interval '120 seconds'),
 CONSTRAINT match_queue_state_check CHECK((status IN ('queued','cancelled','expired') AND match_id IS NULL) OR (status='matched' AND match_id IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX match_queue_owner_active_uq ON match_queue(owner_hash) WHERE status='queued';
--> statement-breakpoint
CREATE INDEX match_queue_waiting_idx ON match_queue(position) WHERE status='queued';
--> statement-breakpoint
CREATE INDEX match_queue_owner_position_idx ON match_queue(owner_hash,position);
--> statement-breakpoint
CREATE TABLE match_players (
 match_id uuid NOT NULL REFERENCES "public".matches(id),owner_hash text NOT NULL,slot integer NOT NULL,
 attempts_used integer NOT NULL DEFAULT 0,solved_at timestamptz,outcome text,
 PRIMARY KEY(match_id,owner_hash),CONSTRAINT match_player_slot_uq UNIQUE(match_id,slot),
 CONSTRAINT match_player_owner_check CHECK(owner_hash ~ '^[a-f0-9]{64}$'),
 CONSTRAINT match_player_progress_check CHECK(slot IN (0,1) AND attempts_used BETWEEN 0 AND 8 AND (solved_at IS NULL OR attempts_used>0) AND (outcome IS NULL OR outcome IN ('win','loss','draw')))
);
--> statement-breakpoint
CREATE INDEX match_player_owner_idx ON match_players(owner_hash);
--> statement-breakpoint
CREATE TABLE match_memberships (
 owner_hash text PRIMARY KEY,match_id uuid NOT NULL,
 CONSTRAINT match_membership_player_fk FOREIGN KEY(match_id,owner_hash) REFERENCES "public".match_players(match_id,owner_hash)
);
--> statement-breakpoint
CREATE TABLE match_guesses (
 match_id uuid NOT NULL,owner_hash text NOT NULL,dataset_version text NOT NULL,driver_id text NOT NULL,
 attempt_number integer NOT NULL,attributes jsonb NOT NULL,is_correct boolean NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(match_id,owner_hash,attempt_number),CONSTRAINT match_guess_driver_uq UNIQUE(match_id,owner_hash,driver_id),
 CONSTRAINT match_guess_player_fk FOREIGN KEY(match_id,owner_hash) REFERENCES "public".match_players(match_id,owner_hash),
 CONSTRAINT match_guess_version_fk FOREIGN KEY(match_id,dataset_version) REFERENCES "public".matches(id,dataset_version),
 CONSTRAINT match_guess_snapshot_fk FOREIGN KEY(driver_id,dataset_version) REFERENCES "public".driver_stats(driver_id,dataset_version),
 CONSTRAINT match_guess_attempt_check CHECK(attempt_number BETWEEN 1 AND 8)
);
--> statement-breakpoint
CREATE TABLE match_requests (
 owner_hash text NOT NULL,idempotency_key uuid NOT NULL,digest text NOT NULL,response jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(owner_hash,idempotency_key),
 CONSTRAINT match_request_hash_check CHECK(owner_hash ~ '^[a-f0-9]{64}$' AND digest ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE TABLE match_rate_limits (
 owner_hash text NOT NULL,bucket text NOT NULL,window_start timestamptz NOT NULL,request_count integer NOT NULL,
 PRIMARY KEY(owner_hash,bucket),
 CONSTRAINT match_rate_check CHECK(owner_hash ~ '^[a-f0-9]{64}$' AND bucket IN ('read','write') AND request_count>0)
);
