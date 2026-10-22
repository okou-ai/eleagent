-- Sleep is now an agent run (Pi in a Vercel Sandbox, lib/sleep-run.ts). Each run calls back to this app with a token
-- that the sandbox's firewall injects (only its hash is kept), and records what became of each conversation
-- candidate ("talk"): remembered as a conversation, or dismissed with a reason.
ALTER TABLE sleep_days ADD COLUMN IF NOT EXISTS run_token_hash text;
ALTER TABLE sleep_days ADD COLUMN IF NOT EXISTS sandbox text;
ALTER TABLE sleep_days ADD COLUMN IF NOT EXISTS started_at timestamptz;
ALTER TABLE sleep_days ADD COLUMN IF NOT EXISTS talks jsonb NOT NULL DEFAULT '{}';
CREATE UNIQUE INDEX IF NOT EXISTS sleep_days_run ON sleep_days (run_token_hash) WHERE run_token_hash IS NOT NULL;

-- Episodes are computed when the agent asks for them; the per-episode digests of the first design are gone.
DROP TABLE IF EXISTS episodes;
