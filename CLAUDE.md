# Hither: instructions for Claude

No-login invite app: a host makes an invite (photo + title + date), shares a link, and collects RSVPs and comments. Guests must give a name before seeing anything. Hosts can add a guest list with personal links.

- Live: https://hither.jed-grant.workers.dev (Worker `hither`, D1 database `hither`)
- Repo: https://github.com/jedgrant/hither (public, branch `main`)
- Product spec: `docs/PLAN.md`. Visual mockups: `docs/design/index.html`. Setup and ops: `README.md`.

## Non-negotiable constraints
The owner wants this **free to run, minimal setup, fast in the browser**. Before adding anything, check that it keeps all three.
- **Only Cloudflare Workers + D1 (+ Turnstile).** No R2 (needs a card), KV, Durable Objects, queues, paid APIs, or third-party services. Photos live in D1 as blobs.
- **No frontend framework, no build step for the client.** Plain ES modules in `public/js/`, one CSS file. Don't add React, Tailwind, bundlers, or npm packages for the browser.
- **Server-rendered HTML** for guest-facing pages. Link previews (iMessage, WhatsApp, Slack) need the title and photo in the first response; crawlers don't run JS.
- **Keep guest pages light:** about 10 KB of JS and one stylesheet. The dashboard script (`manage.js`) loads only for hosts.
- **Mobile-first.** Most guests arrive from a text message.

## Commands
```bash
npm run dev                 # wrangler dev (local Worker + local D1)
npm run typecheck           # tsc --noEmit: run after every server change
npm run db:migrate:local    # apply migrations/ to the local DB
npm run db:migrate:remote   # apply migrations/ to the LIVE DB
npm run deploy              # deploy to Cloudflare (live site)
npm run fonts               # recopy WOFF2 subsets from npm into public/fonts
```
There is no test suite. Verify with curl against a local server and in the browser (see Testing).

## Layout
```
src/index.ts         Hono app: middleware (security headers), all routes, host actions, cron cleanup
src/lib/data.ts      Row types + shared D1 queries (event, guest-by-device/token, visibility-filtered lists)
src/lib/util.ts      ids/tokens, sha256/HMAC, IP→network hashing, rate limiter, Turnstile verify,
                     text cleaning, time-zone math, image magic-byte sniffing
src/views/pages.ts   HTML via hono/html tagged templates: layout, home, invite (gate/waiting/in), manage shell, message pages
public/app.css       All styles. Tokens at :root mirror docs/design/tokens.css
public/js/lib.js     Browser helpers: h() DOM builder, api(), toast, sheet(), localStorage store, hosted list
public/js/home.js    "Your invites" list + create form (client-side image resize)
public/js/invite.js  Guest page: name gate, personal-link binding, RSVP, comments, report
public/js/manage.js  Host dashboard (client-rendered from GET /api/e/:slug/host)
public/icons.svg     SVG sprite: <use href="/icons.svg#name">
migrations/          D1 schema (numbered .sql files)
wrangler.toml        Worker config: assets dir, D1 binding, cron, TURNSTILE_SITEKEY
```

## How identity works (read before touching auth-ish code)
- **Host** = capability key. Created on create, stored as `sha256` in `events.host_key_hash`. The browser sends it in the `X-Host-Key` header. The host link carries it in the URL **fragment** (`/e/:slug/manage#k=…`) so it never reaches server logs. `manage.js` strips it from the address bar and keeps it in localStorage (`hither:hosted`). Host routes call `host(c)` in `index.ts`. The dashboard's "Host access link" sheet shares or copies it to other devices. `POST /api/e/:slug/host-key` replaces the key, so all older host links stop working.
- **Guest** = `hg` cookie (random, HttpOnly, 400 days). Stored hashed in `guest_devices`, which maps (event, device) → guest. A guest can have several devices.
- **Guests are created only by `POST /api/e/:slug/join`**, never by a GET. Link-preview bots must not become guests.
  - Shared link: `{ name, initial?, turnstile }`. If the host added names, the gate asks for a **first name** and matches it against the list (`nameParts()` in `util.ts`: first word, case/accent-insensitive). One match **adopts that listed guest on this device, every time, on any device**, which is the owner's choice: no "claimed once". Two listed people with the same first name return `{ need: "initial" }` *before* Turnstile is checked, so the same token works for the follow-up with the last initial. `POST /guests` refuses names that `namesClash()` with an existing one. Blocked devices or networks never adopt a listed guest. No match creates `source='link'`; access is `in`, or `pending` if the event is `access='list'`.
  - `guests.joined_via` (`token` | `name`) records how a listed guest first arrived; the dashboard shows "Personal link" or "Matched by name".
  - Personal link: `{ token }` binds this device to the host-added guest (`source='list'`, `invite_token`). No Turnstile; the token is the proof.
- **Invite page states** (`invitePage`): `gate` (no guest: photo/title/date only), `waiting` (pending/declined), `in` (full page). Location, guest list and comments must never render in `gate` or `waiting`, and never in OG tags.
- **Blocking is silent** (`shadow = 1` on the guest and their comments, plus `blocks` rows for their device and network hashes). A blocked guest still sees their own stuff. Every visibility query filters `shadow = 0 OR id = me`. Keep that pattern in any new query that shows guests or comments to other guests.
- Raw IPs are never stored. `netIds()` returns HMACs; the HMAC key is auto-created in the `meta` table.

