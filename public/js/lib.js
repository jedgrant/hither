// Shared browser helpers. No framework; DOM is built with textContent, never innerHTML.

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/** h("div.card#x", { onclick }, child, "text", ...) */
export function h(tag, attrs, ...kids) {
  const [, name, rest = ""] = /^([a-z0-9]+)(.*)$/i.exec(tag);
  const el = document.createElement(name);
  for (const m of rest.matchAll(/([.#])([\w-]+)/g)) m[1] === "." ? el.classList.add(m[2]) : (el.id = m[2]);
  if (attrs != null && (typeof attrs !== "object" || attrs instanceof Node || Array.isArray(attrs))) { kids.unshift(attrs); attrs = null; }
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "class") el.className += " " + v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const k of kids.flat(Infinity)) if (k != null && k !== false) el.append(k instanceof Node ? k : String(k));
  return el;
}

const SVGNS = "http://www.w3.org/2000/svg";
export function icon(name, cls = "i") {
  const s = document.createElementNS(SVGNS, "svg");
  s.setAttribute("class", cls);
  s.setAttribute("aria-hidden", "true");
  const u = document.createElementNS(SVGNS, "use");
  u.setAttribute("href", `/icons.svg#${name}`);
  s.append(u);
  return s;
}

export function initials(name) {
  const p = name.trim().split(/\s+/).filter(Boolean);
  return ((p[0]?.[0] ?? "?") + (p.length > 1 ? p[p.length - 1][0] : p[0]?.[1] ?? "")).toUpperCase();
}
export function hue(s) { let x = 0; for (const c of s) x = (x * 31 + c.charCodeAt(0)) >>> 0; return (x % 6) + 1; }
export const av = (name, cls = "") => h(`span.av.a${hue(name)}${cls}`, { "aria-hidden": "true" }, initials(name));
export const first = (name) => name.trim().split(/\s+/)[0] || name;

export async function api(path, { method = "GET", body, key, form } = {}) {
  const headers = {};
  if (key) headers["X-Host-Key"] = key;
  if (body && !form) headers["Content-Type"] = "application/json";
  let res;
  try {
    res = await fetch(path, { method, headers, body: form ? form : body ? JSON.stringify(body) : undefined, credentials: "same-origin" });
  } catch {
    throw new Error("You seem to be offline. Check your connection and try again.");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error(data.error || "Something went wrong."); e.status = res.status; throw e; }
  return data;
}

let toastTimer;
export function toast(msg) {
  let t = $("#toast");
  if (!t) { t = h("div.toast#toast", { role: "status" }); document.body.append(t); }
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 3500);
}

export function showError(el, msg) { el.textContent = msg; el.hidden = !msg; }

export async function copy(text, label = "Copied") {
  try { await navigator.clipboard.writeText(text); toast(label); }
  catch { window.prompt("Copy this:", text); }
}

export async function share(url, title, text) {
  if (navigator.share) {
    try { await navigator.share({ url, title, text }); return; } catch (e) { if (e.name === "AbortError") return; }
  }
  copy(url, "Link copied");
}

// ---------- localStorage (convenience only; can be empty or throw) ----------
export const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};
const HOSTED = "hither:hosted";
export const hosted = {
  all: () => store.get(HOSTED, []).filter((x) => x && x.slug && x.key),
  find: (slug) => hosted.all().find((x) => x.slug === slug),
  save(entry) {
    const list = hosted.all().filter((x) => x.slug !== entry.slug);
    const prev = hosted.find(entry.slug) || {};
    list.unshift({ ...prev, ...entry, savedAt: prev.savedAt || new Date().toISOString() });
    store.set(HOSTED, list.slice(0, 100));
  },
  remove(slug) { store.set(HOSTED, hosted.all().filter((x) => x.slug !== slug)); },
};

// ---------- bottom sheet ----------
export function sheet(build) {
  const scrim = h("div.scrim");
  const panel = h("div.bsheet", { role: "dialog", "aria-modal": "true" }, h("div.grab"));
  const close = () => { scrim.remove(); panel.remove(); document.removeEventListener("keydown", onKey); };
  const onKey = (e) => e.key === "Escape" && close();
  scrim.addEventListener("click", close);
  document.addEventListener("keydown", onKey);
  build(panel, close);
  document.body.append(scrim, panel);
  panel.querySelector("button, input, textarea")?.focus();
  return close;
}

export function confirmSheet({ title, text, ok = "Confirm", danger = false }) {
  return new Promise((resolve) => {
    let done = false;
    const close = sheet((p, close) => {
      p.append(h("h3", title), text ? h("p", text) : null,
        h("button.btn.block" + (danger ? ".danger" : ".ink"), { type: "button", onclick: () => { done = true; close(); resolve(true); } }, ok),
        h("button.btn.plain.block", { type: "button", onclick: () => close() }, "Cancel"));
    });
    const obs = new MutationObserver(() => { if (!document.body.contains(document.querySelector(".bsheet"))) { obs.disconnect(); if (!done) resolve(false); } });
    obs.observe(document.body, { childList: true });
    void close;
  });
}

export function fmtWhen(iso, tz, opts) {
  try { return new Intl.DateTimeFormat(undefined, { timeZone: tz, ...opts }).format(new Date(iso)); }
  catch { return new Date(iso).toLocaleString(); }
}

export function ago(iso) {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
