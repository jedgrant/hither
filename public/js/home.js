import { $, h, icon, api, hosted, store, showError, fmtWhen, toast } from "./lib.js";

// ======================================================= Your invites
async function renderYours() {
  const box = $("#yours");
  let list = hosted.all();
  if (!list.length) return;
  let editing = false;
  let summary = {};

  const draw = () => {
    list = hosted.all();
    box.hidden = !list.length;
    if (!list.length) return;
    const now = Date.now();
    const rows = list.map((x) => ({ ...x, ...(summary[x.slug] || {}) }))
      .sort((a, b) => new Date(a.startsAt) - new Date(b.startsAt));
    const upcoming = rows.filter((x) => new Date(x.startsAt).getTime() + 6 * 3600e3 >= now);
    const past = rows.filter((x) => new Date(x.startsAt).getTime() + 6 * 3600e3 < now).reverse();

    const row = (x, isPast) => {
      const days = Math.ceil((new Date(x.startsAt) - now) / 86400e3);
      const when = fmtWhen(x.startsAt, x.tz, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
      const stats = x.yes == null ? null
        : isPast ? `${x.yes} went`
        : [h("em", `${x.yes} going`), ` · ${x.no} can't`, x.noreply ? ` · ${x.noreply} no reply` : "",
           x.pending ? h("span.pend", ` · ${x.pending} asking to join`) : ""];
      const inner = [
        h("div.thumb", x.thumbId ? h("img", { src: `/img/${x.thumbId}`, alt: "", loading: "lazy" }) : null),
        h("div.tx", h("b", x.title || "Untitled"),
          h("span", isPast ? fmtWhen(x.startsAt, x.tz, { weekday: "short", month: "short", day: "numeric" }) : when,
            !isPast && days >= 0 && days <= 30 ? h("span.soon", days === 0 ? "TODAY" : days === 1 ? "TOMORROW" : `IN ${days} DAYS`) : null),
          stats ? h("span", stats) : null),
      ];
      if (editing) {
        return h("div.ev" + (isPast ? ".past" : ""), inner,
          h("button.rm", { type: "button", "aria-label": `Remove ${x.title} from this device`, onclick: () => { hosted.remove(x.slug); draw(); } }, icon("trash")));
      }
      return h("a.ev" + (isPast ? ".past" : ""), { href: `/e/${x.slug}/manage#k=${encodeURIComponent(x.key)}` }, inner, icon("chev", "i chev"));
    };

    box.replaceChildren(...[
      h("div.yi-head", h("h2", "Your invites"),
        h("button.link", { type: "button", onclick: () => { editing = !editing; draw(); } }, editing ? "Done" : "Edit")),
      upcoming.length ? [h("div.grp", "Upcoming"), h("div.card.list", upcoming.map((x) => row(x, false)))] : null,
      past.length ? [h("div.grp", "Past"), h("div.card.list", past.map((x) => row(x, true)))] : null,
      h("div.local-note", icon("device"),
        h("span", editing
          ? "Removing an invite only forgets it on this device. The invite itself keeps working."
          : "Saved in this browser only. Opening a host link on another device adds it there too.")),
      h("div.newline", "or make a new one"),
    ].flat().filter(Boolean));
  };

  draw();
  try {
    const { items } = await api("/api/hosted/summary", { method: "POST", body: { items: list.map((x) => ({ slug: x.slug, key: x.key })) } });
    let gone = 0;
    for (const it of items) {
      if (!it.ok) { hosted.remove(it.slug); gone++; continue; }
      summary[it.slug] = it;
      hosted.save({ slug: it.slug, key: hosted.find(it.slug).key, title: it.title, startsAt: it.startsAt, tz: it.tz, thumbId: it.thumbId });
    }
    if (gone) toast(`${gone} invite${gone > 1 ? "s were" : " was"} deleted or expired, so we removed ${gone > 1 ? "them" : "it"}.`);
    draw();
  } catch { /* offline: cached list is fine */ }
}

// ======================================================= Create
const MAX_COVER = 560_000, MAX_THUMB = 70_000;
let cover = null; // { blob, thumb, w, h }

async function decode(file) {
  try { return await createImageBitmap(file, { imageOrientation: "from-image" }); } catch {}
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return img;
  } finally { URL.revokeObjectURL(url); }
}

