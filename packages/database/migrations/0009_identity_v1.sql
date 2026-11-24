CREATE TABLE identity_principals (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),created_at timestamptz NOT NULL DEFAULT now());
--> statement-breakpoint
CREATE TABLE identity_accounts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),principal_id uuid UNIQUE REFERENCES identity_principals(id),
 username text NOT NULL,username_key text NOT NULL,tag text NOT NULL,email text NOT NULL UNIQUE,password_hash text NOT NULL,
 verified_at timestamptz,email_revision integer NOT NULL DEFAULT 0,created_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT identity_account_principal_uq UNIQUE(id,principal_id),CONSTRAINT identity_username_tag_uq UNIQUE(username_key,tag),CONSTRAINT identity_tag_check CHECK(tag ~ '^[0-9]{4}$'),
 CONSTRAINT identity_email_check CHECK(email=lower(btrim(email))),CONSTRAINT identity_verified_principal_check CHECK(principal_id IS NULL OR verified_at IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE identity_owners (
 owner_hash text PRIMARY KEY,principal_id uuid NOT NULL UNIQUE REFERENCES identity_principals(id),
 claimed_account_id uuid UNIQUE REFERENCES identity_accounts(id),created_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT identity_owner_principal_uq UNIQUE(owner_hash,principal_id),CONSTRAINT identity_owner_account_principal_fk FOREIGN KEY(claimed_account_id,principal_id) REFERENCES identity_accounts(id,principal_id),CONSTRAINT identity_owner_hash_check CHECK(owner_hash ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE TABLE identity_claims (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),account_id uuid NOT NULL UNIQUE REFERENCES identity_accounts(id),
 owner_hash text NOT NULL REFERENCES identity_owners(owner_hash),principal_id uuid NOT NULL REFERENCES identity_principals(id),
 proof_hash text NOT NULL UNIQUE,expires_at timestamptz NOT NULL,claimed_at timestamptz,
 CONSTRAINT identity_claim_owner_principal_fk FOREIGN KEY(owner_hash,principal_id) REFERENCES identity_owners(owner_hash,principal_id)
);
--> statement-breakpoint
CREATE UNIQUE INDEX identity_claim_once_uq ON identity_claims(principal_id) WHERE claimed_at IS NOT NULL;
--> statement-breakpoint
CREATE TABLE identity_sessions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),token_hash text NOT NULL UNIQUE,account_id uuid NOT NULL REFERENCES identity_accounts(id),
 expires_at timestamptz NOT NULL,revoked_at timestamptz,created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX identity_sessions_account_idx ON identity_sessions(account_id);
--> statement-breakpoint
CREATE TABLE identity_tokens (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),token_hash text NOT NULL UNIQUE,account_id uuid NOT NULL REFERENCES identity_accounts(id),
 purpose text NOT NULL,pending_email text,email_revision integer NOT NULL,expires_at timestamptz NOT NULL,used_at timestamptz,created_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT identity_token_purpose_check CHECK(purpose IN ('verify','reset','email'))
);
--> statement-breakpoint
CREATE INDEX identity_token_account_idx ON identity_tokens(account_id);
--> statement-breakpoint
CREATE TABLE identity_mail_outbox (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),token_id uuid NOT NULL UNIQUE REFERENCES identity_tokens(id),payload text NOT NULL,
 delivered boolean NOT NULL DEFAULT false,attempts integer NOT NULL DEFAULT 0,next_attempt_at timestamptz NOT NULL DEFAULT now(),created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX identity_mail_due_idx ON identity_mail_outbox(next_attempt_at) WHERE delivered=false;
--> statement-breakpoint
CREATE TABLE identity_rate_limits (scope text NOT NULL,subject_hash text NOT NULL,window_start timestamptz NOT NULL,request_count integer NOT NULL,
 PRIMARY KEY(scope,subject_hash),CONSTRAINT identity_rate_count_check CHECK(request_count>0));
--> statement-breakpoint
CREATE TABLE identity_requests (scope text NOT NULL,idempotency_key uuid NOT NULL,digest text NOT NULL,response jsonb NOT NULL,expires_at timestamptz NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(scope,idempotency_key));
