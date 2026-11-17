-- Hither schema. Everything (including cover photos) lives in one D1 database.

CREATE TABLE meta (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);

CREATE TABLE events (
  id            TEXT PRIMARY KEY,
  slug          TEXT UNIQUE NOT NULL,
  title         TEXT NOT NULL,
  host_name     TEXT NOT NULL,
  starts_at     TEXT NOT NULL,             -- UTC ISO-8601
  local_date    TEXT NOT NULL,             -- YYYY-MM-DD as the host typed it
  local_time    TEXT NOT NULL,             -- HH:MM as the host typed it
  tz            TEXT NOT NULL,             -- IANA zone
  location      TEXT,
  note          TEXT,
  image_id      TEXT NOT NULL,
  thumb_id      TEXT NOT NULL,
  image_w       INTEGER,
  image_h       INTEGER,
  host_key_hash TEXT NOT NULL,
  creator_net   TEXT NOT NULL,
  access        TEXT NOT NULL DEFAULT 'open',   -- open | list
  show_guests   INTEGER NOT NULL DEFAULT 1,
  status        TEXT NOT NULL DEFAULT 'live',   -- live | reported | removed
  created_at    TEXT NOT NULL,
  purge_after   TEXT NOT NULL
);
CREATE INDEX idx_events_purge ON events(purge_after);

CREATE TABLE images (
  id         TEXT PRIMARY KEY,
  event_id   TEXT REFERENCES events(id) ON DELETE CASCADE,
  mime       TEXT NOT NULL,
  bytes      BLOB NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_images_event ON images(event_id);

CREATE TABLE guests (
  id           TEXT PRIMARY KEY,
  event_id     TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  source       TEXT NOT NULL,                  -- list | link
  invite_token TEXT UNIQUE,                    -- personal link token (list guests)
  access       TEXT NOT NULL DEFAULT 'in',     -- in | pending | declined
  rsvp         TEXT,                           -- yes | no | NULL
  shadow       INTEGER NOT NULL DEFAULT 0,     -- blocked: invisible to everyone else
  opened_at    TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE INDEX idx_guests_event ON guests(event_id);

CREATE TABLE guest_devices (
  event_id  TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  gid_hash  TEXT NOT NULL,
  guest_id  TEXT NOT NULL REFERENCES guests(id) ON DELETE CASCADE,
  net_hash  TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  PRIMARY KEY (event_id, gid_hash)
);
CREATE INDEX idx_devices_guest ON guest_devices(guest_id);

CREATE TABLE comments (
  id         TEXT PRIMARY KEY,
  event_id   TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  guest_id   TEXT REFERENCES guests(id) ON DELETE CASCADE,  -- NULL = host
  body       TEXT NOT NULL,
  hidden     INTEGER NOT NULL DEFAULT 0,
  shadow     INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_comments_event ON comments(event_id, created_at);

CREATE TABLE blocks (
  event_id   TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL,          -- gid | net
  value_hash TEXT NOT NULL,
  guest_id   TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (event_id, kind, value_hash)
);

CREATE TABLE reports (
  event_id   TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  net_hash   TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (event_id, net_hash)
);

-- fixed-window rate-limit counters
CREATE TABLE hits (
  k   TEXT NOT NULL,
  win INTEGER NOT NULL,
  n   INTEGER NOT NULL,
  PRIMARY KEY (k, win)
);