async function encode(src, maxSide, maxBytes) {
  const sw = src.width, sh = src.height;
  const scale = Math.min(1, maxSide / Math.max(sw, sh));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(sw * scale);
  canvas.height = Math.round(sh * scale);
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(src, 0, 0, canvas.width, canvas.height);
  const toBlob = (type, q) => new Promise((r) => canvas.toBlob(r, type, q));
  let type = "image/webp";
  let q = 0.82;
  let blob = await toBlob(type, q);
  if (!blob || blob.type !== "image/webp") { type = "image/jpeg"; blob = await toBlob(type, q); } // Safari can't encode WebP
  while (blob && blob.size > maxBytes && q > 0.4) { q -= 0.1; blob = await toBlob(type, q); }
  if (!blob || blob.size > maxBytes) throw new Error("That photo is too detailed to shrink. Try another one.");
  return { blob, w: canvas.width, h: canvas.height };
}

function setupCreate() {
  const form = $("#create-form");
  const btn = $("#create-btn");
  const err = $("#create-error");
  const drop = $("#drop");
  const input = $("#photo");
  const date = $("#date");

  const today = new Date();
  date.min = new Date(today.getTime() - today.getTimezoneOffset() * 60e3).toISOString().slice(0, 10);
  const savedName = store.get("hither:hostName", "");
  if (savedName) $("#host_name").value = savedName;

  const ready = () => {
    btn.disabled = !(cover && form.title.value.trim() && form.host_name.value.trim() && form.date.value && form.time.value);
  };
  form.addEventListener("input", ready);

  input.addEventListener("change", async () => {
    const file = input.files?.[0];
    if (!file) return;
    showError(err, "");
    drop.classList.add("busy");
    try {
      const bmp = await decode(file);
      const big = await encode(bmp, 1600, MAX_COVER);
      const small = await encode(bmp, 400, MAX_THUMB);
      cover = { blob: big.blob, thumb: small.blob, w: big.w, h: big.h };
      const prev = $("#photo-preview");
      if (prev.src) URL.revokeObjectURL(prev.src);
      prev.src = URL.createObjectURL(big.blob);
      $("#photo-size").textContent = `Optimized · ${Math.round(big.blob.size / 1024)} KB`;
      drop.querySelector(".drop-empty").hidden = true;
      drop.querySelector(".drop-full").hidden = false;
      drop.classList.add("has");
    } catch (e) {
      cover = null;
      showError(err, e?.message?.startsWith("That photo") ? e.message
        : "We couldn't read that photo. Try a JPG or PNG. On iPhone, picking from Photos in Safari works best.");
    } finally {
      drop.classList.remove("busy");
      input.value = "";
      ready();
    }
  });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (btn.disabled) return;
    showError(err, "");
    btn.classList.add("busy");
    btn.textContent = "Creating…";
    try {
      const fd = new FormData(form);
      const ext = cover.blob.type === "image/webp" ? "webp" : "jpg";
      fd.append("image", cover.blob, `cover.${ext}`);
      fd.append("thumb", cover.thumb, `thumb.${ext}`);
      fd.append("w", cover.w);
      fd.append("h", cover.h);
      fd.append("tz", Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
      const r = await api("/api/events", { method: "POST", form: fd });
      store.set("hither:hostName", form.host_name.value.trim());
      hosted.save({ slug: r.slug, key: r.hostKey, title: r.title, startsAt: r.startsAt, tz: r.tz, thumbId: r.thumbId });
      location.href = `/e/${r.slug}/manage?new=1#k=${encodeURIComponent(r.hostKey)}`;
    } catch (e2) {
      showError(err, e2.message);
      window.turnstile?.reset?.();
      btn.classList.remove("busy");
      btn.textContent = "Create invite";
    }
  });
  ready();
}

renderYours();
setupCreate();
