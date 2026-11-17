import { $, h, icon, api, hosted, toast, copy, share, sheet, confirmSheet, av, first, fmtWhen, ago, showError } from "./lib.js";

const root = $("#manage");
const slug = root.dataset.slug;
const origin = location.origin;
const shareUrl = `${origin}/e/${slug}`;

// ---------- host key: from #k=… (then hidden from the address bar) or this device ----------
const params = new URLSearchParams(location.hash.slice(1));
let key = params.get("k") || hosted.find(slug)?.key || "";
let isNew = new URLSearchParams(location.search).has("new");
if (location.hash || location.search) history.replaceState(null, "", location.pathname);
const hostUrl = () => `${origin}/e/${slug}/manage#k=${encodeURIComponent(key)}`;

let data = null;
let tab = "guests";

async function load() {
  try {
    data = await api(`/api/e/${slug}/host`, { key });
  } catch (e) {
    if (e.status === 403) {
      root.replaceChildren(h("div.center", h("div",
        h("div.glyph", "?"), h("h1", "That host link doesn't work"),
        h("p", "Use the full host link you saved when you made the invite. It ends with #k=…"),
        h("a.btn.primary", { href: "/" }, "Go to your invites"))));
    } else {
      root.replaceChildren(h("div.center", h("div", h("h1", "Couldn't load your invite"), h("p", e.message),
        h("button.btn.primary", { type: "button", onclick: () => location.reload() }, "Try again"))));
    }
    return;
  }
  const ev = data.event;
  hosted.save({ slug, key, title: ev.title, startsAt: ev.starts_at, tz: ev.tz, thumbId: ev.thumb_id });
  render();
}

async function act(fn, okMsg) {
  try { await fn(); if (okMsg) toast(okMsg); await load(); }
  catch (e) { toast(e.message); }
}
const post = (path, body) => api(`/api/e/${slug}${path}`, { method: "POST", key, body: body || {} });
const patch = (body) => api(`/api/e/${slug}`, { method: "PATCH", key, body });

// ---------- derived ----------
function groups() {
  const gs = data.guests.map((g) => ({ ...g, blocked: !!g.shadow }));
  const live = gs.filter((g) => !g.blocked);
  return {
    all: gs,
    listCount: gs.filter((g) => g.source === "list").length,
    pending: live.filter((g) => g.access === "pending"),
    going: live.filter((g) => g.access === "in" && g.rsvp === "yes"),
    noreply: live.filter((g) => g.access === "in" && !g.rsvp),
    cant: live.filter((g) => g.access === "in" && g.rsvp === "no"),
    declined: live.filter((g) => g.access === "declined"),
    blocked: gs.filter((g) => g.blocked),
  };
}
const personalUrl = (g) => `${shareUrl}?g=${g.invite_token}`;

