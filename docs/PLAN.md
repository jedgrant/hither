# Hither — project plan

> **Status:** v1 built in this repo (see README.md). This plan is the original spec; where the code differs, the README wins.

> Working name. A no-login invite app: make an invite (photo + title + date), send the link, get RSVPs and comments back.

**Goals:** a plain web app that opens instantly in any phone browser (no install), great looking, **$0/month with no credit card and almost no setup**, fast to build (≈4 focused days), and mild-but-real abuse protection.

---

## 1. Scope

### MVP (v1)
| Who | Can do |
|---|---|
| **Host** (no account) | See **their past and upcoming invites** saved on this device. Create an event with a **required cover image**, **title**, **date + time** (optional: location, note). Optionally **type in a guest list** (names, one per line). Each name gets a **personal link**. Choose who can RSVP: **anyone with the link** or **only my list** (others ask to join). Gets a public **share link** and a private **host link**. Sees who's going, who can't, **who hasn't replied**, and who **isn't on the list**. Can approve/decline join requests, hide comments, and **block** a guest. |
| **Guest** (no account) | **Must give a name before anything else.** Before that, they see only the cover, title, date and who invited them. Personal-link guests skip this ("Hi Jordan"). After that: taps **I'm in** / **Can't make it**, sees **who else is coming by name**, comments, adds to calendar. Recognized on return visits. |

### Explicitly out of v1
Accounts, **sending email/SMS** (hosts share links through their own texts/chats, which keeps the service free and setup-free; see §9), "maybe" status, plus-ones, multiple hosts, image galleries, notifications. (Each is a small add later — see §9.)

---

## 2. Stack — free, two moving parts, fast in the browser

**The whole backend is one Cloudflare Worker + one D1 database.** No image bucket, no Redis, no separate frontend host, no domain required. Free tier, **no credit card** (R2 storage was dropped because enabling it needs a card on file).

| Piece | Choice | Why |
|---|---|---|
| Hosting + API | **Cloudflare Worker** + **Hono** | Free 100k requests/day. Deploys to `hither.<you>.workers.dev` — no domain to buy. |
| Static files | **Workers static assets** (CSS, JS, fonts) | Free and **unlimited**; don't count against the request quota. |
| Database **and images** | **D1** (SQLite) | Free 5 GB, 5M row reads/day. Cover photos are small WebP blobs (≤ 400 KB) stored in an `images` table, so there's nothing else to provision. |
| Bot check | **Turnstile** (invisible) | Free, no card. The one dashboard step: create a widget, paste 2 keys. |
| Rate limiting | **D1 counters** + Workers rate-limit binding (config only) | No extra service. |
| Cleanup | **Cron Trigger** in `wrangler.toml` | Deletes events (and their images) 30 days after the date. That's what keeps storage permanently tiny. |

**Setup, start to finish:**
```bash
npm create hono@latest hither -- --template cloudflare-workers
npx wrangler d1 create hither
npx wrangler d1 migrations apply hither --remote
npx wrangler secret put TURNSTILE_SECRET   # + IP_HMAC_SECRET
npx wrangler deploy
```

