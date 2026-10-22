-- Owner sessions: the owner signs in with OWNER_PASSWORD; only a hash of each session token is stored.
CREATE TABLE IF NOT EXISTS sessions (
  token_hash   text PRIMARY KEY,
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  user_agent   text
);
CREATE INDEX IF NOT EXISTS sessions_expires ON sessions (expires_at);

-- Failed sign-ins per client address, to slow down password guessing.
CREATE TABLE IF NOT EXISTS sign_in_failures (
  address      text NOT NULL,
  at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sign_in_failures_address_at ON sign_in_failures (address, at);

-- A capture is one continuous recording from one camera; its clips are 5-second files in private Blob storage.
CREATE TABLE IF NOT EXISTS captures (
  id             text PRIMARY KEY,
  camera         text NOT NULL CHECK (camera IN ('front', 'back')),
  first_clip_at  timestamptz NOT NULL,
  last_clip_at   timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS clips (
  media_id       text PRIMARY KEY,
  capture_id     text NOT NULL REFERENCES captures (id),
  clip_seq       integer NOT NULL,
  captured_at    timestamptz NOT NULL,
  captured_end_at timestamptz,
  content_type   text NOT NULL,
  size_bytes     integer NOT NULL,
  pathname       text NOT NULL UNIQUE,
  meta           jsonb NOT NULL,
  uploaded_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (capture_id, clip_seq)
);
CREATE INDEX IF NOT EXISTS clips_captured_at ON clips (captured_at);