// ---------- render ----------
function render() {
  const ev = data.event;
  const G = groups();
  const when = fmtWhen(ev.starts_at, ev.tz, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

  root.replaceChildren(...[
    h("header.topbar", h("a.brand", { href: "/" }, "hither"), h("a.link", { href: `/e/${slug}` }, "View as guest")),
    isNew ? liveCard(ev) : null,
    h("div.mhead",
      h("div.thumb", h("img", { src: `/img/${ev.thumb_id}`, alt: "" })),
      h("div", { style: "flex:1;min-width:0" }, h("span.hostpill", "You're the host"), h("h1", ev.title), h("div.sub", when))),
    ev.status === "reported" ? h("div.form-error", "This invite was reported several times and is hidden from guests until it's reviewed.") : null,
    h("div.stats",
      h("div.card.stat.yes", h("b", G.going.length), h("span", "Going")),
      h("div.card.stat", h("b", G.cant.length), h("span", "Can't")),
      h("div.card.stat", h("b", G.noreply.length), h("span", "No reply"))),
    h("div.actions",
      h("button.btn.ink.sm", { type: "button", onclick: () => share(shareUrl, ev.title, `${ev.host_name} invited you`) }, icon("share"), "Share invite"),
      h("button.btn.ghost.sm", { type: "button", onclick: () => copy(shareUrl, "Invite link copied") }, icon("copy"), "Copy link")),
    h("div.tabs", { role: "tablist" },
      tabBtn("guests", `Guests · ${G.all.length}`),
      tabBtn("comments", `Comments · ${data.comments.length}`),
      tabBtn("settings", "Settings")),
    h("div#tab", tab === "guests" ? guestsTab(G) : tab === "comments" ? commentsTab() : settingsTab(ev)),
  ].filter(Boolean));
}

const tabBtn = (id, label) =>
  h("button", { type: "button", role: "tab", "aria-selected": String(tab === id), onclick: () => { tab = id; render(); } }, label);

function liveCard(ev) {
  return h("section.live",
    h("h2", "It's live. ", h("em", "Send it.")),
    h("div.linkbox", h("code", shareUrl.replace(/^https?:\/\//, "")),
      h("button.btn.ink.xs", { type: "button", onclick: () => copy(shareUrl, "Invite link copied") }, icon("copy", "i sm"), "Copy")),
    h("button.btn.primary.block", { type: "button", style: "margin-top:12px", onclick: () => share(shareUrl, ev.title, `${ev.host_name} invited you`) }, icon("share"), "Share invite"),
    h("div.hostkey",
      h("h4", icon("key"), "Save your host link"),
      h("p", "It's the only way back to this page to see replies or block someone. It's saved under Your invites in this browser too, but there's no account to recover it."),
      h("div.linkbox", h("code", `${shareUrl.replace(/^https?:\/\//, "")}/manage#k=••••••`),
        h("button.btn.ghost.xs", { type: "button", onclick: () => copy(hostUrl(), "Host link copied. Keep it somewhere safe.") }, "Copy"))),
    h("div.row", { style: "display:flex;justify-content:flex-end;margin-top:10px" },
      h("button.link", { type: "button", onclick: () => { isNew = false; render(); } }, "Hide this")),
  );
}

// ---------- guests ----------
function guestsTab(G) {
  const ta = h("textarea.input.area#names", { rows: 3, placeholder: "Jordan Lee\nMel, Priya", "aria-label": "Names to invite" });
  const err = h("p.form-error", { hidden: true, role: "alert" });
  const addBtn = h("button.btn.ink.sm", {
    type: "button",
    onclick: async () => {
      const names = ta.value.split(/[\n,]+/).map((s) => s.trim()).filter(Boolean);
      if (!names.length) return showError(err, "Type at least one name.");
      addBtn.classList.add("busy");
      try { await post("/guests", { names }); toast(`Added ${names.length}. Send each person their link.`); await load(); }
      catch (e) { showError(err, e.message); addBtn.classList.remove("busy"); }
    },
  }, "Add");

  const listGuests = G.all.filter((g) => g.source === "list" && !g.blocked);
  const ev = data.event;

  return [
    h("section.card.addcard",
      h("h3", "Who's invited?"),
      h("p", "Optional. Type or paste names, one per line or separated by commas. Everyone gets their own link, so you'll know who hasn't replied."),
      ta, err,
      h("div.row",
        listGuests.length ? h("button.btn.ghost.sm", { type: "button", onclick: () => copy(listGuests.map((g) => `${g.name}: ${personalUrl(g)}`).join("\n"), "All personal links copied") }, icon("copy", "i sm"), "Copy all links") : null,
        addBtn),
      h("p", { style: "margin-top:12px" },
        ev.access === "list" ? "Only your list can RSVP; others ask to join. " : "Anyone with the link can RSVP after typing their name. ",
        h("button.link", { type: "button", onclick: () => { tab = "settings"; render(); } }, "Change"))),

    G.all.length === 0 ? h("div.empty", "No one yet. Share the link, or add names above.") : null,
    group("Asking to join", G.pending, G),
    group("Going", G.going, G),
    group("No reply yet", G.noreply, G),
    group("Can't make it", G.cant, G),
    group("Declined", G.declined, G),
    group("Blocked", G.blocked, G),
  ];
}

function group(title, list, G) {
  if (!list.length) return null;
  return [h("div.grp", `${title} · ${list.length}`), h("div.card.list", list.map((g) => guestRow(g, G)))];
}

function guestRow(g, G) {
  const notOnList = g.source === "link" && G.listCount > 0;
  let sub;
  if (g.blocked) sub = "Hidden from everyone. They don't know.";
  else if (g.access === "pending") sub = `Not on your list · ${ago(g.created_at)}`;
  else if (g.source === "list") sub = g.rsvp ? `Personal link · ${ago(g.updated_at)}` : g.opened_at ? "Opened the invite · not answered" : "Hasn't opened it yet";
  else sub = `Shared link · ${ago(g.updated_at)}`;
  if (g.source === "list" && g.devices > 1) sub += ` · opened on ${g.devices} devices`;

  let right;
  if (g.blocked) right = h("button.link", { type: "button", onclick: () => act(() => post(`/guests/${g.id}/unblock`), `${first(g.name)} unblocked`) }, "Unblock");
  else if (g.access === "pending")
    right = h("span.mini-btns",
      h("button.btn.ink.xs", { type: "button", onclick: () => act(() => post(`/guests/${g.id}/approve`), `${first(g.name)} can see the invite now`) }, "Let in"),
      h("button.btn.ghost.xs", { type: "button", onclick: () => act(() => post(`/guests/${g.id}/decline`)) }, "No"));
  else if (g.rsvp === "yes") right = h("span.pill.yes", "Going");
  else if (g.rsvp === "no") right = h("span.pill.no", "Can't");
  else if (g.source === "list") right = h("button.iconbtn", { type: "button", "aria-label": `Copy ${g.name}'s link`, onclick: () => copy(personalUrl(g), `${first(g.name)}'s link copied`) }, icon("copy"));

  return h("div.gr" + (g.blocked ? ".blocked" : ""),
    av(g.name),
    h("span.nm", h("span", g.name), notOnList && !g.blocked && g.access !== "pending" ? h("span.tag.warn", "Not on list") : null, h("small", sub)),
    right,
    h("button.iconbtn.bare", { type: "button", "aria-label": `Options for ${g.name}`, onclick: () => guestMenu(g, G) }, icon("more")));
}

function guestMenu(g, G) {
  sheet((p, close) => {
    const item = (label, sub, fn, cls = "") =>
      h("button" + cls, { type: "button", onclick: () => { close(); fn(); } }, h("span", label, sub ? h("small", sub) : null));
    const listTargets = G.all.filter((x) => x.source === "list" && x.id !== g.id && !x.blocked);
    p.append(h("h3", g.name), h("div.menu",
      g.source === "list" ? [
        item("Copy personal link", null, () => copy(personalUrl(g), `${first(g.name)}'s link copied`)),
        item("Share personal link", null, () => share(personalUrl(g), data.event.title, `${first(g.name)}, you're invited`)),
        item("Make a new link", "The old link stops working. Use this if it was forwarded.", () => act(() => post(`/guests/${g.id}/relink`), "New link made. Send it again.")),
      ] : null,
      g.source === "link" && listTargets.length ? item("This is someone on my list", "Merge them into the person you invited", () => mergeSheet(g, listTargets)) : null,
      g.access !== "in" && !g.blocked ? item("Let them in", null, () => act(() => post(`/guests/${g.id}/approve`))) : null,
      g.access === "pending" ? item("Decline", "They keep seeing the waiting screen", () => act(() => post(`/guests/${g.id}/decline`))) : null,
      g.blocked
        ? item("Unblock", null, () => act(() => post(`/guests/${g.id}/unblock`), "Unblocked"))
        : item("Block", "Hidden from everyone. They won't be told.", () => blockSheet(g), ".warn"),
      item("Remove from this invite", "Deletes them and their comments", async () => {
        if (await confirmSheet({ title: `Remove ${first(g.name)}?`, text: "Their answer and comments are deleted. If they still have the link, they can add their name again.", ok: "Remove", danger: true }))
          act(() => post(`/guests/${g.id}/remove`), "Removed");
      }, ".warn"),
    ));
  });
}

function mergeSheet(g, targets) {
  sheet((p, close) => {
    p.append(h("h3", `Who is "${g.name}"?`), h("p", "Their answer, comments and devices move to the person you pick."),
      h("div.menu", targets.map((t) => h("button", {
        type: "button",
        onclick: () => { close(); act(() => post(`/guests/${g.id}/merge`, { into: t.id }), `Merged into ${t.name}`); },
      }, av(t.name), h("span", t.name, h("small", t.rsvp === "yes" ? "Going" : t.rsvp === "no" ? "Can't" : "No reply yet"))))));
  });
}

function blockSheet(g, commentId) {
  sheet((p, close) => {
    const r1 = h("input", { type: "radio", name: "blk", value: "block", checked: true });
    const r2 = h("input", { type: "radio", name: "blk", value: "hide" });
    p.append(
      h("h3", `Block ${first(g.name)}?`),
      h("p", "They won't be told. Their page keeps working for them, but nobody else sees their answers or comments."),
      h("label.opt", r1, h("span", h("b", "Block this person"), h("small", "Their device and network. Recommended."))),
      commentId ? h("label.opt", r2, h("span", h("b", "Just hide this comment"), h("small", "They can keep commenting."))) : null,
      h("button.btn.ink.block", {
        type: "button",
        onclick: () => {
          close();
          if (commentId && r2.checked) act(() => post(`/comments/${commentId}/hide`, { hidden: true }), "Comment hidden");
          else act(() => post(`/guests/${g.id}/block`), `${first(g.name)} is blocked`);
        },
      }, "Block"),
      h("button.btn.plain.block", { type: "button", onclick: close }, "Cancel"));
  });
}

// ---------- comments ----------
function commentsTab() {
  const ev = data.event;
  const ta = h("textarea", { rows: 1, maxlength: 500, placeholder: "Post an update as the host…", "aria-label": "Host comment" });
  const form = h("form.compose", {
    onsubmit: async (e) => {
      e.preventDefault();
      if (!ta.value.trim()) return;
      await act(() => post("/host-comment", { body: ta.value }), "Posted");
    },
  }, ta, h("button.send", { type: "submit", "aria-label": "Post" }, icon("send")));

  const list = data.comments.map((c) => {
    const isHost = !c.guest_id;
    const name = isHost ? ev.host_name : c.name || "Guest";
    const guest = data.guests.find((g) => g.id === c.guest_id);
    return h("div.cmt" + (c.hidden || c.shadow ? ".dim" : ""),
      av(name),
      h("div.bubble",
        h("div.who", first(name),
          isHost ? h("span.tag.host", "Host") : c.rsvp === "yes" ? h("span.tag", "Going") : c.rsvp === "no" ? h("span.tag.no", "Can't") : null,
          c.hidden ? h("span.tag.dim", "Hidden") : null,
          c.shadow ? h("span.tag.dim", "Blocked") : null,
          h("small", ago(c.created_at))),
        h("p", c.body)),
      h("button.iconbtn.bare.host-actions", {
        type: "button", "aria-label": "Comment options",
        onclick: () => sheet((p, close) => {
          p.append(h("h3", "Comment"), h("div.menu",
            h("button", { type: "button", onclick: () => { close(); act(() => post(`/comments/${c.id}/hide`, { hidden: !c.hidden }), c.hidden ? "Comment visible again" : "Comment hidden"); } },
              h("span", c.hidden ? "Show comment" : "Hide comment", h("small", c.hidden ? null : "Only you will see it"))),
            guest && !guest.shadow ? h("button.warn", { type: "button", onclick: () => { close(); blockSheet(guest, c.id); } }, h("span", `Block ${first(name)}`)) : null));
        }),
      }, icon("more")));
  });
  return [form, list.length ? list : h("div.empty", "No comments yet.")];
}

// ---------- settings ----------
function settingsTab(ev) {
  const f = (id, label, el) => h("div.field", h("label.label", { for: id }, label), el);
  const title = h("input.input#s-title", { value: ev.title, maxlength: 80 });
  const hostName = h("input.input#s-host", { value: ev.host_name, maxlength: 40 });
  const date = h("input.input#s-date", { type: "date", value: ev.local_date });
  const time = h("input.input#s-time", { type: "time", value: ev.local_time });
  const loc = h("input.input#s-loc", { value: ev.location || "", maxlength: 120, placeholder: "Optional" });
  const note = h("textarea.input.area#s-note", { maxlength: 500, rows: 3, placeholder: "Optional" }, ev.note || "");
  const err = h("p.form-error", { hidden: true, role: "alert" });
  const save = h("button.btn.ink.block", {
    type: "button", style: "margin-top:16px",
    onclick: async () => {
      showError(err, "");
      save.classList.add("busy");
      try {
        await patch({ title: title.value, host_name: hostName.value, date: date.value, time: time.value, location: loc.value, note: note.value });
        toast("Saved");
        await load();
      } catch (e) { showError(err, e.message); save.classList.remove("busy"); }
    },
  }, "Save changes");

  const access = (value, label, sub) => h("label.seg-opt",
    h("input", { type: "radio", name: "access", value, checked: ev.access === value,
      onchange: () => act(() => patch({ access: value }), "Updated") }),
    h("span", h("b", label), h("small", sub)));

  return [
    h("div.grp", "Who can RSVP?"),
    h("div.card", access("open", "Anyone with the link", "People type their name first. You'll see who's not on your list."),
      access("list", "Only my list", "Everyone else asks to join and waits for your OK.")),
    h("label.card.toggle", h("span", "Guests can see who's going"),
      h("input.switch", { type: "checkbox", checked: !!ev.show_guests, onchange: (e) => act(() => patch({ show_guests: e.target.checked }), "Updated") })),

    h("div.grp", "Details"),
    h("div.settings",
      f("s-title", "Title", title), f("s-host", "Your name", hostName),
      h("div.field.two", h("div", h("label.label", { for: "s-date" }, "Date"), date), h("div", h("label.label", { for: "s-time" }, `Time (${ev.tz.replace(/_/g, " ")})`), time)),
      f("s-loc", "Where", loc), f("s-note", "Note", note), err, save),

    h("div.grp", "Your host link"),
    h("div.linkbox", h("code", `${shareUrl.replace(/^https?:\/\//, "")}/manage#k=••••••`),
      h("button.btn.ghost.xs", { type: "button", onclick: () => copy(hostUrl(), "Host link copied") }, "Copy")),

    h("div.danger-zone",
      h("button.btn.ghost.block", {
        type: "button", style: "color:var(--no);border-color:var(--no-soft)",
        onclick: async () => {
          if (!(await confirmSheet({ title: "Delete this invite?", text: "The invite, photo, replies and comments are deleted for good. The link stops working.", ok: "Delete invite", danger: true }))) return;
          try { await api(`/api/e/${slug}`, { method: "DELETE", key }); hosted.remove(slug); location.href = "/"; }
          catch (e) { toast(e.message); }
        },
      }, icon("trash"), "Delete invite")),
  ];
}

if (!key) {
  root.replaceChildren(h("div.center", h("div",
    h("div.glyph", "?"), h("h1", "Open your host link"),
    h("p", "This page needs the host link you saved when you made the invite. It ends with #k=…"),
    h("a.btn.primary", { href: `/e/${slug}` }, "View the invite"))));
} else {
  load();
}
