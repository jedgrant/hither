import { Hono, type Context } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import {
  bindDevice, getEvent, goingGuests, guestByDevice, guestByToken, hostEvent, isBlocked, publicComments, publicCounts,
  type EventRow, type GuestRow,
} from "./lib/data";
import {
  allow, clean, cleanLine, fmtDate, netIds, newId, nowIso, randomKey, randomToken, sha256, sniffImage, validTz,
  verifyTurnstile, zonedToUtc, type Env,
} from "./lib/util";
import { homePage, invitePage, layout, managePage, messagePage } from "./views/pages";

type C = Context<{ Bindings: Env }>;
const app = new Hono<{ Bindings: Env }>();

const COOKIE = "hg";
const MAX_GUESTS = 200;
const DAY = 86400e3;

class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
const fail = (status: number, msg: string): never => { throw new HttpError(status, msg); };

// ---------------------------------------------------------------- headers & errors

app.use("*", async (c, next) => {
  await next();
  c.res = new Response(c.res.body, c.res); // cached responses have immutable headers
  const h = c.res.headers;
  h.set("Content-Security-Policy", [
    "default-src 'self'",
    "img-src 'self' data: blob:",
    "style-src 'self' 'unsafe-inline'",
    "script-src 'self' https://challenges.cloudflare.com",
    "frame-src https://challenges.cloudflare.com",
    "connect-src 'self'",
    "font-src 'self'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; "));
  h.set("X-Content-Type-Options", "nosniff");
  h.set("Referrer-Policy", "strict-origin-when-cross-origin"); // Turnstile needs our origin; paths (and ?g= tokens) stay private
  h.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
});

app.onError((err, c) => {
  if (err instanceof HttpError) return c.json({ error: err.message }, err.status as 400);
  console.error(err);
  return c.json({ error: "Something went wrong. Try again in a moment." }, 500);
});

const page = (c: C, body: Parameters<typeof layout>[0]["body"], o: Partial<Parameters<typeof layout>[0]> & { title: string }, status = 200) => {
  const url = new URL(c.req.url);
  return c.html(layout({ origin: url.origin, path: url.pathname, body, ...o }), status as 200);
};

const notFound = (c: C) =>
  page(c, messagePage({ glyph: "?", title: "This invite isn't here", text: "The link may be mistyped, or the host removed it. Invites also disappear 30 days after the event." }),
    { title: "Not found · hither", noindex: true }, 404);

const RATE_MSG = "Easy there, one sec. Too many updates at once. Try again in a moment.";
async function limit(c: C, key: string, max: number, windowSec: number, msg = RATE_MSG) {
  if (!(await allow(c.env.DB, key, max, windowSec))) fail(429, msg);
}

async function liveEvent(c: C): Promise<EventRow> {
  const ev = await getEvent(c.env.DB, c.req.param("slug")!);
  if (!ev || ev.status !== "live") fail(404, "This invite isn't available.");
  return ev!;
}

async function currentGuest(c: C, ev: EventRow): Promise<GuestRow | null> {
  const gid = getCookie(c, COOKIE);
  if (!gid) return null;
  return guestByDevice(c.env.DB, ev.id, await sha256(gid));
}

async function requireGuest(c: C, ev: EventRow): Promise<GuestRow> {
  const g = await currentGuest(c, ev);
  if (!g) fail(401, "Add your name first.");
  if (g!.access !== "in") fail(403, "You're waiting for the host to let you in.");
  return g!;
}

async function body<T = Record<string, unknown>>(c: C): Promise<T> {
  try { return (await c.req.json()) as T; } catch { return {} as T; }
}

// ---------------------------------------------------------------- pages

app.get("/", (c) =>
  page(c, homePage(c.env.TURNSTILE_SITEKEY || undefined), {
    title: "hither · make an invite",
    description: "Photo, title, date. Send the link and see who's coming. No sign-up.",
    script: "home",
    turnstile: !!c.env.TURNSTILE_SITEKEY,
  }));

