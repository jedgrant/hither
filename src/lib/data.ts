import { sha256 } from "./util";

export type EventRow = {
  id: string; slug: string; title: string; host_name: string;
  starts_at: string; local_date: string; local_time: string; tz: string;
  location: string | null; note: string | null;
  image_id: string; thumb_id: string; image_w: number | null; image_h: number | null;
  host_key_hash: string; creator_net: string;
  access: "open" | "list"; show_guests: number; status: "live" | "reported" | "removed";
  created_at: string; purge_after: string;
};

export type GuestRow = {
  id: string; event_id: string; name: string; source: "list" | "link";
  invite_token: string | null; access: "in" | "pending" | "declined";
  rsvp: "yes" | "no" | null; shadow: number; opened_at: string | null;
  created_at: string; updated_at: string;
};

export type CommentView = {
  id: string; guest_id: string | null; body: string; hidden: number; shadow: number; created_at: string;
  name: string | null; rsvp: "yes" | "no" | null;
};

export const getEvent = (db: D1Database, slug: string) =>
  db.prepare("SELECT * FROM events WHERE slug = ?").bind(slug).first<EventRow>();

export async function hostEvent(db: D1Database, slug: string, key: string | null | undefined): Promise<EventRow | null> {
  if (!key || key.length < 20) return null;
  const ev = await getEvent(db, slug);
  if (!ev || ev.status === "removed") return null;
  return (await sha256(key)) === ev.host_key_hash ? ev : null;
}

export const guestByDevice = (db: D1Database, eventId: string, gidHash: string) =>
  db.prepare("SELECT g.* FROM guest_devices d JOIN guests g ON g.id = d.guest_id WHERE d.event_id = ? AND d.gid_hash = ?")
    .bind(eventId, gidHash).first<GuestRow>();

export const guestByToken = (db: D1Database, eventId: string, token: string) =>
  db.prepare("SELECT * FROM guests WHERE event_id = ? AND invite_token = ?").bind(eventId, token).first<GuestRow>();

export async function isBlocked(db: D1Database, eventId: string, gidHash: string, net: string): Promise<boolean> {
  const r = await db
    .prepare("SELECT 1 FROM blocks WHERE event_id = ? AND ((kind = 'gid' AND value_hash = ?) OR (kind = 'net' AND value_hash = ?)) LIMIT 1")
    .bind(eventId, gidHash, net).first();
  return !!r;
}

export function bindDevice(db: D1Database, eventId: string, gidHash: string, guestId: string, net: string) {
  return db
    .prepare(`INSERT INTO guest_devices (event_id, gid_hash, guest_id, net_hash, last_seen) VALUES (?, ?, ?, ?, ?)
              ON CONFLICT(event_id, gid_hash) DO UPDATE SET guest_id = excluded.guest_id, net_hash = excluded.net_hash, last_seen = excluded.last_seen`)
    .bind(eventId, gidHash, guestId, net, new Date().toISOString());
}

/** Guests visible to other guests: in, going, not shadowed (except yourself). */
export async function goingGuests(db: D1Database, eventId: string, meId: string | null) {
  const { results } = await db
    .prepare(`SELECT id, name FROM guests WHERE event_id = ? AND access = 'in' AND rsvp = 'yes' AND (shadow = 0 OR id = ?)
              ORDER BY updated_at ASC`)
    .bind(eventId, meId ?? "").all<{ id: string; name: string }>();
  return results;
}

export async function publicCounts(db: D1Database, eventId: string, meId: string | null) {
  const r = await db
    .prepare(`SELECT SUM(rsvp = 'yes') AS yes, SUM(rsvp = 'no') AS no FROM guests
              WHERE event_id = ? AND access = 'in' AND (shadow = 0 OR id = ?)`)
    .bind(eventId, meId ?? "").first<{ yes: number | null; no: number | null }>();
  return { yes: r?.yes ?? 0, no: r?.no ?? 0 };
}

export async function publicComments(db: D1Database, eventId: string, meId: string | null): Promise<CommentView[]> {
  const { results } = await db
    .prepare(`SELECT c.id, c.guest_id, c.body, c.hidden, c.shadow, c.created_at, g.name, g.rsvp
              FROM comments c LEFT JOIN guests g ON g.id = c.guest_id
              WHERE c.event_id = ? AND c.hidden = 0 AND (c.shadow = 0 OR c.guest_id = ?)
              ORDER BY c.created_at ASC LIMIT 300`)
    .bind(eventId, meId ?? "").all<CommentView>();
  return results;
}
