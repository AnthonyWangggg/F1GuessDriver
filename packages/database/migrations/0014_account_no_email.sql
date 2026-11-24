ALTER TABLE identity_accounts ALTER COLUMN email DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE identity_accounts ADD COLUMN login_name text CONSTRAINT identity_accounts_login_name_unique UNIQUE, ADD COLUMN recovery_hash text, ADD COLUMN recovery_revision integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE identity_accounts DROP CONSTRAINT identity_verified_principal_check;
--> statement-breakpoint
ALTER TABLE identity_accounts ADD CONSTRAINT identity_verified_principal_check CHECK (principal_id IS NULL OR verified_at IS NOT NULL OR login_name IS NOT NULL), ADD CONSTRAINT identity_recovery_hash_check CHECK (recovery_hash IS NULL OR recovery_hash ~ '^[a-f0-9]{64}$'), ADD CONSTRAINT identity_login_name_check CHECK (login_name IS NULL OR (char_length(login_name) BETWEEN 3 AND 32 AND login_name=lower(btrim(login_name)) AND login_name !~ '[[:space:]@#]'));

--> statement-breakpoint
CREATE TABLE identity_recovery_requests(account_id uuid NOT NULL REFERENCES identity_accounts(id), request_key uuid NOT NULL, operation text NOT NULL CHECK(operation IN ('enroll','rotate')), created_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(account_id,request_key));