app.get("/e/:slug", async (c) => {
  const db = c.env.DB;
  const ev = await getEvent(db, c.req.param("slug"));
  if (!ev || ev.status === "removed") return notFound(c);
  if (ev.status === "reported")
    return page(c, messagePage({ glyph: "!", title: "This invite is under review", text: "Someone reported it. If it's yours and that's a mistake, check back soon." }), { title: "Under review · hither", noindex: true });

  let me = await currentGuest(c, ev);
  let pendingToken: string | undefined;
  const token = c.req.query("g");
  if (token && /^[a-z2-9]{6,20}$/.test(token)) {
    const tg = await guestByToken(db, ev.id, token);
    if (tg && me?.id !== tg.id) { me = tg; pendingToken = token; }
  }

  const state = !me ? "gate" : me.access === "in" ? "in" : "waiting";
  const meId = state === "in" ? me!.id : null;
  const [going, counts, comments] = await Promise.all([
    state === "in" ? goingGuests(db, ev.id, meId) : Promise.resolve([]),
    publicCounts(db, ev.id, meId),
    state === "waiting" ? Promise.resolve([]) : publicComments(db, ev.id, meId),
  ]);

  c.header("Cache-Control", "private, no-store");
  c.header("X-Robots-Tag", "noindex");
  const when = `${fmtDate(ev.starts_at, ev.tz, { weekday: "short", month: "short", day: "numeric" })} · ${fmtDate(ev.starts_at, ev.tz, { hour: "numeric", minute: "2-digit" })}`;
  return page(c, invitePage({ ev, me, state, pendingToken, going, counts, comments, sitekey: c.env.TURNSTILE_SITEKEY || undefined }), {
    title: ev.title,
    description: `${ev.host_name} invited you · ${when}`,
    image: `/img/${ev.image_id}`,
    script: "invite",
    turnstile: state === "gate" && !!c.env.TURNSTILE_SITEKEY,
    noindex: true,
  });
});

app.get("/e/:slug/manage", async (c) => {
  const ev = await getEvent(c.env.DB, c.req.param("slug"));
  if (!ev || ev.status === "removed") return notFound(c);
  c.header("X-Robots-Tag", "noindex");
  return page(c, managePage(ev), { title: `${ev.title} · host`, script: "manage", noindex: true });
});

app.get("/e/:slug/cal.ics", async (c) => {
  const ev = await liveEvent(c);
  const me = await currentGuest(c, ev);
  const loc = me?.access === "in" ? ev.location : null;
  const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/([,;])/g, "\\$1").replace(/\n/g, "\\n");
  const stamp = (iso: string) => iso.replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const end = new Date(new Date(ev.starts_at).getTime() + 3 * 3600e3).toISOString();
  const url = `${new URL(c.req.url).origin}/e/${ev.slug}`;
  const lines = [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//hither//EN", "BEGIN:VEVENT",
    `UID:${ev.id}@hither`, `DTSTAMP:${stamp(nowIso())}`, `DTSTART:${stamp(ev.starts_at)}`, `DTEND:${stamp(end)}`,
    `SUMMARY:${esc(ev.title)}`,
    loc ? `LOCATION:${esc(loc)}` : "",
    `DESCRIPTION:${esc((ev.note ? ev.note + "\n\n" : "") + url)}`,
    `URL:${url}`, "END:VEVENT", "END:VCALENDAR",
  ].filter(Boolean);
  return new Response(lines.join("\r\n"), {
    headers: { "Content-Type": "text/calendar; charset=utf-8", "Content-Disposition": `attachment; filename="${ev.slug}.ics"` },
  });
});

app.get("/img/:id", async (c) => {
  const id = c.req.param("id").replace(/\.\w+$/, "");
  if (!/^[a-z2-9]{16}$/.test(id)) return c.notFound();
  const cache = (globalThis as unknown as { caches?: { default: Cache } }).caches?.default;
  const hit = cache ? await cache.match(c.req.raw) : undefined;
  if (hit) return hit;
  const row = await c.env.DB
    .prepare("SELECT i.mime, i.bytes FROM images i JOIN events e ON e.id = i.event_id WHERE i.id = ? AND e.status = 'live'")
    .bind(id).first<{ mime: string; bytes: number[] | ArrayBuffer }>();
  if (!row) return c.notFound();
  const res = new Response(new Uint8Array(row.bytes as ArrayBuffer), {
    headers: { "Content-Type": row.mime, "Cache-Control": "public, max-age=31536000, immutable", "X-Content-Type-Options": "nosniff" },
  });
  if (cache) c.executionCtx.waitUntil(cache.put(c.req.raw, res.clone()));
  return res;
});

