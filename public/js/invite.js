import { $, $$, api, hosted, store, showError, toast, confirmSheet } from "./lib.js";

const main = $("main.invite");
const slug = main?.dataset.slug;

// Host viewing their own invite → offer the dashboard.
const mine = slug && hosted.find(slug);
if (mine && $("#hostbar")) {
  const bar = $("#hostbar");
  bar.href = `/e/${slug}/manage#k=${encodeURIComponent(mine.key)}`;
  bar.hidden = false;
}

// Personal link: bind this device to the guest, then strip ?g= from the address bar.
let bound = Promise.resolve();
if (main?.dataset.token) {
  bound = api(`/api/e/${slug}/join`, { method: "POST", body: { token: main.dataset.token } })
    .then(() => {
      store.set("hither:name", main.dataset.name || store.get("hither:name", ""));
      history.replaceState(null, "", location.pathname + location.hash);
    })
    .catch((e) => toast(e.message));
}

// Name gate.
const joinForm = $("#join-form");
if (joinForm) {
  const err = $("#join-error");
  const name = $("#name");
  name.value = store.get("hither:name", "");
  joinForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    showError(err, "");
    const btn = joinForm.querySelector("button[type=submit]");
    btn.classList.add("busy");
    try {
      const turnstile = joinForm.querySelector("[name='cf-turnstile-response']")?.value;
      await api(`/api/e/${slug}/join`, { method: "POST", body: { name: name.value, turnstile } });
      store.set("hither:name", name.value.trim());
      location.reload();
    } catch (e2) {
      showError(err, e2.message);
      window.turnstile?.reset?.();
      btn.classList.remove("busy");
    }
  });
}

$("#refresh")?.addEventListener("click", () => location.reload());

// RSVP.
for (const b of $$("[data-rsvp]")) {
  b.addEventListener("click", async () => {
    if (b.classList.contains("on")) return;
    $$("[data-rsvp]").forEach((x) => { x.classList.toggle("on", x === b); x.setAttribute("aria-pressed", String(x === b)); });
    try {
      await bound;
      await api(`/api/e/${slug}/rsvp`, { method: "POST", body: { rsvp: b.dataset.rsvp } });
      location.reload();
    } catch (e) {
      toast(e.message);
      setTimeout(() => location.reload(), 1800);
    }
  });
}

// Comments.
const cform = $("#comment-form");
if (cform) {
  const ta = $("#body");
  const err = $("#comment-error");
  const grow = () => { ta.style.height = "auto"; ta.style.height = Math.min(ta.scrollHeight, 160) + "px"; };
  ta.addEventListener("input", grow);
  ta.addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) cform.requestSubmit(); });
  cform.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!ta.value.trim()) return;
    showError(err, "");
    const btn = cform.querySelector(".send");
    btn.classList.add("busy");
    try {
      await bound;
      await api(`/api/e/${slug}/comments`, { method: "POST", body: { body: ta.value } });
      sessionStorage.setItem("hither:scroll", "comments");
      location.reload();
    } catch (e2) {
      if (e2.status === 429) toast(e2.message); else showError(err, e2.message);
      btn.classList.remove("busy");
    }
  });
}
try {
  if (sessionStorage.getItem("hither:scroll") === "comments") {
    sessionStorage.removeItem("hither:scroll");
    $("#comment-form")?.scrollIntoView({ block: "center" });
  }
} catch {}

// Report.
$("#report")?.addEventListener("click", async () => {
  const ok = await confirmSheet({
    title: "Report this invite?",
    text: "Use this for spam, scams or anything harmful. Invites with several reports are hidden until reviewed.",
    ok: "Report", danger: true,
  });
  if (!ok) return;
  try { await api(`/api/e/${slug}/report`, { method: "POST" }); toast("Thanks. We'll take a look."); }
  catch (e) { toast(e.message); }
});
