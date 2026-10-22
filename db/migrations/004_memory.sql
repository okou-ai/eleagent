-- Long-term memory, consolidated each night from the day's observations (lib/sleep.ts).

-- A day of the owner's life, in the time zone their phone reported, and how far its sleep has got.
CREATE TABLE IF NOT EXISTS sleep_days (
  day          date PRIMARY KEY,
  timezone     text NOT NULL,
  status       text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'done', 'failed')),
  attempts     integer NOT NULL DEFAULT 0,
  claimed_at   timestamptz,
  finished_at  timestamptz,
  cost_usd     numeric NOT NULL DEFAULT 0,
  error        text,
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- Stretches of continuous experience (split by gaps, movement and length), each digested once by a model.
CREATE TABLE IF NOT EXISTS episodes (
  id           text PRIMARY KEY,
  day          date NOT NULL,
  started_at   timestamptz NOT NULL,
  ended_at     timestamptz NOT NULL,
  minutes      jsonb NOT NULL,
  fingerprint  text NOT NULL,
  digest       jsonb,
  cost_usd     numeric,
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS episodes_day ON episodes (day, started_at);

-- Memories: people, objects, places, routines, readings, events, conversations and one diary per day. Ids read
-- like person:owner or diary:20261022, as in the self-hosted Eleagent's graph.
CREATE TABLE IF NOT EXISTS entities (
  id           text PRIMARY KEY,
  kind         text NOT NULL,
  name         text NOT NULL,
  properties   jsonb NOT NULL DEFAULT '{}',
  search_text  text NOT NULL DEFAULT '',
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS entities_kind ON entities (kind, updated_at);

-- One plain-language link per pair of memories (a < b).
CREATE TABLE IF NOT EXISTS entity_links (
  a           text NOT NULL REFERENCES entities (id) ON DELETE CASCADE,
  b           text NOT NULL REFERENCES entities (id) ON DELETE CASCADE,
  text        text NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (a, b),
  CHECK (a < b)
);
CREATE INDEX IF NOT EXISTS entity_links_b ON entity_links (b);
