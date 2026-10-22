-- Requests can now be spoken to Okou directly ("Hey Okou", or a tap on the Okou mark), not only found in a processed
-- minute, so a handoff has its own id and need not belong to one minute; per-minute ones stay unique per minute.
ALTER TABLE handoffs DROP CONSTRAINT IF EXISTS handoffs_capture_id_minute_fkey;
ALTER TABLE handoffs DROP CONSTRAINT IF EXISTS handoffs_pkey;
ALTER TABLE handoffs ADD COLUMN IF NOT EXISTS id bigserial PRIMARY KEY;
ALTER TABLE handoffs ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'minute' CHECK (source IN ('minute', 'spoken'));
ALTER TABLE handoffs ALTER COLUMN capture_id DROP NOT NULL;
ALTER TABLE handoffs ALTER COLUMN minute DROP NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS handoffs_minute ON handoffs (capture_id, minute) WHERE source = 'minute';
