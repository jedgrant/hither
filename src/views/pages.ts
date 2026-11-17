import { html, raw } from "hono/html";
import type { HtmlEscapedString } from "hono/utils/html";
import type { CommentView, EventRow, GuestRow } from "../lib/data";
import { ago, avatarHue, firstName, fmtDate, initials, tzLabel } from "../lib/util";

type H = HtmlEscapedString | Promise<HtmlEscapedString>;

const ASSET_V = "1"; // bump to bust browser caches of CSS/JS

export const icon = (name: string, cls = "i") => html`<svg class="${cls}" aria-hidden="true"><use href="/icons.svg#${name}"/></svg>`;

const av = (name: string, cls = "") =>
  html`<span class="av a${avatarHue(name)} ${cls}" aria-hidden="true">${initials(name)}</span>`;

export function layout(o: {
  title: string; description?: string; image?: string; origin: string; path: string;
  body: H; script?: string; turnstile?: boolean; noindex?: boolean;
}) {
  return html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${o.title}</title>
<meta name="theme-color" content="#f4eee5">
${o.noindex ? raw('<meta name="robots" content="noindex">') : ""}
<meta property="og:type" content="website">
<meta property="og:title" content="${o.title}">
${o.description ? html`<meta property="og:description" content="${o.description}"><meta name="description" content="${o.description}">` : ""}
${o.image ? html`<meta property="og:image" content="${o.origin}${o.image}"><meta name="twitter:card" content="summary_large_image">` : ""}
<meta property="og:url" content="${o.origin}${o.path}">
<link rel="preload" href="/fonts/fraunces.woff2" as="font" type="font/woff2" crossorigin>
<link rel="preload" href="/fonts/geist.woff2" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="/app.css?v=${ASSET_V}">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
${o.script ? html`<script type="module" src="/js/${o.script}.js?v=${ASSET_V}"></script>` : ""}
${o.turnstile ? raw('<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>') : ""}
</head>
<body>
${o.body}
</body>
</html>`;
}

const turnstileBox = (sitekey?: string) =>
  sitekey ? html`<div class="cf-turnstile" data-sitekey="${sitekey}" data-size="flexible" data-appearance="interaction-only"></div>` : "";

// ---------------------------------------------------------------- home

export function homePage(sitekey?: string) {
  return html`
<main class="page home">
  <header class="topbar"><a class="brand" href="/">hither</a><span class="muted">No sign-up needed</span></header>

  <section id="yours" class="yours" hidden></section>

  <section class="create" id="create">
    <h1 class="hero">Make an <em>invite.</em></h1>
    <p class="lede">Photo, title, date. Send the link. That's it.</p>

    <form id="create-form" novalidate>
      <label class="drop" id="drop">
        <input type="file" id="photo" accept="image/*" class="sr-only">
        <span class="drop-empty">
          <span class="ic">${icon("img")}</span>
          <b>Add a cover photo</b>
          <span class="muted">Tap to choose a photo</span>
          <span class="req">Required</span>
          <span class="drop-tip">For best results, use a photo without the date, time or address on it. We show those for you.</span>
        </span>
        <span class="drop-full" hidden>
          <img id="photo-preview" alt="">
          <span class="chip ok">${icon("check", "i sm")}<span id="photo-size">Ready</span></span>
          <span class="chip replace">Replace</span>
        </span>
      </label>

      <div class="field"><label class="label" for="title">What's happening?</label>
        <input class="input display" id="title" name="title" maxlength="80" placeholder="Taco night at Ana's" autocomplete="off" required></div>
      <div class="field"><label class="label" for="host_name">Your name <span class="opt">· shown as "… invited you"</span></label>
        <input class="input" id="host_name" name="host_name" maxlength="40" placeholder="Ana" autocomplete="given-name" required></div>
      <div class="field two">
        <div><label class="label" for="date">Date</label><input class="input" type="date" id="date" name="date" required></div>
        <div><label class="label" for="time">Time</label><input class="input" type="time" id="time" name="time" value="19:00" required></div>
      </div>
      <details class="more">
        <summary>${icon("plus")}Add location or a note</summary>
        <div class="field"><label class="label" for="location">Where <span class="opt">· optional, only shown to guests</span></label>
          <input class="input" id="location" name="location" maxlength="120" placeholder="Ana's place, 4th floor"></div>
        <div class="field"><label class="label" for="note">Note <span class="opt">· optional</span></label>
          <textarea class="input area" id="note" name="note" maxlength="500" rows="3" placeholder="Bring a dish or a bottle."></textarea></div>
      </details>
      ${turnstileBox(sitekey)}
      <p class="form-error" id="create-error" role="alert" hidden></p>
      <button class="btn primary block" id="create-btn" type="submit" disabled>Create invite</button>
      <p class="fine">Invites delete themselves 30 days after the event.</p>
    </form>
  </section>
</main>`;
}

// ---------------------------------------------------------------- invite

export type InviteCtx = {
  ev: EventRow;
  me: GuestRow | null;
  state: "gate" | "waiting" | "in";
  pendingToken?: string;   // personal link not yet bound to this device
  going: { id: string; name: string }[];
  counts: { yes: number; no: number };
  comments: CommentView[];
  hasList?: boolean;       // host added names: ask for first name and match
  sitekey?: string;
};

function hero(ev: EventRow, small = false) {
  const mon = fmtDate(ev.starts_at, ev.tz, { month: "short" }).toUpperCase();
  const day = fmtDate(ev.starts_at, ev.tz, { day: "numeric" });
  return html`
  <div class="inv-hero${small ? " small" : ""}">
    <img src="/img/${ev.image_id}" alt="" ${ev.image_w ? html`width="${ev.image_w}" height="${ev.image_h}"` : ""} fetchpriority="high">
    <div class="datechip"><small>${mon}</small><b>${day}</b></div>
    <div class="from">${ev.host_name} invited you</div>
  </div>`;
}

const whenLine = (ev: EventRow) =>
  `${fmtDate(ev.starts_at, ev.tz, { weekday: "long", month: "long", day: "numeric" })} · ${fmtDate(ev.starts_at, ev.tz, { hour: "numeric", minute: "2-digit" })}`;

const shortWhen = (ev: EventRow) =>
  `${fmtDate(ev.starts_at, ev.tz, { weekday: "short", month: "short", day: "numeric" })} · ${fmtDate(ev.starts_at, ev.tz, { hour: "numeric", minute: "2-digit" })}`;

export function invitePage(c: InviteCtx) {
  const { ev } = c;
  const past = new Date(ev.starts_at).getTime() + 6 * 3600e3 < Date.now();
  const hostbar = html`<a class="hostbar" id="hostbar" href="/e/${ev.slug}/manage" hidden>${icon("key")}You're the host · Open dashboard</a>`;

  if (c.state === "gate") {
    return html`
<main class="invite" data-slug="${ev.slug}">
  ${hostbar}
  ${hero(ev)}
  <div class="sheet">
    <h1>${ev.title}</h1>
    <div class="meta"><span>${icon("cal")}${shortWhen(ev)}</span></div>
    <form class="card gate" id="join-form">
      <h2>First, who are you?</h2>
      <p class="sub">${c.hasList
        ? `Type your first name. If ${firstName(ev.host_name)} added you, you'll be matched up.`
        : `${firstName(ev.host_name)} will see your name next to your answer.`}</p>
      <label class="sr-only" for="name">${c.hasList ? "Your first name" : "Your name"}</label>
      <input class="input" id="name" name="name" maxlength="40" placeholder="${c.hasList ? "Your first name" : "Your name"}"
        autocomplete="${c.hasList ? "given-name" : "name"}" autocapitalize="words" required>
      <div class="initial-step" id="initial-step" hidden>
        <label class="label" for="initial" id="initial-label">What's your last initial?</label>
        <input class="input initial" id="initial" name="initial" maxlength="1" autocomplete="off" autocapitalize="characters">
      </div>
      ${turnstileBox(c.sitekey)}
      <p class="form-error" id="join-error" role="alert" hidden></p>
      <button class="btn primary block" type="submit">Continue</button>
    </form>
    <div class="locked" aria-label="Unlocks after you add your name">
      ${ev.location ? html`<div>${icon("pin")}Location<i></i>${icon("lock")}</div>` : ""}
      ${ev.show_guests ? html`<div>${icon("users")}Who's coming<i></i>${icon("lock")}</div>` : ""}
      <div>${icon("chat")}${c.comments.length ? `${c.comments.length} comments` : "Comments"}<i></i>${icon("lock")}</div>
    </div>
    ${footer()}
  </div>
</main>`;
  }

  if (c.state === "waiting") {
    const declined = c.me?.access === "declined";
    return html`
<main class="invite" data-slug="${ev.slug}">
  ${hero(ev, true)}
  <div class="sheet">
    <h1>${ev.title}</h1>
    <div class="meta"><span>${icon("cal")}${shortWhen(ev)}</span></div>
    <div class="card wait">
      <div class="ring">${icon("hourglass")}</div>
      <h2>Thanks, ${firstName(c.me?.name ?? "")}</h2>
      <p>This invite is guest-list only. ${firstName(ev.host_name)} will see your request, and this page will open up once you're in.</p>
      ${declined ? "" : html`<button class="btn ghost sm" id="refresh" type="button">Check again</button>`}
    </div>
    <p class="fine">Same browser, same link: no need to ask twice.</p>
    ${footer()}
  </div>
</main>`;
  }

  // ---- in
  const me = c.me!;
  const host = firstName(ev.host_name);
  const heading = me.rsvp === "yes" ? "You're going" : me.rsvp === "no" ? "You can't make it" : "Can you make it?";
  const mapUrl = ev.location ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(ev.location)}` : "";

  return html`
<main class="invite" data-slug="${ev.slug}" ${c.pendingToken ? html`data-token="${c.pendingToken}"` : ""} data-name="${me.name}">
  ${hostbar}
  ${hero(ev, true)}
  <div class="sheet">
    ${c.pendingToken || me.source === "list"
      ? html`<div class="personal">${av(me.name, "lg")}<span><b>Hi ${firstName(me.name)}</b>${host} saved you a spot.</span></div>`
      : html`<span class="welcome">${av(me.name, "xs")}${me.rsvp ? "Welcome back, " : "Hi, "}${firstName(me.name)}</span>`}
    <h1>${ev.title}</h1>
    <div class="when">
      <div><span class="ib">${icon("clock")}</span><span>${whenLine(ev)}<small>${tzLabel(ev.starts_at, ev.tz)} · <a href="/e/${ev.slug}/cal.ics">Add to calendar</a></small></span></div>
      ${ev.location ? html`<div><span class="ib">${icon("pin")}</span><span>${ev.location}<small><a href="${mapUrl}" target="_blank" rel="noopener noreferrer">Open in Maps</a></small></span></div>` : ""}
    </div>
    ${ev.note ? html`<p class="note">${ev.note}</p>` : ""}

    ${past
      ? html`<div class="past-ribbon">${icon("clock")}This happened on ${fmtDate(ev.starts_at, ev.tz, { month: "short", day: "numeric" })}. ${c.counts.yes} ${c.counts.yes === 1 ? "person" : "people"} went. Comments are still open.</div>`
      : html`
    <div class="card rsvp" id="rsvp">
      <h2>${heading}</h2>
      <div class="choices">
        <button class="choice yes${me.rsvp === "yes" ? " on" : ""}" data-rsvp="yes" type="button" aria-pressed="${me.rsvp === "yes"}">${me.rsvp === "yes" ? icon("check") : ""}I'm in</button>
        <button class="choice no${me.rsvp === "no" ? " on" : ""}" data-rsvp="no" type="button" aria-pressed="${me.rsvp === "no"}">Can't make it</button>
      </div>
    </div>`}

    ${ev.show_guests
      ? html`
    <div class="sec"><h3>Who's coming</h3><span class="muted">${c.counts.yes} going</span></div>
    <div class="names">
      <span class="nchip">${av(ev.host_name)}${host} · host</span>
      ${c.going.map((g) => html`<span class="nchip">${av(g.name)}${g.id === me.id ? "You" : firstName(g.name)}</span>`)}
    </div>
    ${c.counts.yes === 0 ? html`<p class="cant-line">Be the first to say yes.</p>` : ""}
    ${c.counts.no ? html`<p class="cant-line">${c.counts.no} can't make it</p>` : ""}`
      : html`<p class="cant-line counts">${c.counts.yes} going · ${c.counts.no} can't make it</p>`}

    <div class="sec" id="comments"><h3>Comments</h3><span class="muted">${c.comments.length || ""}</span></div>
    ${c.comments.length === 0 ? html`<p class="cant-line">No comments yet. Say hi.</p>` : ""}
    ${c.comments.map((cm) => commentItem(cm, ev.host_name))}
    <form class="compose" id="comment-form">
      <label class="sr-only" for="body">Comment</label>
      <textarea id="body" name="body" rows="1" maxlength="500" placeholder="Say something…" required></textarea>
      <button class="send" type="submit" aria-label="Send">${icon("send")}</button>
    </form>
    <p class="form-error" id="comment-error" role="alert" hidden></p>
    ${footer(true)}
  </div>
  <div class="toast" id="toast" role="status" hidden></div>
</main>`;
}

export function commentItem(cm: CommentView, hostName: string) {
  const isHost = !cm.guest_id;
  const name = isHost ? hostName : cm.name ?? "Guest";
  return html`
    <div class="cmt">${av(name)}<div class="bubble"><div class="who">${firstName(name)}
      ${isHost ? html`<span class="tag host">Host</span>` : cm.rsvp === "yes" ? html`<span class="tag">Going</span>` : cm.rsvp === "no" ? html`<span class="tag no">Can't</span>` : ""}
      <small>${ago(cm.created_at)}</small></div><p>${cm.body}</p></div></div>`;
}

function footer(report = false) {
  return html`<footer class="foot"><a class="brand" href="/">hither</a><span><a href="/">Make your own</a>${report ? html` · <button class="linkbtn" id="report" type="button">Report</button>` : ""}</span></footer>`;
}

// ---------------------------------------------------------------- manage

export function managePage(ev: EventRow) {
  return html`
<main class="page manage" id="manage" data-slug="${ev.slug}">
  <div class="loading" id="manage-loading"><span class="spinner"></span></div>
</main>`;
}

// ---------------------------------------------------------------- messages

export function messagePage(o: { glyph: string; title: string; text: string; cta?: boolean }) {
  return html`
<main class="page center">
  <div>
    <div class="glyph">${o.glyph}</div>
    <h1>${o.title}</h1>
    <p>${o.text}</p>
    ${o.cta === false ? "" : html`<a class="btn primary" href="/">Make your own invite</a>`}
  </div>
</main>`;
}
