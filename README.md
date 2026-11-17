# hither

A no-login invite app. Make an invite (photo, title, date), send the link, and see who's coming.

- **Guests** give their name before they can see anything else, then RSVP, see who's going and comment. They're recognized when they come back.
- **Hosts** can add a guest list. Each name gets a personal link, and the host sees who hasn't replied and who isn't on the list. Hosts can choose *anyone with the link* or *only my list* (others ask to join), and can approve, merge, hide comments or silently block people.
- **"Your invites"**: a host's invites are remembered in their browser (localStorage), so they can find them again without an account.

The whole backend is **one Cloudflare Worker + one D1 database**. Photos are stored in D1 too. Free tier, no credit card, no domain needed.

## Run it locally

```bash
npm install
cp .dev.vars.example .dev.vars
npm run db:migrate:local
npm run dev
```

Open http://127.0.0.1:8787 (`wrangler dev` default). `.dev.vars` holds Cloudflare's published Turnstile **test** keys, which always pass, so the human check works locally without an account. It overrides the real site key in `wrangler.toml` during local dev.

To trigger the daily cleanup locally: `curl http://127.0.0.1:8787/cdn-cgi/local/scheduled`

## Deploy (free)

```bash
npx wrangler login
npx wrangler d1 create hither
```

Paste the printed `database_id` into `wrangler.toml`, then:

```bash
npm run db:migrate:remote
npm run deploy
```

It goes live at `https://hither.<your-subdomain>.workers.dev`.

### Optional: Turnstile (bot check)
Without it, the app still works, and rate limits still apply. To turn it on:
1. Cloudflare dashboard → Turnstile → add a widget for your workers.dev hostname.
2. Put the **site key** in `wrangler.toml` → `TURNSTILE_SITEKEY`.
3. `npx wrangler secret put TURNSTILE_SECRET` and paste the secret key.
4. `npm run deploy`.

There are no other secrets: the key used to hash IP addresses is generated on first use and stored in D1.

## What free covers
- Workers free tier: 100k requests/day. Static files (CSS, JS, fonts, icons) are free and don't count.
- D1 free tier: 5 GB storage, 5M row reads/day. A cover photo is ~70–250 KB, and invites delete themselves 30 days after the event.
- If you outgrow it, Workers Paid is $5/month. Nothing upgrades automatically.

## Abuse protection
| What | Limit |
|---|---|
| Create invites | 5/day per network, 20/day per neighbourhood (/24 or /48) + Turnstile |
| Join (enter name) | 30/hour per network + Turnstile |
| RSVPs + comments | 20/minute per network; 20 comments/day per guest |
| Guests per invite | 200 |
| Reports | 3 reports from different networks hide an invite until reviewed |

IPs are never stored, only HMACs. Blocking is per invite: it covers the person's browser and network, and is silent, so their page keeps working for them while nobody else sees them.

### Reviewing a reported invite
```bash
npx wrangler d1 execute hither --remote --command "SELECT slug, title, status FROM events WHERE status = 'reported'"
# restore it:
npx wrangler d1 execute hither --remote --command "UPDATE events SET status = 'live' WHERE slug = '<slug>'"
# or take it down (purged by the next daily cleanup):
npx wrangler d1 execute hither --remote --command "UPDATE events SET status = 'removed' WHERE slug = '<slug>'"
```

## Code map
```
src/index.ts        routes: pages, API, host actions, daily cleanup
src/lib/data.ts     D1 queries
src/lib/util.ts     ids, hashing, rate limits, Turnstile, time zones, image sniffing
src/views/pages.ts  server-rendered HTML (home, invite states, host shell, messages)
public/app.css      all styles (tokens from docs/design/tokens.css)
public/js/          home.js (create + Your invites), invite.js (guest), manage.js (host), lib.js
migrations/         D1 schema
docs/PLAN.md        product plan; docs/design/ has the screen mockups
```

## Not in v1
- Changing the cover photo after creating (edit title/date/place/note is supported).
- Email/SMS sending: hosts share links through their own messages.
- "Maybe" and plus-ones.