**What "free" covers:** 100k page views + API calls a day. At ~5 requests per guest visit (static assets don't count), that's roughly **20,000 guest visits per day**. Storage: 5 GB ÷ ~250 KB per invite ≈ **20,000 live invites**, and the 30-day purge keeps it far below that. If it ever outgrows this, Workers Paid is $5/mo. That's the only upgrade path, and it's opt-in.

### Fast in the browser (performance budget)
Most guests tap a link on their phone, often on cell data, so the invite page should feel instant.

| Asset | Budget | How |
|---|---|---|
| HTML | ≤ 15 KB | Server-rendered with all data in place: no loading spinners and no API call before first paint. Open Graph tags are in the HTML for iMessage/WhatsApp previews. |
| CSS | ~20 KB raw, ~5 KB compressed | One hand-written file from `tokens.css`, cached by the browser. |
| JS | ~10 KB on guest pages | Vanilla ES modules, no framework. Each page loads only its own script; the larger dashboard script loads only for hosts. |
| Fonts | ~97 KB preloaded (+46 KB italic, loaded only where used) | **Self-hosted** Latin-subset WOFF2 files (Fraunces variable with optical size, Fraunces italic, Geist variable), `preload` + `font-display: swap`. No Google Fonts request. Cached by the browser after the first visit. |
| Cover photo | ~150–250 KB | Resized **in the browser before upload** to 1600 px WebP; also a **400 px thumbnail** (~20 KB) for the "Your invites" list and dashboard. Explicit width/height so the layout never jumps. Served with `Cache-Control: immutable`, so return visits load it from the browser cache. |

Target: **first paint < 1 s on 4G, Lighthouse ≥ 95.** No framework runtime, no third-party scripts except Turnstile, which only loads when you submit a form.

---

## 3. Identity without authentication

### Host = capability link
- On create, server generates a 32-byte random `hostKey`; stores only `sha256(hostKey)`.
- Host link: `https://hither.app/e/{slug}/manage#k={hostKey}`
  - Key lives in the **URL fragment** → never sent in server logs, analytics, or `Referer` headers. Page JS reads it and sends it as an `X-Host-Key` header.
  - Also saved to `localStorage` on the creating device, so the host is auto-recognized there.
- The share screen loudly says: *"Save this link — it's the only key to manage your invite."* (Copy + native share sheet.)

### "Your invites" — hosts find their events again (localStorage)
No accounts means no "my events" page on the server, so the browser keeps the list.

- On successful create, the client saves an entry to `localStorage["hither:hosted"]`:
  ```json
  [{ "slug": "k7m2q9xd4r", "hostKey": "…", "title": "Rooftop Supper Club",
     "startsAt": "2026-12-07T02:30:00Z", "tz": "America/Denver",
     "image": "/img/…webp", "savedAt": "2026-11-17T…" }]
  ```
- Opening any host link (`/manage#k=…`) on a new device **adds** it to that device's list too — so a host who emails themselves the link gets the list back on their phone.
- The landing page shows a **"Your invites"** strip above the create form when the list is non-empty: thumbnail, title, date, live counts (fetched in one batched call, `POST /api/hosted/summary` with the slugs + keys), split into *Upcoming* and *Past*.
- Each row: open dashboard · copy share link · **Remove from this device** (local only, the event is untouched).
- Title/date edits on the dashboard update the cached entry; events that 404 (purged/deleted) are pruned automatically with a quiet note.
- Wrap every `localStorage` access in `try/catch` (private mode / Safari ITP can throw or wipe it). The list is a **convenience, not the source of truth** — the share screen still pushes hosts to save the host link.
- Security: the host key now sits in localStorage, so XSS would expose it. The strict CSP, escaped rendering, and no third-party scripts (§4) are what make this acceptable. The key is per-event, so a leak can't touch other invites.
- Optional, same mechanism: `hither:answered` for guests — "Invites you've replied to" (slug + title + date only, no secrets).

### Guests: name first, always
Every guest is a **named person** before they can do anything. That's what lets everyone see who's coming, and lets the host spot people who weren't invited.

**Two ways in:**

| Way in | What the guest sees | Trust level |
|---|---|---|
| **Personal link** `/e/{slug}?g={token}` (host added them to the list) | "Hi Jordan, Ana saved you a spot." No name prompt; straight to the RSVP buttons. | **Invited.** The token is the proof. |
| **Shared link** `/e/{slug}` | **Name gate:** cover, title, date and "Ana invited you", then *"What's your name?"*. Location, note, guest list, comments and RSVP stay hidden until they answer. | **Self-named.** Anyone can type any name, so the host sees a *Not on your list* tag whenever the event has a list. |

**Two access modes** (host picks; default = *Anyone with the link*):
- **Anyone with the link:** self-named guests are in immediately. Good for casual parties.
- **Only my list:** self-named guests become **Asking to join**. They see "Thanks, Sam. Ana will let you in" and nothing else (no address, no guest list) until the host taps **Approve**. Declined people see the same waiting screen indefinitely (shadow-style, no rejection message).

**Recognition mechanics:**
- Entering a name (or opening a personal link) is a **POST** to `/api/e/:slug/join`. It creates the guest row and sets the `gid` cookie (128-bit random, `HttpOnly; Secure; SameSite=Lax; Max-Age=400d`, stored hashed). Turnstile runs on this call, so bots can't create guests.
- **GETs never create guests.** Link-preview bots (iMessage, Slack, Facebook) only ever see the gated page.
- Personal link + new device: the token re-binds that device to the same guest. Personal links survive cleared cookies, which fixes duplicates for listed guests.
- **Changed in build:** when the host has added names, the shared link asks for a **first name**. A match adopts that listed guest on that device, and keeps doing so on every device that enters the same first name. Hosts don't have to send personal links. Duplicate first names need a last initial when added; the guest is then asked for theirs. Nicknames that don't match can still be merged by hand. Trade-off accepted by the owner: anyone who knows a listed first name can act as that guest. The host sees the device count and can use **Make a new link** to sign all devices out.
- Lost cookie on the shared link = enter the name again → new row; the host can merge or delete.

**What guests can see about each other** (after the name gate):
- **Going:** first names + initials avatars, full list. **Can't make it:** count only by default (less awkward). Comments show the author's name and RSVP tag.
- Host toggle: *Show guest list to guests* (on by default). When it's off, guests see counts only.
- Never shown to guests: who hasn't replied, pending requests, blocked people, anything on the host's list.

### Emails?
v1 takes **names only**. Collecting emails without sending anything adds friction and stores personal data for no benefit. Sending email needs a provider with a verified domain (e.g. Resend's free tier), which is setup and a domain to own, so it moves to §9. The host shares each personal link through their own texts and chats: **Copy link** / **Share** buttons per name, plus **Copy all**, which copies "Jordan: link" lines for pasting into a group chat.

---

## 4. Abuse protection (mild, layered, cheap)

| Threat | Defense |
|---|---|
| Spam event creation | Turnstile on create · **5 events / IP / day** · **20 / day** per /24 (IPv4) or /48 (IPv6). |
| RSVP / comment flooding | Turnstile token on a guest's **first** write only · burst limit **10 writes / min / IP** (rate-limit binding) · **20 comments / guest / event / day** (D1 count) · **200 guests per event** cap. |
| Junk/huge uploads | Client resizes to max 1600 px **WebP ~200 KB** before upload · server rejects > 400 KB (cover) / 40 KB (thumb) · validates **magic bytes** (JPEG/PNG/WebP only) · stored under random key, never user filename · served with `Content-Type` forced + `X-Content-Type-Options: nosniff`. |
| XSS / injection via comments | Plain text only, escaped on render, no auto-linking, 500 char max, collapse runs of newlines. Strict **CSP** (`default-src 'self'`). |
| Event enumeration | Slugs are 10 random base32 chars (not sequential, not title-based). Pages send `X-Robots-Tag: noindex`. |
| A troll on your invite | **Host block** (below). |
| Abusive images | "Report" link in footer → flags event (hidden after 3 reports until reviewed); manual takedown via `wrangler d1 execute`. If you add a custom domain later, turn on Cloudflare's free CSAM scanning tool. |

### Blocking without accounts
IP alone is weak (mobile carriers share IPs; IPv6 rotates; home Wi-Fi is shared with family). So a block records **both** signals:

1. the guest's `gid_hash` (catches them on the same browser, even on a new network), and
2. their **network hash** — `HMAC(secret, IPv4)` or `HMAC(secret, IPv6 /64 prefix)` (catches a cleared cookie on the same network).

Privacy: raw IPs are **never stored**, only HMACs with a server secret.

**Soft/shadow block** (the scrappy trick that makes this work): a blocked guest's page looks totally normal. Their RSVP "succeeds" and their comments appear *to them*, but they're stored with `shadow=1` and are invisible to everyone else and excluded from counts. No "you've been blocked" message to provoke evasion. Host can unblock any time.

---

## 5. Data model (D1)

```sql
CREATE TABLE events (
  id            TEXT PRIMARY KEY,          -- ulid
  slug          TEXT UNIQUE NOT NULL,      -- 10-char random base32
  title         TEXT NOT NULL,             -- ≤ 80
  starts_at     TEXT NOT NULL,             -- UTC ISO-8601
  tz            TEXT NOT NULL,             -- IANA, e.g. America/Denver
  location      TEXT,                      -- ≤ 120
  note          TEXT,                      -- ≤ 500
  image_id      TEXT NOT NULL,             -- images.id (cover)
  thumb_id      TEXT NOT NULL,             -- images.id (400px thumb)
  image_w INT, image_h INT,
  host_key_hash TEXT NOT NULL,
  creator_net   TEXT NOT NULL,             -- network hash, for create limits
  host_name     TEXT NOT NULL,             -- "Ana", shown as "Ana invited you"
  access        TEXT NOT NULL DEFAULT 'open', -- open | list
  show_guests   INT  NOT NULL DEFAULT 1,   -- guests can see who's going
  status        TEXT NOT NULL DEFAULT 'live', -- live | reported | removed
  created_at    TEXT NOT NULL,
  purge_after   TEXT NOT NULL              -- starts_at + 30 days
);

CREATE TABLE images (
  id         TEXT PRIMARY KEY,             -- random; also the URL path
  event_id   TEXT,                         -- set once the event is created
  mime       TEXT NOT NULL,                -- image/webp | image/jpeg
  bytes      BLOB NOT NULL,                -- ≤ 400 KB (cover) / 40 KB (thumb)
  created_at TEXT NOT NULL
);

CREATE TABLE guests (
  id         TEXT PRIMARY KEY,
  event_id   TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,                -- ≤ 40
  source     TEXT NOT NULL,                -- list (host added) | link (self-named)
  invite_token TEXT UNIQUE,                -- personal link token (list guests only). Stored plain so
                                           -- the host can re-copy links from any device; only returned
                                           -- with the host key, and Relink rotates it.
  access     TEXT NOT NULL DEFAULT 'in',   -- in | pending | declined
  rsvp       TEXT,                         -- yes | no | NULL (no reply yet)
  shadow     INT  NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- a guest can be bound to several devices (personal link opened on phone + laptop)
CREATE TABLE guest_devices (
  guest_id   TEXT NOT NULL REFERENCES guests(id) ON DELETE CASCADE,
  event_id   TEXT NOT NULL,
  gid_hash   TEXT NOT NULL,
  net_hash   TEXT NOT NULL,
  last_seen  TEXT NOT NULL,
  PRIMARY KEY (event_id, gid_hash)
);

CREATE TABLE comments (
  id         TEXT PRIMARY KEY,
  event_id   TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  guest_id   TEXT NOT NULL REFERENCES guests(id) ON DELETE CASCADE,
  body       TEXT NOT NULL,                -- ≤ 500
  hidden     INT  NOT NULL DEFAULT 0,      -- host hid it
  shadow     INT  NOT NULL DEFAULT 0,      -- author blocked at write time
  created_at TEXT NOT NULL
);

CREATE TABLE blocks (
  event_id   TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL,                -- gid | net
  value_hash TEXT NOT NULL,
  guest_id   TEXT,                         -- who triggered it (for unblock UI)
  created_at TEXT NOT NULL,
  PRIMARY KEY (event_id, kind, value_hash)
);

CREATE INDEX idx_comments_event ON comments(event_id, created_at);
CREATE INDEX idx_events_purge   ON events(purge_after);
CREATE INDEX idx_events_creator ON events(creator_net, created_at);
```

---

## 6. Routes

| Method | Path | Notes |
|---|---|---|
| GET | `/` | Landing + create form; "Your invites" strip rendered client-side from localStorage. |
| POST | `/api/hosted/summary` | `[{slug, hostKey}]` (≤ 50) → title, date, image, going/can't counts for each valid pair. Rate-limited. |
| POST | `/api/events` | multipart: `image` (1600 px WebP), `thumb` (400 px WebP), `title`, `date`, `time`, `tz`, `location?`, `note?`, `cf-turnstile-response`. Returns `{slug, hostKey}`. |
| GET | `/e/:slug` | Invite page, SSR, OG/Twitter meta (`og:image` = cover, title only, never the location). No/unknown `gid` → **name gate**. Pending → waiting screen. In → full invite with "welcome back", all rendered on the server with no flash. |
| GET | `/e/:slug/cal.ics` | Calendar file. |
| GET | `/img/:id.webp` | Reads the blob from D1 (1 row read), `Cache-Control: public, max-age=31536000, immutable`. With a custom domain, the Worker also puts it in Cloudflare's edge cache. (The Cache API is a no-op on `workers.dev`, but browser caching still applies.) |
| GET | `/e/:slug?g=token` | Personal link. Page JS POSTs the token to `/join`, then strips `?g=` from the URL bar so it isn't screenshotted or re-shared. |
| POST | `/api/e/:slug/join` | `{name}` or `{token}` + Turnstile → creates/binds guest, sets `gid`. Returns `in` or `pending`. Rate-limited per network. |
| POST | `/api/e/:slug/rsvp` | `{rsvp}`; requires a guest with `access = in`. |
| POST | `/api/e/:slug/comments` | `{name?, body}`. |
| GET | `/e/:slug/manage` | Host dashboard shell; data loaded with `X-Host-Key`. |
| GET | `/api/e/:slug/host` | Guests (incl. shadowed), all comments, block list. |
| PATCH | `/api/e/:slug` | Edit event, access mode, show-guests toggle (host). |
| POST | `/api/e/:slug/guests` | Host adds names (`["Jordan Lee", …]`, ≤ 200) → returns a personal link per name. Links can be re-copied from the dashboard at any time. |
| POST | `/api/e/:slug/guests/:id/approve` / `decline` / `merge` / `relink` | Join requests, merging a self-named guest into a list entry, issuing a fresh personal link. |
| POST | `/api/e/:slug/block` / `unblock` | `{guestId}` → writes gid + net blocks, flips `shadow` on that guest's rows. |
| POST | `/api/e/:slug/comments/:id/hide` | Host hides/unhides. |
| DELETE | `/api/e/:slug/guests/:id` | Remove duplicate/garbage guest. |
| DELETE | `/api/e/:slug` | Host deletes event (+ its images). |
| POST | `/api/e/:slug/report` | Anyone; rate-limited; flags for review. |

Cron (daily): delete events where `purge_after < now` (images cascade), plus orphaned images older than 1 hour (uploads where the create step was abandoned).

---

## 7. Build plan

| Day | Deliverable |
|---|---|
| **1 — Skeleton & create** | Hono template; D1 schema + migrations; create form with client-side image resize (canvas → 1600 px WebP + 400 px thumb); `POST /api/events`; share screen with host link. Deploy to `*.workers.dev` on day 1. |
| **1.5** | "Your invites" list: save on create, save on opening a host link, summary endpoint, remove-from-device. (~half day, folds into Day 1–2.) |
| **2 — Guest flow** | Invite page SSR + OG tags; **name gate** + `/join`; personal links; `gid` cookie; RSVP + comments; welcome-back state; **who's coming list**; .ics. |
| **3 — Host & protection** | **Guest list entry + per-name links; access modes; approve/decline/merge**; manage page (guests / comments tabs); hide, block (shadow), unblock, delete; Turnstile; rate-limit binding; daily caps; upload validation; CSP + security headers; report flow. |
| **4 — Polish & ship** | Empty/edge states (past event, removed, not found, rate-limited toast); mobile QA on iOS Safari + Android Chrome; link-preview QA (iMessage, WhatsApp, Slack); cron purge; self-hosted font subsets; Lighthouse pass (≥ 95 mobile). Custom domain optional. |

**Repo layout**
```
hither/
  src/
    index.tsx         # Hono app + routes
    views/            # JSX pages: Create, Share, Invite, Manage, States
    lib/              # ids, hashing, ratelimit, turnstile, ics, validate
  public/
    app.js            # tiny client: resize upload, RSVP, comments, copy/share
    styles.css        # from design/tokens.css (inlined into <head> at build)
    fonts/            # self-hosted WOFF2 subsets
  migrations/0001_init.sql
  design/             # tokens + mockups (this phase)
  wrangler.toml
```

---

## 8. Risks & decisions

- **Host loses host link** → no recovery in v1 (that's the cost of no auth). Mitigation: the "Your invites" localStorage list + loud save prompt. Clearing site data or switching devices loses the list, so the host link stays the real backup. v1.1 optional "email me my host link".
- **Impersonation on the shared link**: anyone can type "Jordan". Mitigations: the *Not on your list* tag, no auto-merge, *Only my list* mode for events that matter. Personal links are the trusted path.
- **Personal links get forwarded**: a forwarded link logs the recipient in as that guest. The host sees "opened on 2 devices" and can **Relink**, which kills the old token.
- **Cookie-cleared guests duplicate**: shared-link guests only; the host can merge or delete.
- **Shared networks** → a net-block could catch a blocked person's roommate. Acceptable for "mild" protection; host can unblock; block is per-event only.
- **HEIC from iPhones** → most browsers can't decode HEIC to canvas; iOS Safari converts on file pick automatically, so this is mostly fine. Fallback: reject with a friendly message.

## 9. Easy next steps after v1
1. **Email invites + reminders** via Resend's free tier (3k/mo). Needs a verified domain, so it's opt-in for hosts who want it.
2. "Maybe" + plus-ones.
3. Email/SMS-free "nudge": host copies a reminder message with the link.
4. Host notification via Web Push when someone RSVPs.
5. Themes (font + color pairs) per invite.