## Conventions
- **Escaping:** server HTML uses `html` from `hono/html`, which auto-escapes interpolations. Never use `raw()` with user data. Browser code builds DOM with `h()` / `textContent`. **Never use `innerHTML`.**
- **CSP is strict** (set in the middleware in `index.ts`): scripts only from `'self'` and `challenges.cloudflare.com`; no inline `<script>`. Put new JS in `public/js/*.js` and load it via `layout({ script })`. Inline `style` attributes are allowed.
- **Input cleaning:** `cleanLine(value, max)` for single-line fields, `clean(value, max)` for multi-line text. Limits: title 80, names 40, location 120, note/comment 500.
- **Errors:** throw with `fail(status, "Friendly sentence.")`. The `onError` handler returns `{ error }` JSON, and the browser shows `e.message` directly. Write messages for end users.
- **Rate limits:** `await limit(c, key, max, windowSec, msg?)` (fixed window in the `hits` table). Every new write endpoint needs one. Key by network (`net`) or guest id.
- **Batch multi-statement writes** with `db.batch([...])` (transactional).
- **Copy tone:** short, warm, plain. No emojis anywhere in the UI.
- **Design:** use the existing tokens and classes in `app.css` (`.card`, `.btn.primary/.ink/.ghost`, `.grp`, `.gr`, `.pill`, `.tag`, `.bsheet`…). Fonts: Fraunces (display) and Geist (UI). One accent colour (`--accent`) for primary actions. Check new screens against `docs/design/index.html`.

## Making common changes
- **New column/table:** add `migrations/000N_name.sql` (never edit `0001_init.sql`), update the types in `src/lib/data.ts`, run `npm run db:migrate:local`, test, then `npm run db:migrate:remote` **before** `npm run deploy`.
- **New guest-facing field:** decide which states may show it (gate/waiting/in) and whether it's safe in OG tags (usually not).
- **New host action:** add a branch in `POST /api/e/:slug/guests/:id/:action` or a new route that calls `host(c)` first. Then add the control in `manage.js` and call it through `act(() => post(...), "Toast text")`, which reloads data and re-renders.
- **CSS/JS changes:** static assets are served with ETags, so browsers revalidate. Bump `ASSET_V` in `src/views/pages.ts` if you need to force a refresh.
- **Fonts:** only the three files in `public/fonts`. Adding weights or families costs page weight; ask first.

## Testing
- **Dev server:** the Claude desktop preview launcher can't start processes on the external drive. Start the server with Bash `run_in_background`:
  `cd /Volumes/External/projects/hither-app && exec npx wrangler dev --port 8788 --ip 127.0.0.1`
  Then attach the browser with `preview_start` name `hither-app` (`.claude/launch.json` points at `http://127.0.0.1:8788`).
- **Local Turnstile** uses Cloudflare's test keys from `.dev.vars` (copy from `.dev.vars.example`). From curl, pass the dummy token `XXXX.DUMMY.TOKEN.XXXX` as `cf-turnstile-response` (create) or `turnstile` (join).
- **Creating an invite with curl** needs two real JPEG/WebP files (`image`, `thumb`). Make them with `sips`. Use a cookie jar (`-c/-b`) per simulated guest.
- **Uploads in the browser:** the file input can't be automated directly. Fetch an existing `/img/:id` into a `File`, set it via `DataTransfer`, and dispatch `change`.
- **Inspect or reset the local DB:** `npx wrangler d1 execute hither --local --command "…"`. Clear rate limits with `DELETE FROM hits`. Trigger the cron with `curl http://127.0.0.1:8788/cdn-cgi/local/scheduled`.
- **Turnstile in the Claude browser pane** shows "Verify you are human" or fails with 600010 because the pane is automated. That's expected; never try to solve it. The owner verifies in normal Chrome, where it passes invisibly.
- Check at phone width (`resize_window` preset `mobile`), then reset to desktop.

## Gotchas already hit (don't reintroduce)
- Responses from `caches.default` have immutable headers. The header middleware re-wraps `c.res`; keep that line.
- `Referrer-Policy` must stay `strict-origin-when-cross-origin`. `same-origin` breaks Turnstile.
- The Cache API is a no-op on `*.workers.dev`. Images still get `immutable` browser caching.
- Bind D1 blobs as `ArrayBuffer` (`uint8.buffer`). Read them back with `new Uint8Array(row.bytes)`.
- Safari can't encode WebP from canvas, so `home.js` falls back to JPEG. The server accepts only JPEG/WebP (magic bytes).
- Don't pass `null` straight to `replaceChildren()`; it renders the text "null". `h()` filters null children, so wrap lists or `.filter(Boolean)`.
- `h(tag, 0)`: numbers are children, not attributes (the `attrs != null` check). Keep it that way.
- The shell is zsh: unquoted `$var` does **not** word-split. Use separate variables.
- Changing `database_id` in `wrangler.toml` gives local dev a new empty DB; rerun `npm run db:migrate:local`.

## Deploying and secrets
- Deploy only when the owner asks, or as part of a change they asked to ship. Run `npm run typecheck` first and smoke-test the live site afterwards. Delete any test invite you create on the live site.
- Secrets: only `TURNSTILE_SECRET` (`npx wrangler secret put`). Never print it, write it to a file, or commit it. `TURNSTILE_SITEKEY` in `wrangler.toml` is public. Set it to `""` to turn Turnstile off.
- The repo is **public**. Never commit `.dev.vars`, tokens, host keys, or real user data.
- Commit and push only when asked. End commit messages with the attribution line given in the session.
