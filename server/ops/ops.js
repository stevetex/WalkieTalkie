// Over&Out Ops: fills the page from /api/live (every 5 s) and /api/summary (every 60 s), both
// paused while the tab is hidden so the service can scale back to zero. Every number comes from
// the ops service; nothing here holds a token. OPS_DASHBOARD_SPEC.md defines each number.
"use strict";

(() => {
  const TIERS = {
    live: { label: "Live", every: 5_000 },
    near: { label: "Near-live", every: 60_000 },
    rolling: { label: "Rolling", every: 15 * 60_000 },
    daily: { label: "Daily", every: 24 * 3_600_000 },
  };
  const SIG = { live: "s4", near: "s3", rolling: "s2", daily: "s1" };
  const KINDS = ["ios", "watchos", "android", "wearos"];
  const KIND_NAME = { ios: "iPhone", watchos: "Apple Watch", android: "Android phone", wearos: "Wear OS watch", unknown: "Unknown" };
  // The usage snapshot's device labels (Apple's kept from before Phase 0).
  const DEVICE_LABEL = { iphone: "iPhone", watch: "Apple Watch", android: "Android phone", wearos: "Wear OS watch" };
  const RING_NAME = { "apns/alert": "APNs alert", "apns/pushtotalk": "PushToTalk", "fcm/notification": "FCM", "relay/foreground": "In-app", "test/connection": "Over its connection" };
  const STEP = {
    watchTap: ["Watch: tap → first audio", "app closed, ring notification"],
    watchAnswer: ["Watch: in-app Answer → first audio", "app open"],
    phonePush: ["iPhone: push sent → first audio", "PushToTalk, no tap"],
    firstPress: ["First press → go-ahead", "the caller's talk button"],
    ringShown: ["Ring sent → ring shown", "push delivery to the device"],
  };
  const SERIES = ["var(--series2)", "var(--accent-fill)", "var(--series3)", "var(--good)"];

  const state = { range: "today", withBot: false, live: null, summary: null, reports: null, pending: {}, timers: [] };

  // ---- Formatting ----
  const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const num = (n, digits = 0) => (n === undefined || n === null || !Number.isFinite(n) ? "–" : n.toLocaleString("en-US", { maximumFractionDigits: digits, minimumFractionDigits: digits }));
  const pct = (part, whole, digits = 0) => (whole ? `${num((part / whole) * 100, digits)}%` : "–");
  const sec = (ms, digits = 2) => (ms === undefined || ms === null ? "–" : (ms / 1000).toFixed(digits));
  const clock = (ms) => new Date(ms).toISOString().slice(11, 19);
  const hhmm = (ms) => new Date(ms).toISOString().slice(11, 16);
  const ago = (ms) => {
    const s = Math.max(0, Math.round(ms / 1000));
    if (s < 3600) return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
    if (s < 86_400) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
    return `${Math.floor(s / 86_400)}d ${Math.floor((s % 86_400) / 3600)}h`;
  };
  const bytes = (b) => (b === undefined ? "–" : b >= 2 ** 30 ? `${num(b / 2 ** 30, 1)} GiB` : b >= 2 ** 20 ? `${num(b / 2 ** 20, 1)} MB` : `${num(b / 1024, 0)} KB`);
  const sum = (o) => Object.values(o || {}).reduce((n, v) => n + (Number(v) || 0), 0);
  const $ = (id) => document.getElementById(id);
  const set = (id, html) => { const el = $(id); if (el) el.innerHTML = html; };
  const pill = (cls, text, pulse = false) => `<span class="pill ${cls}">${pulse ? '<span class="pulse"></span>' : ""}${esc(text)}</span>`;
  const kv = (rows) => `<dl class="kv">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("")}</dl>`;
  const stack = (parts) => {
    const total = parts.reduce((n, p) => n + p[1], 0);
    const spans = total ? parts.map((p, i) => `<span style="width:${(p[1] / total) * 100}%;background:${p[2] || SERIES[i % SERIES.length]}"></span>`).join("") : "";
    return `<div class="stack" aria-hidden="true">${spans}</div><div class="keys">${parts.map((p, i) => `<span class="${p[1] ? "" : "zero"}"><i style="background:${p[2] || SERIES[i % SERIES.length]}"></i>${esc(p[0])} <b>${num(p[1])}</b></span>`).join("")}</div>`;
  };
  const counter = (title, value, extra = "") => `<div class="counter"><span class="t">${title}${extra}</span><span class="v">${value}</span></div>`;

  function spark(values, label) {
    const pts = values.map((v, i) => [i, v]).filter((p) => typeof p[1] === "number");
    if (pts.length < 2) return `<svg class="spark" viewBox="0 0 300 44" aria-label="${esc(label)}: not enough days yet"></svg>`;
    const max = Math.max(...pts.map((p) => p[1]), 1);
    const n = Math.max(values.length - 1, 1);
    const xy = pts.map(([i, v]) => [(i / n) * 296 + 2, 40 - (v / max) * 34]);
    const line = xy.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join("");
    const last = xy[xy.length - 1];
    return `<svg class="spark" viewBox="0 0 300 44" preserveAspectRatio="none" role="img" aria-label="${esc(label)}"><line class="grid" x1="0" x2="300" y1="40" y2="40"/><path class="area" d="${line}L${last[0].toFixed(1)},40L${xy[0][0].toFixed(1)},40Z"/><path class="line" d="${line}"/><circle class="end" cx="${last[0].toFixed(1)}" cy="${last[1].toFixed(1)}" r="2.5"/></svg>`;
  }

  // ---- Freshness ----
  function freshness(tier, producedAt) {
    for (const el of document.querySelectorAll(`.fresh[data-tier="${tier}"]`)) {
      const t = TIERS[tier];
      const stale = !producedAt || Date.now() - producedAt > 2 * t.every;
      el.classList.toggle("stale", stale);
      const every = tier === "live" ? "5 s" : tier === "near" ? "1 min" : tier === "rolling" ? "15 min" : "00:30 UTC";
      el.innerHTML = `<span class="sig ${SIG[tier]}"><i></i><i></i><i></i><i></i></span>${t.label} · ${every}${producedAt ? ` <time>${tier === "daily" ? new Date(producedAt).toISOString().slice(0, 10) : `${hhmm(producedAt)} UTC`}</time>` : " <time>no data yet</time>"}`;
    }
  }

  // ---- Right now ----
  function renderLive() {
    const L = state.live;
    if (!L) return;
    $("updated").textContent = `Live · ${clock(L.now)} UTC`;
    if (L.user) $("who").textContent = `Signed in as ${L.user}`;
    $("nodes").textContent = `${L.nodes.map((n) => n.node || new URL(n.url).hostname).join(", ")} · api · Firestore`;
    const answering = L.nodes.filter((n) => n.ok).length;
    freshness("live", answering ? L.now : null);
    const c = L.conversations;
    const today = state.summary && state.summary.today;
    const peak = [L.peaks.conversations, today && today.peaks && today.peaks.conversations].filter(Boolean).sort((a, b) => b.value - a.value)[0];
    set("card-open", `<div class="hrow"><h3>Open conversations</h3>${c.talking ? pill("ok", "On air", true) : pill("idle", "Quiet")}</div>
      <div class="big">${num(c.open)}</div>
      ${stack([["Talking", c.talking, "var(--accent-fill)"], ["Ringing", c.ringing, "var(--series2)"], ["Waiting for a reply", c.waiting, "var(--series3)"]])}
      <div class="note">Open from the first talk-start until the relay forgets the conversation. ${peak && peak.value ? `<b>Peak today ${num(peak.value)}</b> at ${hhmm(peak.at)} UTC.` : ""}</div>`);
    const streams = KINDS.map((k, i) => [KIND_NAME[k], L.streams[k] || 0, SERIES[i]]);
    set("card-devices", `<div class="hrow"><h3>Connected devices</h3><span class="sub">open relay streams</span></div>
      <div class="big">${num(sum(L.streams))}</div>
      ${stack(streams)}
      ${kv([["Messages held", `${num(L.held.bursts)} <span class="sub">(${bytes(L.held.bytes)})</span>`], ["Streams that can't play Opus", L.pcmOnly ? `<span class="pill warn">${num(L.pcmOnly)}</span>` : "0"]])}
      <div class="note">iPhones in the PushToTalk channel aren't connected between conversations, so this counts streams, not reachable people. Bots left out.</div>`);
    const rows = L.live.map((r) => {
      const st = r.state === "talking" ? pill("warn", "Talking", true) : r.state === "ringing" ? pill("idle", "Ringing") : pill("ok", "Waiting");
      const route = `${KIND_NAME[r.from] || r.from} → ${r.testBot ? "Test Bot" : KIND_NAME[r.to] || r.to}`;
      return `<tr><td>${st}</td><td>${esc(route)}</td><td class="n">${ago(r.ageMs)}</td><td class="n">${num(r.turns)}</td><td class="n">${num(r.held)}</td><td>${esc(r.ring ? RING_NAME[r.ring] || r.ring : "–")}${r.rolledOver ? ' <span class="pill warn">Rolled over</span>' : ""}</td></tr>`;
    });
    set("card-air", `<div class="hrow"><h3>On the air now</h3><span class="sub">anonymous: no names, IDs or audio</span></div>
      ${rows.length ? `<div class="tbl-wrap"><table><thead><tr><th>State</th><th>Route</th><th class="n">Open for</th><th class="n">Back-and-forths</th><th class="n">Bursts held</th><th>Ring</th></tr></thead><tbody>${rows.join("")}</tbody></table></div>` : `<p class="empty">Nobody's on the air.</p>`}
      <div class="note">Showing ${num(rows.length)} of ${num(c.open)}, newest first.${L.nodes.some((n) => !n.ok) ? ` <b>${L.nodes.filter((n) => !n.ok).length} node(s) didn't answer.</b>` : ""}</div>`);
    renderHealth();
    // Relay capacity uses the live peaks and nodes too.
    if (state.summary) renderData();
  }

  function renderHealth() {
    const L = state.live;
    const M = state.summary && state.summary.monitoring;
    const links = (state.summary && state.summary.links) || {};
    const nodeRows = (L ? L.nodes : []).map((n) => {
      const cpu = M && M.relayCpu && M.relayCpu.find((c) => c.node === n.node);
      return [`Relay <b>${esc(n.node || new URL(n.url).hostname)}</b>${n.revision ? ` · <code>${esc(String(n.revision).slice(0, 7))}</code>` : ""}`,
        n.ok ? `${pill("ok", "Healthy")} <span class="sub">up ${ago((L.now || Date.now()) - n.startedAt)}${cpu ? ` · CPU ${num(cpu.utilization * 100)}%` : ""}</span>` : `${pill("bad", "Down")} <span class="sub">${esc(n.error || "")}</span>`];
    });
    const api = (M && M.api) || {};
    const uptime = (M && M.uptime) || [];
    const incidents = (M && M.incidents) || [];
    const allOk = L && L.nodes.every((n) => n.ok) && uptime.every((u) => u.passing) && !incidents.length;
    set("card-health", `<div class="hrow"><h3>Service health</h3>${L ? (allOk ? pill("ok", "All good") : pill("warn", "Look")) : ""}</div>
      ${kv([
        ...nodeRows,
        ["API p95 · 5xx · instances", M ? `${num(api.p95Ms)} ms · ${api.errorShare === undefined ? "–" : `${num(api.errorShare * 100, 2)}%`} · ${num(api.instances)}` : "–"],
        [`Uptime checks (${uptime.length}) <a href="${esc(links.uptime || "#")}" target="_blank" rel="noopener">↗</a>`, uptime.length ? (uptime.every((u) => u.passing) ? pill("ok", "Passing") : pill("bad", `${uptime.filter((u) => !u.passing).length} failing`)) : "–"],
        [`Alerts firing <a href="${esc(links.alerts || "#")}" target="_blank" rel="noopener">↗</a>`, M && M.incidents ? (incidents.length ? `${pill("bad", String(incidents.length))} <span class="sub">${esc(incidents.map((i) => i.policy).join(", "))}</span>` : "0") : "–"],
      ])}
      <div class="note">Relays are <b>Live</b>; the API, uptime and alert rows are <b>Near-live</b> from Cloud Monitoring${M ? ` (${hhmm(M.at)} UTC)` : ""}.</div>`);
  }

  // ---- The summary's sections ----
  function rangeStats() {
    const r = state.summary.ranges[state.range];
    return { label: r.label, days: r.days, c: state.withBot ? r.withTestBot : r.conversationStats };
  }

  function renderCanary() {
    const t = state.summary.today;
    const canary = t && t.canary;
    if (!canary || !canary.runs) {
      set("card-canary", `<div class="hrow"><h3>End-to-end canary</h3>${pill("idle", "Not running")}</div><p class="empty">No Canary runs today. It needs CANARY_USER_ID and the stats-rolling job (setup-stats.sh).</p>`);
      return;
    }
    const last = canary.last;
    const status = canary.passes === canary.runs ? "ok" : last && last.ok ? "warn" : "bad";
    set("card-canary", `<div class="hrow"><h3>End-to-end canary</h3>${pill(status, `${canary.passes} / ${canary.runs} today`)}</div>
      <div class="big">${last && last.ok ? `${sec(last.firstFrameMs)}<small>s</small>` : "Failed"}</div>
      <div class="sub">${last ? `${last.ok ? `Talk-start → the Test Bot's first frame; connect ${num(last.connectMs)} ms, go-ahead ${num(last.goAheadMs)} ms` : esc(last.error || "")} · ${hhmm(last.at)} UTC` : ""}</div>
      ${spark(canary.history.map((h) => (h.ok ? h.firstFrameMs : null)), "The Canary's talk-start to first frame, today")}
      <div class="note">Every 15 minutes a Canary account talks to the Test Bot over the live relay. It checks admission, sessions, the friend lookup and the relay, not APNs.</div>`);
  }

  function delta(now, before, label) {
    if (!before || now === undefined) return `<span class="delta flat">${esc(label)}: –</span>`;
    const d = (now - before) / before;
    return `<span class="delta ${d > 0.005 ? "up" : d < -0.005 ? "down" : "flat"}">${d >= 0 ? "+" : "−"}${num(Math.abs(d) * 100)}% ${esc(label)}</span>`;
  }

  function renderEngagement() {
    const S = state.summary;
    const t = S.today;
    const bot = state.withBot;
    const days = S.days;
    const pick = (d, k) => (bot && d.withTestBot ? d.withTestBot[k] : d[k]);
    const latest = days[days.length - 1];
    const dauToday = t ? (bot ? t.withTestBot.dau : t.dau) : undefined;
    const slot = Math.floor((Date.now() - Date.parse(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`)) / 900_000);
    const ySlots = S.yesterday && (bot ? S.yesterday.withTestBot && S.yesterday.withTestBot.slots : S.yesterday.slots);
    const yAt = ySlots && ySlots.dau ? ySlots.dau[Math.min(slot, 95)] : undefined;
    const weekAgo = days[days.length - 8];
    const monthAgo = days[days.length - 31];
    const ratio = days.map((d) => (pick(d, "mau") ? pick(d, "dau") / pick(d, "mau") : null));
    const ratios = ratio.filter((v) => v !== null);
    const avg = ratios.length ? ratios.reduce((a, b) => a + b, 0) / ratios.length : undefined;
    const kpi = (title, value, deltaHtml, series, label) => `<div class="kpi"><h3>${title}</h3><div class="big num">${value}</div>${deltaHtml}${spark(series, label)}</div>`;
    set("kpis", [
      kpi("DAU", num(dauToday), delta(dauToday, yAt, "vs yesterday at this hour"), [...days.map((d) => pick(d, "dau")), dauToday], "Daily active accounts, 30 days"),
      kpi("WAU", latest ? num(pick(latest, "wau")) : "–", latest ? delta(pick(latest, "wau"), weekAgo && pick(weekAgo, "wau"), "week over week") : "", days.map((d) => pick(d, "wau")), "Weekly active accounts, 30 days"),
      kpi("MAU", latest ? num(pick(latest, "mau")) : "–", latest ? delta(pick(latest, "mau"), monthAgo && pick(monthAgo, "mau"), "month over month") : "", days.map((d) => pick(d, "mau")), "Monthly active accounts, 30 days"),
      kpi("DAU / MAU", latest && pick(latest, "mau") ? `${num((pick(latest, "dau") / pick(latest, "mau")) * 100)}<small>%</small>` : "–", `<span class="delta flat">30-day average ${avg === undefined ? "–" : `${num(avg * 100)}%`}</span>`, ratio, "DAU over MAU, 30 days"),
    ].join(""));
    const providers = t && t.dauByProvider ? Object.entries(t.dauByProvider).map(([p, n]) => `${esc(p === "apple" ? "Apple" : p === "google" ? "Google" : p)} ${num(n)}`).join(" · ") : "";
    $("dau-providers").textContent = providers ? `DAU by sign-in: ${providers}.` : "";

    const { label, c } = rangeStats();
    const d = c.depth;
    const hist = ["0", "1", "2-3", "4-6", "7-12", "13+"].map((k) => d.histogram[k] || 0);
    const histTotal = hist.reduce((a, b) => a + b, 0);
    const maxH = Math.max(...hist, 1);
    set("card-depth", `<div class="hrow"><h3>Back-and-forths per conversation</h3><span class="sub">${esc(label)}</span></div>
      <div style="display:flex;gap:28px;flex-wrap:wrap;align-items:flex-end">
        <div><div class="big">${d.conversations ? num(d.turnsSum / d.conversations, 1) : "–"}</div><div class="sub">mean</div></div>
        <div><div class="big" style="font-size:28px">${num(d.turnsMedian, 1)}</div><div class="sub">median${state.range === "today" ? "" : " (by day)"}</div></div>
        <div><div class="big" style="font-size:28px">${pct(d.gotReply, d.conversations)}</div><div class="sub">got a reply</div></div>
        <div><div class="big" style="font-size:28px">${d.replyGapMedianMs === undefined ? "–" : `${sec(d.replyGapMedianMs, 1)}<small>s</small>`}</div><div class="sub">median reply gap</div></div>
      </div>
      <div class="hist" aria-label="Share of conversations by number of back-and-forths">${hist.map((n, i) => `<div class="col"><div class="bar${i === 0 ? " zero" : ""}" style="height:${(n / maxH) * 100}%"><b>${pct(n, histTotal)}</b></div></div>`).join("")}</div>
      <div class="hist-x"><span>0 (no reply)</span><span>1</span><span>2–3</span><span>4–6</span><span>7–12</span><span>13+</span></div>
      <div class="note">One <b>back-and-forth</b> is one change of speaker: Alex talks, Jess answers = 1; Alex answers again = 2. Over ${num(d.conversations)} conversations with the count (relays from October 2026 on).</div>`);

    const activeIn = state.range === "today" ? dauToday : latest ? pick(latest, state.range === "7d" ? "wau" : "mau") : undefined;
    const from = c.startedFrom || {};
    const eco = c.ecosystems || {};
    const talkMin = c.talkMs / 60_000;
    set("card-conversations", `<div class="hrow"><h3>Conversations</h3><span class="sub">${esc(label)}</span></div>
      <div class="big">${num(c.conversations)}</div>
      ${kv([
        ["Per active account", activeIn ? num(c.conversations / activeIn, 1) : "–"],
        [`Active pairs${state.range === "today" ? "" : " (most in a day)"}`, num(c.activePairs)],
        ["Talk time", talkMin < 60 ? `${num(talkMin, 1)} min` : `${num(talkMin / 60, 1)} h`],
        ["Median burst", c.burstMedianMs === undefined ? "–" : `${sec(c.burstMedianMs, 1)} s`],
        ["Live (both already on)", pct((c.outcomes || {}).live || 0, c.conversations)],
      ])}
      <h3 style="margin-top:4px">Started from</h3>
      ${stack(KINDS.map((k, i) => [KIND_NAME[k], from[k] || 0, SERIES[i]]))}
      <h3 style="margin-top:4px">Cross-platform</h3>
      ${kv([["Apple–Apple", num(eco["apple-apple"] || 0)], ["Apple–Android", num(eco["android-apple"] || 0)], ["Android–Android", num(eco["android-android"] || 0)]])}
      ${spark([...days.map((x) => (bot && x.withTestBot ? x.withTestBot.conversations : x.conversations)), (state.summary.ranges.today[bot ? "withTestBot" : "conversationStats"] || {}).conversations], "Conversations per day, 30 days")}
      <div class="note">Conversations with a friend; the Test Bot's ${bot ? "<b>included</b>" : "left out"} (the switch above). <a href="/reports/cross-platform">Cross-platform report →</a></div>`);
  }

  function renderRings() {
    const { label, c } = rangeStats();
    const r = c.rings;
    const base = r.rings || 1;
    const rows = [
      ["Rings", r.rings, "", ""],
      ["Push accepted", r.accepted, "", pct(r.accepted, r.rings, 1)],
      ["Answered", r.answered, "indent", `${pct(r.answered, r.accepted, 1)} of accepted`],
      ["Rolled over to the phone", r.rolledOver, "indent out", pct(r.rolledOver, r.rings, 1)],
      ["Missed (timed out)", r.missed, "indent out", pct(r.missed, r.rings, 1)],
      ["Declined", r.declined, "indent out", pct(r.declined, r.rings, 1)],
      ["Unavailable", r.unavailable, "indent out", pct(r.unavailable, r.rings, 1)],
      ["Push failed", r.pushFailed, "fail", pct(r.pushFailed, r.rings, 1)],
      ["Refused (blocked)", r.refused, "out", pct(r.refused, r.rings, 1)],
    ];
    const M = state.summary.monitoring;
    const lastHour = M && M.lastHour;
    set("card-funnel", `<div class="hrow"><h3>Ring outcomes</h3><span class="sub">${esc(label)}</span></div>
      <div class="funnel">${rows.map((row) => `<div class="frow ${row[2]}"><span class="name">${esc(row[0])}</span><div class="trk"><span style="width:${Math.max((row[1] / base) * 100, row[1] ? 0.6 : 0)}%"></span></div><span class="v">${num(row[1])}${row[3] ? `<small>${esc(row[3])}</small>` : ""}</span></div>`).join("")}</div>
      ${r.simulated ? `<p class="small">${num(r.simulated)} ring(s) went only to a stand-in (the FCM stub or a dry run): never counted as accepted.</p>` : ""}
      <div class="note">Outcomes are the relay's own; declines are the watch's Decline reports. A ring keeps its ID when it rolls over or falls back, so each counts once.${lastHour ? ` <b>Last hour (Near-live):</b> ${num(sum(lastHour.conversations))} conversations rang someone, ${num(lastHour.conversations["push-failed"] || 0)} pushes failed outright, ${num(lastHour.apnsFailures)} APNs refusals.` : ""}</div>`);

    const today = state.summary.today;
    const push = (today && today.push) || { byProvider: {} };
    const apns = push.byProvider.apns || { accepted: 0, permanent: 0, failed: 0, retried: 0, reasons: {} };
    const fcm = push.byProvider.fcm || { accepted: 0, permanent: 0, failed: 0, reasons: {} };
    const attempts = apns.accepted + apns.permanent + apns.failed;
    const reasons = Object.entries(apns.reasons || {}).sort((a, b) => b[1] - a[1]).slice(0, 4);
    const rang = r.rangOn || {};
    const byKind = r.byKind || {};
    set("card-push", `<h3>Push delivery <span class="sub" style="text-transform:none;letter-spacing:0">today</span></h3>
      ${kv([
        ["APNs accepted", `${pct(apns.accepted, attempts, 1)} <span class="sub">of ${num(attempts)}</span>`],
        ["APNs send p50 · p95", `${num(apns.p50Ms)} · ${num(apns.p95Ms)} ms`],
        ["Retried on a fresh connection", num(apns.retried)],
        ["Token gone (removed)", num(apns.permanent)],
        ...reasons.map(([k, n]) => [esc(k), num(n)]),
        ["FCM accepted", `<span class="${fcm.accepted ? "" : "zero"}">${num(fcm.accepted)}</span> <span class="sub">from Phase 2</span>`],
      ])}
      <h3 style="margin-top:6px">Answer rate by device rung</h3>
      ${kv(KINDS.map((k) => [KIND_NAME[k], byKind[k] ? `${pct(byKind[k].answered, byKind[k].accepted)} <span class="sub">of ${num(byKind[k].accepted)}</span>` : '<span class="zero">0</span>']))}
      <h3 style="margin-top:6px">Rang on</h3>
      ${stack([["Watch", rang.watch || 0, "var(--series2)"], ["Phone", rang.phone || 0, "var(--accent-fill)"]])}
      <div class="small">${pct(r.movedFormFactor, r.rings)} moved to the other device (rolled over or fell back) · ${esc(label)}</div>`);
  }

  function renderSpeed() {
    const t = state.summary.today;
    const rows = (t && t.speed) || [];
    const MAXS = Math.max(2.5, Math.ceil(Math.max(0, ...rows.map((r) => (r.p95 || 0) / 1000)) * 2) / 2);
    const html = rows.filter((r) => r.n || r.targetMs).map((r) => {
      const [name, detail] = STEP[r.step] || [r.step, ""];
      const kind = KIND_NAME[r.clientKind] || r.clientKind;
      const over = r.targetMs && r.p50 > r.targetMs;
      const status = !r.n ? pill("idle", "No samples") : !r.targetMs ? pill("idle", "No target yet") : over ? pill("warn", "Over") : pill("ok", "OK");
      const bar = r.n
        ? `<div class="p50" style="width:${Math.min(100, (r.p50 / 1000 / MAXS) * 100)}%"></div><div class="p95" style="left:calc(${Math.min(100, (r.p95 / 1000 / MAXS) * 100)}% - 1px)"></div>`
        : "";
      const target = r.targetMs ? `<div class="tgt" style="left:${(r.targetMs / 1000 / MAXS) * 100}%"></div>` : "";
      return `<div class="lrow${r.n ? "" : " none"}${over ? " over" : ""}"><span class="name">${esc(name)} · ${esc(kind)}<small>${esc(detail)} · ${num(r.n)} sample${r.n === 1 ? "" : "s"}</small></span>
        <div class="bullet" role="img" aria-label="p50 ${sec(r.p50)} s, p95 ${sec(r.p95)} s${r.targetMs ? `, target ${sec(r.targetMs, 1)} s` : ""}"><div class="trk"></div>${bar}${target}</div>
        <span class="v">${r.n ? `${sec(r.p50)} / ${sec(r.p95)} s` : "–"}${status}</span></div>`;
    });
    const ticks = [];
    for (let s = 0; s <= MAXS + 1e-9; s += 0.5) ticks.push(`<span style="left:${(s / MAXS) * 100}%">${s} s</span>`);
    set("card-speed", `<div class="lat">${html.join("") || '<p class="empty">No device timelines today yet.</p>'}</div>
      <div class="axis"><div></div><div class="ticks">${ticks.join("")}</div><div></div></div>
      <div class="keys" style="margin-top:4px"><span><i style="background:var(--series2)"></i>p50</span><span><i style="background:var(--ink);width:2px"></i>p95</span><span><i style="background:transparent;border-left:2px dashed var(--accent-fill);border-radius:0"></i>target (p50)</span><span>Over a target turns the row amber; nothing alerts (decided 2026-10-01).</span></div>
      <div class="note">From each device's uploaded timeline (<code>oao.device</code>), today. Android and Wear OS rows get their targets from Phase 1's measurements.</div>`);
  }

  function renderQuality() {
    const t = state.summary.today;
    const q = t && t.quality;
    if (!q) {
      set("card-quality", `<p class="empty" style="padding:14px 16px">No rolling numbers today yet.</p>`);
    } else {
      const p = q.problems || {};
      const crashFree = KINDS.filter((k) => q.byKind[k]).map((k) => {
        const v = q.byKind[k];
        return `${KIND_NAME[k]} ${v.conversations ? `${num(Math.max(0, 1 - v.crashes / v.conversations) * 100, 1)}%` : "–"}`;
      }).join(" · ") || "–";
      const refusedConnections = sum(q.admission.byError);
      const refusals = q.refusals || {};
      set("card-quality", `<div class="counters">
        ${counter("Crash-free conversations", `<small>${esc(crashFree)}</small>`)}
        ${counter("Unclean exits", num(p.uncleanExit || 0))}
        ${counter("Relay streams dropped", num((p.relayDropped || 0) + (p.relayClosed || 0)))}
        ${counter("PushToTalk join failed", num(p.pttJoinFailed || 0))}
        ${counter("Audio engine restarts", num(p.audioRestarted || 0))}
        ${counter("Silent bursts sent", q.burstsSent ? `${num(((p.silentBurstSent || 0) / q.burstsSent) * 100, 1)}<small>% of ${num(q.burstsSent)}</small>` : num(p.silentBurstSent || 0))}
        ${counter("Clipped bursts sent", num(p.clippedBurstSent || 0))}
        ${counter("Played quieter than sent", q.levelDropMedianDb === undefined ? "–" : `${num(-q.levelDropMedianDb, 1)}<small> dB median</small>`, q.levelDrops ? ` ${pill("warn", `${q.levelDrops} over 10 dB`)}` : "")}
        ${counter("Codec refusals · undecodable · joins refused", `${num(refusals.codecRefused || 0)} · ${num(refusals.burstUndecodable || 0)} · ${num(refusals.joinRefused || 0)}`)}
        ${counter("Connections refused", num(refusedConnections), refusedConnections ? ` <span class="sub">${esc(Object.entries(q.admission.byError).map(([k, n]) => `${k} ${n}`).join(", "))}</span>` : "")}
        ${counter("Refused by build", `<small>${esc(Object.entries(q.admission.byBuild).map(([k, n]) => `${k.replace(/^ios/, "iPhone").replace(/^watchos/, "Watch")}: ${n}`).join(", ") || "none")}</small>`)}
        ${counter("Refresh failures", num(p.refreshFailed || 0))}
      </div>`);
    }
    const u = state.summary.latestDaily && state.summary.latestDaily.usage;
    set("card-feedback", `<h3>Problem reports and feedback <span class="sub" style="text-transform:none;letter-spacing:0">today</span></h3>
      ${kv([
        ["Report a Problem", num(t && t.feedback ? t.feedback.problemReports : undefined)],
        ["Diagnostics uploaded", num(t && t.feedback ? t.feedback.diagnosticsUploads : undefined)],
        ["Diagnostics asked for (7 days)", num(u && u.diagnosticsRequested)],
        ["TestFlight feedback and crashes", '<span class="sub">asc.ts, on Steve\'s Mac</span>'],
      ])}
      <div class="note">TestFlight's feedback needs an App Store Connect key in the cloud (optional; see the spec). Until then: <code>node deploy/appstore/asc.ts feedback</code>.</div>`);
  }

  function renderGrowth() {
    const S = state.summary;
    const t = S.today;
    const latest = S.latestDaily;
    const u = latest && latest.usage;
    const days = S.days;
    const week = days.slice(-7);
    const wsum = (k) => week.reduce((n, d) => n + ((d.activity && d.activity[k]) || 0), 0);
    const signUpsToday = t && t.growth ? sum(t.growth.signUps) : 0;
    // Today's count from the rolling job; the daily snapshot's before it runs.
    const accounts = t && t.accounts ? t.accounts.total : u ? u.accounts : undefined;
    const providers = (t && t.accounts && t.accounts.byProvider) || (u && u.providers) || {};
    set("card-accounts", `<h3>Accounts</h3>
      <div class="big">${num(accounts)}</div>
      <span class="delta up">+${num(signUpsToday)} today · +${num(u ? u.newAccounts7d : undefined)} in 7 days</span>
      ${spark([...days.map((d) => d.accounts), accounts], "Accounts, 30 days")}
      ${kv([["Apple · Google", `${num(providers.apple || 0)} · <span class="${providers.google ? "" : "zero"}">${num(providers.google || 0)}</span>`]])}
      <div class="note">Accounts and sign-ups today are <b>Rolling</b>; the 7 days and the rest are the daily snapshot.</div>`);
    set("card-invites", `<h3>Invites (7 days)</h3>
      ${kv([
        ["Created", num(wsum("invitesCreated"))],
        ["Accepted", `${num(wsum("invitesAccepted"))} · ${pct(wsum("invitesAccepted"), wsum("invitesCreated"))}`],
        ["Friendships", num(u && u.friendships)],
        ["Accounts with favorites", num(u && u.accountsWithFavorites)],
      ])}`);
    const friends = (u && u.friends) || {};
    set("card-activation", `<h3>Activation</h3>
      ${kv([
        ["Finished onboarding (7 days)", `${num(wsum("onboardingFinished"))} <span class="sub">of ${num(wsum("newAccounts"))} new</span>`],
        ["Walkie-talkie on at the end", pct(wsum("onboardingWalkieTalkieOn"), wsum("onboardingFinished"))],
        ["Accounts with no friends", u ? pct(friends["0"] || 0, u.accounts) : "–"],
        ["Median time to first friend", u && u.hoursToFirstFriendP50 !== undefined ? `${num(u.hoursToFirstFriendP50, 1)} h` : "–"],
      ])}`);
    const dev = (u && u.devices) || {};
    const ringOn = (u && u.ringOn) || {};
    const reach = (u && u.reachability) || {};
    const builds = (t && t.builds) || {};
    const iphones = u ? u.iphones.walkieTalkie + u.iphones.appOnly : 0;
    set("card-settings", `<h3>Devices and settings</h3>
      ${stack([["Both", dev.both || 0, "var(--series2)"], ["iPhone", dev.iphone || 0, "var(--accent-fill)"], ["Watch", dev.watch || 0, "var(--series3)"], ["None", dev.none || 0, "var(--track)"], ...Object.entries(dev).filter(([k]) => !["both", "iphone", "watch", "none"].includes(k)).map(([k, n]) => [k.split("+").map((x) => DEVICE_LABEL[x] || x).join(" + "), n, "var(--good)"])])}
      ${kv([
        ["Ring Me On: watch · iPhone · automatic", `${num(ringOn.watch || 0)} · ${num(ringOn.iphone || 0)} · ${num(ringOn.default || 0)}`],
        ["Roll Over on", num(u && u.rollOver)],
        ["iPhones in PushToTalk", u ? pct(u.iphones.walkieTalkie, iphones) : "–"],
        ["Can't be rung with the app closed", reach.unreachable ? `<span class="pill warn">${num(reach.unreachable)}</span>` : num(reach.unreachable)],
        ["Notifications denied · availability off", `${num(reach.notificationsDenied)} · ${num(reach.availabilityOff)}`],
        ...KINDS.filter((k) => builds[k]).map((k) => [`${KIND_NAME[k]} on build ${esc(builds[k].newest)}`, `${pct(builds[k].onNewest, builds[k].devices)}${builds[k].belowMinimum ? ` · ${pill("warn", `${builds[k].belowMinimum} below minimum`)}` : ""}`]),
      ])}
      <div class="note">Accounts that can't be rung look fine everywhere else on this page: check them after sign-ins.</div>`);
    freshness("daily", latest && latest.createdAt ? Date.parse(latest.createdAt) || Date.parse(`${latest.date}T00:30:00Z`) + 86_400_000 : latest ? Date.parse(`${latest.date}T00:30:00Z`) + 86_400_000 : null);
  }

  function renderData() {
    const S = state.summary;
    const M = S.monitoring;
    const storage = S.storage;
    const counts = (storage && storage.counts) || null;
    const rows = counts ? Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([k, n]) => `<tr><td>${esc(k)}</td><td class="n">${num(n)}</td></tr>`).join("") : "";
    set("card-collections", `<div class="hrow"><h3>Firestore by collection</h3><span class="sub">${M && M.firestore && M.firestore.bytes !== undefined ? `${bytes(M.firestore.bytes)} of 1 GiB free` : ""}</span></div>
      ${counts ? `<div class="tbl-wrap"><table><thead><tr><th>Collection</th><th class="n">Docs</th></tr></thead><tbody>${rows}</tbody></table></div>` : '<p class="empty">The nightly storage audit hasn\'t run yet.</p>'}
      <div class="note">Document counts from the nightly <a href="/reports/storage-audit">storage audit</a> (count() queries, about 1 read per 1,000 documents); the total size is Near-live.</div>`);
    const meter = (label, v, limit, fmtv) => {
      const share = v === undefined ? 0 : Math.min(1, v / limit);
      return `<div class="meter"><div class="lbl"><span>${label}</span><span>${v === undefined ? "–" : `${fmtv(v)} / ${fmtv(limit)}`}</span></div><div class="trk"><span class="${share > 0.8 ? "hot" : ""}" style="width:${share * 100}%"></span></div></div>`;
    };
    const fs = (M && M.firestore) || {};
    const k = (n) => (n >= 1000 ? `${num(n / 1000, 1)}k` : num(n));
    set("card-headroom", `<h3>Free-tier headroom</h3>
      ${meter("Firestore reads today", fs.readsToday, 50_000, k)}
      ${meter("Firestore writes today", fs.writesToday, 20_000, k)}
      ${meter("Logging this month", M ? M.loggingBytesMonth : undefined, 50 * 2 ** 30, (b) => `${num(b / 2 ** 30, 1)} GiB`)}
      ${meter("Cloud Scheduler jobs", 3, 3, (n) => num(n))}
      <div class="note">Near-live from Cloud Monitoring${M ? ` (${hhmm(M.at)} UTC)` : ""}. "Today" is from midnight UTC; Firestore's quota resets at midnight Pacific. The three free Scheduler jobs: stats-daily, node-replacement-monthly, stats-rolling.</div>`);
    const L = state.live;
    const t = S.today;
    const peak = [L && L.peaks.streams, t && t.peaks && t.peaks.streams].filter(Boolean).sort((a, b) => b.value - a.value)[0];
    set("card-capacity", `<h3>Spend this month</h3>
      <p class="empty">No billing budget connected yet (a $25 budget with email alerts would back this; Steve's call).</p>
      <h3 style="margin-top:6px">Relay capacity</h3>
      ${kv([
        ["Peak streams today", peak ? `${num(peak.value)} <span class="sub">${peak.at ? hhmm(peak.at) : ""}</span>` : "–"],
        ["One e2-micro's ceiling", '<span class="sub">not measured yet</span>'],
        ["Nodes", L ? `${L.nodes.length} ${L.nodes.length < 2 ? pill("warn", "no failover") : ""}` : "–"],
      ])}`);
    freshness("near", M ? M.at : null);
    $("sample").hidden = !(M && M.sample);
  }

  function renderSafety() {
    const t = state.summary.today;
    const open = t && t.openReports;
    const age = open && open.oldestAt ? Date.now() - open.oldestAt : 0;
    const within = !open || !open.count || age < 24 * 3_600_000;
    set("card-reports-open", `<div class="hrow"><h3>Open reports</h3>${open ? (within ? pill("ok", "Within a day") : pill("bad", "Over a day")) : ""}</div>
      <div class="big">${num(open && open.count)}</div>
      ${open && open.count ? `<div class="meter"><div class="lbl"><span>Oldest open</span><span>${num(age / 3_600_000)} h of 24 h</span></div><div class="trk"><span class="${within ? "" : "hot"}" style="width:${Math.min(100, (age / 86_400_000) * 100)}%"></span></div></div>` : ""}
      <div class="note">Resolved with <code>server/tools/reports.ts</code>. The Terms promise action "usually within a day".</div>`);
    const s = (t && t.safety) || {};
    set("card-safety", `<div class="counters">
      ${counter("Reports today", num(s.reports))}
      ${counter("Blocks today", num(s.blocks))}
      ${counter("Screen names refused", num(s.namesRefused))}
      ${counter("Photo reports", num(s.photoReports))}
      ${counter("Accounts deleted", num(s.deletions))}
      ${counter("Rings refused (blocked)", num(s.ringsRefused))}
    </div>`);
  }

  function renderSummary() {
    const S = state.summary;
    if (!S) return;
    const link = $("service-graphs");
    if (S.links.monitoring) {
      link.href = S.links.monitoring;
      link.hidden = false;
    }
    const t = S.today;
    freshness("rolling", t ? t.generatedAt : null);
    renderCanary();
    renderEngagement();
    renderRings();
    renderSpeed();
    renderQuality();
    renderGrowth();
    renderData();
    renderSafety();
    renderHealth();
  }

  // ---- Reports ----
  function renderReports() {
    const list = state.reports;
    if (!list) return;
    set("report-list", list.map((r) => {
      const pending = state.pending[r.id];
      const made = r.generatedAt ? `Generated ${new Date(r.generatedAt).toISOString().slice(0, 16).replace("T", " ")} UTC` : "Not made yet";
      return `<div class="report"><h3>${esc(r.title)}</h3><p>${esc(r.question)}</p>
        ${r.status === "failed" ? '<span class="err">The last run failed; the page shown is the one before.</span>' : ""}
        <div class="meta"><span>${pending ? "Generating…" : esc(made)}</span><span><button type="button" class="regen" data-report="${esc(r.id)}"${pending ? " disabled" : ""}>Regenerate</button> ${r.generatedAt ? `<a class="open" href="/reports/${esc(r.id)}">Open →</a>` : ""}</span></div></div>`;
    }).join(""));
  }

  async function regenerate(id) {
    const before = (state.reports.find((r) => r.id === id) || {}).generatedAt || 0;
    state.pending[id] = before;
    renderReports();
    try {
      const res = await fetch(`/api/reports/${encodeURIComponent(id)}/run`, { method: "POST", headers: { "x-ops-request": "1" } });
      if (!res.ok) throw new Error(String(res.status));
    } catch (err) {
      delete state.pending[id];
      renderReports();
      alert(`Couldn't start the report (${err.message}).`);
    }
  }

  // ---- Polling ----
  async function getJSON(path) {
    const res = await fetch(path, { cache: "no-store" });
    if (res.status === 401 || res.status === 403) {
      $("updated").textContent = "Signed out: reload to sign in";
      throw new Error("signed out");
    }
    if (!res.ok) throw new Error(`${path}: ${res.status}`);
    return res.json();
  }

  async function pollLive() {
    try {
      state.live = await getJSON("/api/live");
      renderLive();
    } catch (err) {
      freshness("live", null);
    }
  }

  async function pollSummary() {
    try {
      state.summary = await getJSON("/api/summary");
      renderSummary();
    } catch (err) {
      console.error(err);
    }
  }

  async function pollReports() {
    try {
      const { reports } = await getJSON("/api/reports");
      state.reports = reports;
      for (const r of reports) if (state.pending[r.id] !== undefined && (r.generatedAt || 0) > state.pending[r.id]) delete state.pending[r.id];
      renderReports();
    } catch (err) {
      console.error(err);
    }
  }

  function start() {
    stop();
    void pollLive();
    void pollSummary();
    void pollReports();
    state.timers.push(setInterval(pollLive, 5_000), setInterval(pollSummary, 60_000), setInterval(() => (Object.keys(state.pending).length ? pollReports() : null), 15_000), setInterval(pollReports, 300_000));
  }

  function stop() {
    for (const t of state.timers) clearInterval(t);
    state.timers = [];
  }

  document.addEventListener("visibilitychange", () => (document.hidden ? stop() : start()));
  document.addEventListener("click", (e) => {
    const range = e.target.closest(".seg button");
    if (range) {
      state.range = range.dataset.range;
      for (const b of document.querySelectorAll(".seg button")) b.setAttribute("aria-pressed", String(b === range));
      renderSummary();
    }
    const regen = e.target.closest("button.regen");
    if (regen && !regen.disabled) void regenerate(regen.dataset.report);
  });
  $("bot").addEventListener("change", (e) => {
    state.withBot = e.target.checked;
    renderSummary();
  });
  for (const tier of Object.keys(TIERS)) freshness(tier, null);
  start();
})();
