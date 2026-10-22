-- Requests the owner spoke to Okou while recording, and what became of handing them over (lib/handoff.ts).
-- One row per minute at most, so reprocessing a minute never sends its request twice.
CREATE TABLE IF NOT EXISTS handoffs (
  capture_id      text NOT NULL,
  minute          timestamptz NOT NULL,
  heard_at        timestamptz NOT NULL,
  request         text NOT NULL,
  message         text NOT NULL,
  screen          text,
  status          text NOT NULL CHECK (status IN ('sending', 'sent', 'failed')),
  okou_thread_id  text,
  okou_event_id   text,
  error           text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (capture_id, minute),
  FOREIGN KEY (capture_id, minute) REFERENCES observations (capture_id, minute)
);
CREATE INDEX IF NOT EXISTS handoffs_created ON handoffs (created_at);
