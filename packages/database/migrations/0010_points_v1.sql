CREATE TABLE points_rule_activations (
  version text PRIMARY KEY,
  effective_at timestamptz NOT NULL,
  rule_summary text NOT NULL,
  approved_by text NOT NULL CHECK (length(btrim(approved_by))>0),
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE points_balances (
  principal_id uuid PRIMARY KEY REFERENCES identity_principals(id),
  balance integer NOT NULL DEFAULT 0,
  revision integer NOT NULL DEFAULT 0,
  CONSTRAINT points_balance_nonnegative CHECK (balance>=0 AND revision>=0)
);
--> statement-breakpoint
CREATE TABLE points_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  principal_id uuid NOT NULL REFERENCES identity_principals(id),
  rule_version text NOT NULL REFERENCES points_rule_activations(version),
  source_kind text NOT NULL,
  source_id uuid NOT NULL,
  reward_kind text NOT NULL,
  nominal_delta integer NOT NULL,
  actual_delta integer NOT NULL,
  balance_after integer NOT NULL,
  revision integer NOT NULL,
  business_date date NOT NULL,
  effective_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT points_source_participant_uq UNIQUE(source_kind,source_id,principal_id),
  CONSTRAINT points_principal_revision_uq UNIQUE(principal_id,revision),
  CONSTRAINT points_ledger_values CHECK (balance_after>=0 AND revision>0 AND (
    (source_kind='daily-v2' AND reward_kind='success' AND nominal_delta=1 AND actual_delta=1) OR
    (source_kind='match-v2-bo3' AND reward_kind='win' AND nominal_delta=3 AND actual_delta=3) OR
    (source_kind='match-v2-bo3' AND reward_kind='loss' AND nominal_delta=-1 AND actual_delta IN (-1,0))
  ))
);
--> statement-breakpoint
CREATE INDEX points_daily_idx ON points_ledger(business_date,principal_id);
