-- What Eleagent heard and saw in each wall-clock minute of a capture (lib/perception.ts): the minute's speech, by
-- speaker, and a description of the scene from its stills and sound. A minute is queued when its clips arrive and
-- processed once the recording has moved on; clips that arrive late put it back in the queue.
CREATE TABLE IF NOT EXISTS observations (
  capture_id       text NOT NULL REFERENCES captures (id),
  minute           timestamptz NOT NULL,
  status           text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'done', 'failed')),
  attempts         integer NOT NULL DEFAULT 0,
  claimed_at       timestamptz,
  clip_count       integer NOT NULL DEFAULT 0,
  processed_clips  integer,
  started_at       timestamptz,
  ended_at         timestamptz,
  transcript       jsonb,
  perception       jsonb,
  summary          text,
  search_text      text,
  cost_usd         numeric,
  error            text,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (capture_id, minute)
);
CREATE INDEX IF NOT EXISTS observations_minute ON observations (minute);
CREATE INDEX IF NOT EXISTS observations_queue ON observations (status, updated_at) WHERE status <> 'done';

-- Clips recorded before this migration are queued too.
INSERT INTO observations (capture_id, minute, clip_count)
SELECT capture_id, date_trunc('minute', captured_at), count(*) FROM clips GROUP BY 1, 2
ON CONFLICT DO NOTHING;
