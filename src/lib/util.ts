// Small helpers: ids, hashing, network identity, time, rate limits, Turnstile.

export type Env = {
  DB: D1Database;
  ASSETS: Fetcher;
  TURNSTILE_SITEKEY?: string;
  TURNSTILE_SECRET?: string;
};

const B32 = "abcdefghijkmnpqrstuvwxyz23456789"; // no l/o/0/1

export function randomToken(len: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  let out = "";
  for (const b of bytes) out += B32[b & 31];
  return out;
}

export function randomKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export const newId = () => randomToken(16);
export const nowIso = () => new Date().toISOString();

function hex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function sha256(s: string): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
}

// Server secret for hashing IPs. Created on first use and kept in D1 → zero setup.
let secretKey: CryptoKey | null = null;
async function ipKey(db: D1Database): Promise<CryptoKey> {
  if (secretKey) return secretKey;
  let row = await db.prepare("SELECT v FROM meta WHERE k = 'ip_secret'").first<{ v: string }>();
  if (!row) {
    await db.prepare("INSERT OR IGNORE INTO meta (k, v) VALUES ('ip_secret', ?)").bind(randomKey()).run();
    row = await db.prepare("SELECT v FROM meta WHERE k = 'ip_secret'").first<{ v: string }>();
  }
  secretKey = await crypto.subtle.importKey("raw", new TextEncoder().encode(row!.v), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return secretKey;
}

async function hmac(db: D1Database, s: string): Promise<string> {
  const sig = await crypto.subtle.sign("HMAC", await ipKey(db), new TextEncoder().encode(s));
  return hex(sig).slice(0, 32);
}

function expandV6(ip: string): string[] {
  const [head, tail] = ip.split("::");
  const h = head ? head.split(":") : [];
  const t = tail !== undefined && tail ? tail.split(":") : [];
  const fill = tail !== undefined ? Array(8 - h.length - t.length).fill("0") : [];
  return [...h, ...fill, ...t].map((g) => g.padStart(4, "0"));
}

/** Network identity. `net` = one household/device network (IPv4 or IPv6 /64);
 *  `wide` = neighbourhood (IPv4 /24 or IPv6 /48), for coarse create limits.
 *  Only HMACs are ever stored, never raw IPs. */
export async function netIds(db: D1Database, req: Request): Promise<{ net: string; wide: string }> {
  const ip = req.headers.get("CF-Connecting-IP") || "127.0.0.1";
  let net: string, wide: string;
  if (ip.includes(":")) {
    const g = expandV6(ip);
    net = g.slice(0, 4).join(":");
    wide = g.slice(0, 3).join(":");
  } else {
    net = ip;
    wide = ip.split(".").slice(0, 3).join(".");
  }
  return { net: await hmac(db, "n:" + net), wide: await hmac(db, "w:" + wide) };
}

/** Fixed-window counter. Returns true if the call is allowed. */
export async function allow(db: D1Database, key: string, max: number, windowSec: number): Promise<boolean> {
  const win = Math.floor(Date.now() / 1000 / windowSec) * windowSec; // window start, epoch seconds
  const row = await db
    .prepare("INSERT INTO hits (k, win, n) VALUES (?, ?, 1) ON CONFLICT(k, win) DO UPDATE SET n = n + 1 RETURNING n")
    .bind(key, win)
    .first<{ n: number }>();
  return (row?.n ?? 1) <= max;
}

export async function verifyTurnstile(env: Env, token: string | null | undefined, req: Request): Promise<boolean> {
  if (!env.TURNSTILE_SITEKEY || !env.TURNSTILE_SECRET) return true; // Turnstile not configured
  if (!token) return false;
  const body = new FormData();
  body.append("secret", env.TURNSTILE_SECRET);
  body.append("response", token);
  const ip = req.headers.get("CF-Connecting-IP");
  if (ip) body.append("remoteip", ip);
  try {
    const r = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body });
    const j = (await r.json()) as { success?: boolean };
    return !!j.success;
  } catch {
    return false;
  }
}

// ---------- text ----------
export function clean(s: unknown, max: number): string {
  if (typeof s !== "string") return "";
  return s
    .replace(/[\u0000-\u0009\u000B-\u001F\u007F​-‏‪-‮⁦-⁩]/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, max);
}
export const cleanLine = (s: unknown, max: number) => clean(s, max * 2).replace(/\s+/g, " ").trim().slice(0, max);

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const a = parts[0]?.[0] ?? "?";
  const b = parts.length > 1 ? parts[parts.length - 1][0] : parts[0]?.[1] ?? "";
  return (a + b).toUpperCase();
}
export function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] || name;
}
/** Stable avatar colour 1..6 from a string. */
export function avatarHue(s: string): number {
  let h = 0;
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return (h % 6) + 1;
}

// ---------- time ----------
function tzOffsetMs(utcMs: number, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(new Date(utcMs));
  const g = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asUtc = Date.UTC(g("year"), g("month") - 1, g("day"), g("hour"), g("minute"), g("second"));
  return asUtc - utcMs;
}

export function validTz(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** "2026-12-06" + "19:30" in "America/Denver" → UTC ISO string. */
export function zonedToUtc(date: string, time: string, tz: string): string | null {
  const dm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const tm = /^(\d{2}):(\d{2})$/.exec(time);
  if (!dm || !tm || !validTz(tz)) return null;
  const guess = Date.UTC(+dm[1], +dm[2] - 1, +dm[3], +tm[1], +tm[2]);
  let utc = guess - tzOffsetMs(guess, tz);
  utc = guess - tzOffsetMs(utc, tz);
  const d = new Date(utc);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

export function fmtDate(iso: string, tz: string, opts: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: tz, ...opts }).format(new Date(iso));
}

export function tzLabel(iso: string, tz: string): string {
  const p = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "long" }).formatToParts(new Date(iso));
  return (p.find((x) => x.type === "timeZoneName")?.value ?? tz).replace(/ (Standard|Daylight) /, " ");
}

export function ago(iso: string): string {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}d`;
  return `${Math.floor(s / 86400 / 30)}mo`;
}

// ---------- images ----------
export function sniffImage(b: Uint8Array): "image/jpeg" | "image/webp" | null {
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length > 12 && String.fromCharCode(...b.slice(0, 4)) === "RIFF" && String.fromCharCode(...b.slice(8, 12)) === "WEBP") return "image/webp";
  return null;
}