// ---------------------------------------------------------------- create

app.post("/api/events", async (c) => {
  const db = c.env.DB;
  const { net, wide } = await netIds(db, c.req.raw);
  const daily = "You've made a lot of invites today. Try again tomorrow.";
  await limit(c, `create:${net}`, 5, 86400, daily);
  await limit(c, `createw:${wide}`, 20, 86400, daily);

  const form = await c.req.formData().catch(() => fail(400, "Couldn't read the form."));
  if (!(await verifyTurnstile(c.env, form.get("cf-turnstile-response") as string, c.req.raw)))
    fail(400, "Couldn't verify you're human. Refresh and try again.");

  const title = cleanLine(form.get("title"), 80);
  const hostName = cleanLine(form.get("host_name"), 40);
  const date = String(form.get("date") ?? "");
  const time = String(form.get("time") ?? "");
  const tz = String(form.get("tz") ?? "UTC");
  const location = cleanLine(form.get("location"), 120) || null;
  const note = clean(form.get("note"), 500) || null;
  if (!title) fail(400, "Give your invite a title.");
  if (!hostName) fail(400, "Add your name so guests know who invited them.");
  if (!validTz(tz)) fail(400, "Unknown time zone.");
  const startsAt = zonedToUtc(date, time, tz) ?? fail(400, "Pick a date and time.");
  const startMs = new Date(startsAt).getTime();
  if (startMs < Date.now() - DAY) fail(400, "That date has already passed.");
  if (startMs > Date.now() + 2 * 365 * DAY) fail(400, "Pick a date within the next two years.");

  const image = form.get("image");
  const thumb = form.get("thumb");
  if (!(image instanceof File) || !(thumb instanceof File)) fail(400, "A cover photo is required.");
  const img = new Uint8Array(await (image as File).arrayBuffer());
  const th = new Uint8Array(await (thumb as File).arrayBuffer());
  if (img.byteLength > 600_000 || th.byteLength > 80_000) fail(413, "That photo is too large. Try another one.");
  const imgMime = sniffImage(img), thMime = sniffImage(th);
  if (!imgMime || !thMime) fail(415, "That photo couldn't be read. Try another one.");
  const w = Math.min(4000, Math.max(0, parseInt(String(form.get("w")), 10) || 0)) || null;
  const h = Math.min(4000, Math.max(0, parseInt(String(form.get("h")), 10) || 0)) || null;

  const id = newId(), slug = randomToken(10), hostKey = randomKey();
  const imageId = randomToken(16), thumbId = randomToken(16), now = nowIso();
  await db.batch([
    db.prepare(`INSERT INTO events (id, slug, title, host_name, starts_at, local_date, local_time, tz, location, note,
                image_id, thumb_id, image_w, image_h, host_key_hash, creator_net, created_at, purge_after)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(id, slug, title, hostName, startsAt, date, time, tz, location, note, imageId, thumbId, w, h,
        await sha256(hostKey), net, now, new Date(startMs + 30 * DAY).toISOString()),
    db.prepare("INSERT INTO images (id, event_id, mime, bytes, created_at) VALUES (?, ?, ?, ?, ?)").bind(imageId, id, imgMime, img.buffer, now),
    db.prepare("INSERT INTO images (id, event_id, mime, bytes, created_at) VALUES (?, ?, ?, ?, ?)").bind(thumbId, id, thMime, th.buffer, now),
  ]);
  return c.json({ slug, hostKey, title, startsAt, tz, thumbId });
});

// ---------------------------------------------------------------- guests

app.post("/api/e/:slug/join", async (c) => {
  const db = c.env.DB;
  const ev = await liveEvent(c);
  const { net } = await netIds(db, c.req.raw);
  await limit(c, `join:${net}`, 30, 3600);
  const b = await body<{ name?: string; token?: string; turnstile?: string }>(c);

  let gid = getCookie(c, COOKIE);
  if (!gid || !/^[a-z2-9]{26}$/.test(gid)) gid = randomToken(26);
  setCookie(c, COOKIE, gid, {
    httpOnly: true, sameSite: "Lax", path: "/", maxAge: 400 * 86400,
    secure: new URL(c.req.url).protocol === "https:",
  });
  const gidHash = await sha256(gid);
  const now = nowIso();

  if (b.token) {
    const g = await guestByToken(db, ev.id, String(b.token));
    if (!g) fail(404, "This personal link has been replaced. Ask the host for a new one.");
    await db.batch([
      bindDevice(db, ev.id, gidHash, g!.id, net),
      db.prepare("UPDATE guests SET opened_at = COALESCE(opened_at, ?) WHERE id = ?").bind(now, g!.id),
    ]);
    return c.json({ state: g!.access });
  }

  const existing = await guestByDevice(db, ev.id, gidHash);
  if (existing) return c.json({ state: existing.access });

  const name = cleanLine(b.name, 40);
  if (!name) fail(400, "Add your name to continue.");
  if (!(await verifyTurnstile(c.env, b.turnstile, c.req.raw))) fail(400, "Couldn't verify you're human. Refresh and try again.");
  const count = await db.prepare("SELECT COUNT(*) AS n FROM guests WHERE event_id = ?").bind(ev.id).first<{ n: number }>();
  if ((count?.n ?? 0) >= MAX_GUESTS) fail(403, "This invite has reached its guest limit.");

  const blocked = await isBlocked(db, ev.id, gidHash, net);
  const access = ev.access === "list" ? "pending" : "in";
  const id = newId();
  await db.batch([
    db.prepare(`INSERT INTO guests (id, event_id, name, source, access, shadow, opened_at, created_at, updated_at)
                VALUES (?, ?, ?, 'link', ?, ?, ?, ?, ?)`).bind(id, ev.id, name, access, blocked ? 1 : 0, now, now, now),
    bindDevice(db, ev.id, gidHash, id, net),
  ]);
  return c.json({ state: access });
});

app.post("/api/e/:slug/rsvp", async (c) => {
  const db = c.env.DB;
  const ev = await liveEvent(c);
  const me = await requireGuest(c, ev);
  const { net } = await netIds(db, c.req.raw);
  await limit(c, `w:${net}`, 20, 60);
  const { rsvp } = await body<{ rsvp?: string }>(c);
  if (rsvp !== "yes" && rsvp !== "no") fail(400, "Pick an answer.");
  if (new Date(ev.starts_at).getTime() + 6 * 3600e3 < Date.now()) fail(400, "This event has already happened.");
  await db.prepare("UPDATE guests SET rsvp = ?, updated_at = ? WHERE id = ?").bind(rsvp, nowIso(), me.id).run();
  return c.json({ ok: true });
});

app.post("/api/e/:slug/comments", async (c) => {
  const db = c.env.DB;
  const ev = await liveEvent(c);
  const me = await requireGuest(c, ev);
  const { net } = await netIds(db, c.req.raw);
  await limit(c, `w:${net}`, 20, 60);
  await limit(c, `c:${me.id}`, 20, 86400, "That's a lot of comments for one day. Try again tomorrow.");
  const text = clean((await body<{ body?: string }>(c)).body, 500);
  if (!text) fail(400, "Write something first.");
  await db.prepare("INSERT INTO comments (id, event_id, guest_id, body, shadow, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(newId(), ev.id, me.id, text, me.shadow, nowIso()).run();
  return c.json({ ok: true });
});

app.post("/api/e/:slug/report", async (c) => {
  const db = c.env.DB;
  const ev = await liveEvent(c);
  const { net } = await netIds(db, c.req.raw);
  await limit(c, `r:${net}`, 5, 86400);
  await db.prepare("INSERT OR IGNORE INTO reports (event_id, net_hash, created_at) VALUES (?, ?, ?)").bind(ev.id, net, nowIso()).run();
  const r = await db.prepare("SELECT COUNT(*) AS n FROM reports WHERE event_id = ?").bind(ev.id).first<{ n: number }>();
  if ((r?.n ?? 0) >= 3) await db.prepare("UPDATE events SET status = 'reported' WHERE id = ? AND status = 'live'").bind(ev.id).run();
  return c.json({ ok: true });
});

// ---------------------------------------------------------------- host

async function host(c: C): Promise<EventRow> {
  const { net } = await netIds(c.env.DB, c.req.raw);
  await limit(c, `h:${net}`, 300, 60);
  const ev = await hostEvent(c.env.DB, c.req.param("slug")!, c.req.header("X-Host-Key"));
  if (!ev) fail(403, "This host link isn't valid.");
  return ev!;
}

app.post("/api/hosted/summary", async (c) => {
  const db = c.env.DB;
  const { net } = await netIds(db, c.req.raw);
  await limit(c, `s:${net}`, 30, 60);
  const { items } = await body<{ items?: { slug: string; key: string }[] }>(c);
  const out = [];
  for (const it of (Array.isArray(items) ? items : []).slice(0, 50)) {
    const ev = typeof it?.slug === "string" ? await hostEvent(db, it.slug, it.key) : null;
    if (!ev) { out.push({ slug: it?.slug, ok: false }); continue; }
    const n = await db.prepare(`SELECT SUM(rsvp = 'yes' AND access = 'in' AND shadow = 0) AS yes,
        SUM(rsvp = 'no' AND access = 'in' AND shadow = 0) AS no,
        SUM(access = 'pending' AND shadow = 0) AS pending,
        SUM(rsvp IS NULL AND access = 'in' AND shadow = 0) AS noreply FROM guests WHERE event_id = ?`).bind(ev.id)
      .first<{ yes: number; no: number; pending: number; noreply: number }>();
    const cm = await db.prepare("SELECT COUNT(*) AS n FROM comments WHERE event_id = ? AND hidden = 0 AND shadow = 0").bind(ev.id).first<{ n: number }>();
    out.push({ slug: ev.slug, ok: true, title: ev.title, startsAt: ev.starts_at, tz: ev.tz, thumbId: ev.thumb_id, status: ev.status,
      yes: n?.yes ?? 0, no: n?.no ?? 0, pending: n?.pending ?? 0, noreply: n?.noreply ?? 0, comments: cm?.n ?? 0 });
  }
  return c.json({ items: out });
});

app.get("/api/e/:slug/host", async (c) => {
  const db = c.env.DB;
  const ev = await host(c);
  const [guests, comments] = await Promise.all([
    db.prepare(`SELECT g.id, g.name, g.source, g.invite_token, g.access, g.rsvp, g.shadow, g.opened_at, g.created_at, g.updated_at,
                (SELECT COUNT(*) FROM guest_devices d WHERE d.guest_id = g.id) AS devices
                FROM guests g WHERE g.event_id = ? ORDER BY g.updated_at DESC`).bind(ev.id).all(),
    db.prepare(`SELECT c.id, c.guest_id, c.body, c.hidden, c.shadow, c.created_at, g.name, g.rsvp
                FROM comments c LEFT JOIN guests g ON g.id = c.guest_id WHERE c.event_id = ? ORDER BY c.created_at DESC LIMIT 500`).bind(ev.id).all(),
  ]);
  const { id, host_key_hash, creator_net, purge_after, ...pub } = ev;
  return c.json({ event: pub, guests: guests.results, comments: comments.results });
});

app.patch("/api/e/:slug", async (c) => {
  const db = c.env.DB;
  const ev = await host(c);
  const b = await body<Record<string, unknown>>(c);
  const next = { ...ev };
  if ("title" in b) next.title = cleanLine(b.title, 80) || fail(400, "Title can't be empty.");
  if ("host_name" in b) next.host_name = cleanLine(b.host_name, 40) || fail(400, "Your name can't be empty.");
  if ("location" in b) next.location = cleanLine(b.location, 120) || null;
  if ("note" in b) next.note = clean(b.note, 500) || null;
  if ("access" in b) next.access = b.access === "list" ? "list" : "open";
  if ("show_guests" in b) next.show_guests = b.show_guests ? 1 : 0;
  if ("date" in b || "time" in b || "tz" in b) {
    next.local_date = String(b.date ?? ev.local_date);
    next.local_time = String(b.time ?? ev.local_time);
    next.tz = String(b.tz ?? ev.tz);
    next.starts_at = zonedToUtc(next.local_date, next.local_time, next.tz) ?? fail(400, "Pick a valid date and time.");
    next.purge_after = new Date(new Date(next.starts_at).getTime() + 30 * DAY).toISOString();
  }
  await db.prepare(`UPDATE events SET title = ?, host_name = ?, location = ?, note = ?, access = ?, show_guests = ?,
                    local_date = ?, local_time = ?, tz = ?, starts_at = ?, purge_after = ? WHERE id = ?`)
    .bind(next.title, next.host_name, next.location, next.note, next.access, next.show_guests,
      next.local_date, next.local_time, next.tz, next.starts_at, next.purge_after, ev.id).run();
  return c.json({ ok: true });
});

app.delete("/api/e/:slug", async (c) => {
  const ev = await host(c);
  await deleteEvents(c.env.DB, [ev.id]);
  return c.json({ ok: true });
});

app.post("/api/e/:slug/guests", async (c) => {
  const db = c.env.DB;
  const ev = await host(c);
  const { names } = await body<{ names?: unknown }>(c);
  const list = (Array.isArray(names) ? names : []).map((n) => cleanLine(n, 40)).filter(Boolean);
  if (!list.length) fail(400, "Add at least one name.");
  const count = await db.prepare("SELECT COUNT(*) AS n FROM guests WHERE event_id = ?").bind(ev.id).first<{ n: number }>();
  if ((count?.n ?? 0) + list.length > MAX_GUESTS) fail(400, `An invite can have up to ${MAX_GUESTS} guests.`);
  const now = nowIso();
  await db.batch(list.map((name) =>
    db.prepare(`INSERT INTO guests (id, event_id, name, source, invite_token, access, created_at, updated_at)
                VALUES (?, ?, ?, 'list', ?, 'in', ?, ?)`).bind(newId(), ev.id, name, randomToken(10), now, now)));
  return c.json({ ok: true, added: list.length });
});

app.post("/api/e/:slug/guests/:id/:action", async (c) => {
  const db = c.env.DB;
  const ev = await host(c);
  const g = await db.prepare("SELECT * FROM guests WHERE id = ? AND event_id = ?").bind(c.req.param("id"), ev.id).first<GuestRow>();
  if (!g) fail(404, "Guest not found.");
  const now = nowIso();
  const action = c.req.param("action");

  if (action === "approve" || action === "decline") {
    await db.prepare("UPDATE guests SET access = ?, updated_at = ? WHERE id = ?").bind(action === "approve" ? "in" : "declined", now, g!.id).run();
  } else if (action === "block") {
    const { results: devs } = await db.prepare("SELECT gid_hash, net_hash FROM guest_devices WHERE guest_id = ?").bind(g!.id).all<{ gid_hash: string; net_hash: string }>();
    await db.batch([
      db.prepare("UPDATE guests SET shadow = 1 WHERE id = ?").bind(g!.id),
      db.prepare("UPDATE comments SET shadow = 1 WHERE guest_id = ?").bind(g!.id),
      ...devs.flatMap((d) => [
        db.prepare("INSERT OR IGNORE INTO blocks (event_id, kind, value_hash, guest_id, created_at) VALUES (?, 'gid', ?, ?, ?)").bind(ev.id, d.gid_hash, g!.id, now),
        db.prepare("INSERT OR IGNORE INTO blocks (event_id, kind, value_hash, guest_id, created_at) VALUES (?, 'net', ?, ?, ?)").bind(ev.id, d.net_hash, g!.id, now),
      ]),
    ]);
  } else if (action === "unblock") {
    await db.batch([
      db.prepare("UPDATE guests SET shadow = 0 WHERE id = ?").bind(g!.id),
      db.prepare("UPDATE comments SET shadow = 0 WHERE guest_id = ?").bind(g!.id),
      db.prepare("DELETE FROM blocks WHERE event_id = ? AND guest_id = ?").bind(ev.id, g!.id),
    ]);
  } else if (action === "relink") {
    if (g!.source !== "list") fail(400, "Only guests on your list have personal links.");
    await db.batch([
      db.prepare("UPDATE guests SET invite_token = ?, opened_at = NULL WHERE id = ?").bind(randomToken(10), g!.id),
      db.prepare("DELETE FROM guest_devices WHERE guest_id = ?").bind(g!.id),
    ]);
  } else if (action === "remove") {
    await db.batch([
      db.prepare("DELETE FROM comments WHERE guest_id = ?").bind(g!.id),
      db.prepare("DELETE FROM guest_devices WHERE guest_id = ?").bind(g!.id),
      db.prepare("DELETE FROM guests WHERE id = ?").bind(g!.id),
    ]);
  } else if (action === "merge") {
    const { into } = await body<{ into?: string }>(c);
    const t = await db.prepare("SELECT * FROM guests WHERE id = ? AND event_id = ? AND source = 'list'").bind(into ?? "", ev.id).first<GuestRow>();
    if (!t || t.id === g!.id) fail(400, "Pick someone from your list.");
    await db.batch([
      db.prepare("UPDATE guest_devices SET guest_id = ? WHERE guest_id = ?").bind(t!.id, g!.id),
      db.prepare("UPDATE comments SET guest_id = ? WHERE guest_id = ?").bind(t!.id, g!.id),
      db.prepare("UPDATE guests SET rsvp = COALESCE(rsvp, ?), opened_at = COALESCE(opened_at, ?), updated_at = ? WHERE id = ?")
        .bind(g!.rsvp, g!.opened_at ?? now, now, t!.id),
      db.prepare("DELETE FROM guests WHERE id = ?").bind(g!.id),
    ]);
  } else {
    fail(400, "Unknown action.");
  }
  return c.json({ ok: true });
});

app.post("/api/e/:slug/comments/:id/hide", async (c) => {
  const ev = await host(c);
  const { hidden } = await body<{ hidden?: boolean }>(c);
  await c.env.DB.prepare("UPDATE comments SET hidden = ? WHERE id = ? AND event_id = ?").bind(hidden === false ? 0 : 1, c.req.param("id"), ev.id).run();
  return c.json({ ok: true });
});

app.post("/api/e/:slug/host-comment", async (c) => {
  const ev = await host(c);
  const text = clean((await body<{ body?: string }>(c)).body, 500);
  if (!text) fail(400, "Write something first.");
  await c.env.DB.prepare("INSERT INTO comments (id, event_id, guest_id, body, created_at) VALUES (?, ?, NULL, ?, ?)")
    .bind(newId(), ev.id, text, nowIso()).run();
  return c.json({ ok: true });
});

app.notFound((c) => (c.req.path.startsWith("/api/") ? c.json({ error: "Not found" }, 404) : notFound(c)));

// ---------------------------------------------------------------- cleanup

async function deleteEvents(db: D1Database, ids: string[]) {
  for (const id of ids) {
    await db.batch(["comments", "guest_devices", "blocks", "reports", "guests", "images"].map((t) =>
      db.prepare(`DELETE FROM ${t} WHERE event_id = ?`).bind(id))
      .concat(db.prepare("DELETE FROM events WHERE id = ?").bind(id)));
  }
}

export default {
  fetch: app.fetch,
  async scheduled(_e: ScheduledController, env: Env) {
    const { results } = await env.DB.prepare("SELECT id FROM events WHERE purge_after < ? OR status = 'removed' LIMIT 500")
      .bind(nowIso()).all<{ id: string }>();
    await deleteEvents(env.DB, results.map((r) => r.id));
    await env.DB.prepare("DELETE FROM hits WHERE win < ?").bind(Math.floor(Date.now() / 1000) - 2 * 86400).run();
  },
} satisfies ExportedHandler<Env>;
