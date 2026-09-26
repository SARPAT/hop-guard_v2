// HopGuard demo UI. Plain JavaScript, no build step. All text is inserted with textContent (no HTML injection).
"use strict";

const $ = (id) => document.getElementById(id);
const state = { setup: null, scenario: null, busy: false, lastTrace: null };

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  for (const c of children.flat()) if (c != null) node.append(c instanceof Node ? c : document.createTextNode(c));
  return node;
}

function store(key, value) {
  try { if (value === undefined) return localStorage.getItem(key); localStorage.setItem(key, value); } catch { return null; }
}

// ------------------------------------------------------------------ setup
async function init() {
  const res = await fetch("/api/setup");
  const s = (state.setup = await res.json());

  const missing = Object.entries(s.keys).filter(([, ok]) => !ok).map(([k]) => k);
  if (missing.length) {
    $("keysBanner").textContent = `⚠️ The app is not connected yet: ${missing.join(" and ")} missing. ` +
      "Add them to the .env file in the project folder (see .env.example), then restart the app.";
    $("keysBanner").hidden = false;
  }
  if (store("hopguard.welcomeSeen") !== "1") $("welcome").hidden = false;

  for (const p of s.people) $("personSel").append(el("option", { value: p.id, text: `${p.name} · ${p.department} (${p.id})` }));
  for (const r of s.roles) $("roleSel").append(el("option", { value: r.id, text: r.label }));
  $("personSel").value = "E003";
  updateRoleHint();

  for (const l of s.layers) {
    $("layerList").append(el("label", { class: "layer" },
      el("input", { type: "checkbox", "data-layer": l.id, checked: "", onchange: onLayerChange }),
      el("span", {}, el("b", { text: l.name }), el("span", { class: "kind", text: l.kind }), el("small", { text: l.text }))));
    $("helpLayers").append(el("div", { class: "help-layer" },
      el("b", { text: `${l.name} ` }), el("span", { class: "kind", text: l.kind }), el("p", { text: l.text })));
  }
  $("modelName").textContent = s.model;

  for (const sc of s.scenarios) {
    const btn = el("button", { class: "scen", type: "button", "data-id": sc.id, title: sc.story, onclick: () => pickScenario(sc) },
      el("span", { class: "sid", text: sc.id }), el("span", { class: "stitle", text: sc.title }));
    (sc.attack ? $("attackList") : $("benignList")).append(btn);
  }
  refreshAudit();
}

function updateRoleHint() {
  const r = state.setup.roles.find((x) => x.id === $("roleSel").value);
  $("roleHint").textContent = r ? r.text : "";
}

// ------------------------------------------------------------------ protection
function layerBoxes() { return [...document.querySelectorAll("[data-layer]")]; }
function layers() { return Object.fromEntries(layerBoxes().map((b) => [b.dataset.layer, b.checked])); }

function onGuardSwitch() {
  for (const b of layerBoxes()) b.checked = $("guardSwitch").checked;
  renderMode();
}
function onLayerChange() {
  $("guardSwitch").checked = layerBoxes().some((b) => b.checked);
  renderMode();
}
function renderMode() {
  const on = layerBoxes().filter((b) => b.checked).length, all = layerBoxes().length;
  const badge = $("modeBadge");
  if (on === 0) {
    $("guardLabel").textContent = "Protection is OFF";
    $("guardSub").textContent = "The assistant does whatever it is told. Nothing is checked.";
    badge.className = "badge off"; badge.textContent = "Protection OFF";
  } else if (on < all) {
    const names = state.setup.layers.filter((l) => layers()[l.id]).map((l) => l.name);
    $("guardLabel").textContent = "Protection is PARTLY on";
    $("guardSub").textContent = `Only: ${names.join(", ")}.`;
    badge.className = "badge partial"; badge.textContent = "Protection PARTLY ON";
  } else {
    $("guardLabel").textContent = "Protection is ON";
    $("guardSub").textContent = "HopGuard checks every step.";
    badge.className = "badge on"; badge.textContent = "Protection ON";
  }
}

// ------------------------------------------------------------------ scenarios
function pickScenario(sc) {
  state.scenario = sc;
  for (const b of document.querySelectorAll(".scen")) b.classList.toggle("selected", b.dataset.id === sc.id);
  $("msg").value = sc.query;
  $("personSel").value = sc.user_id;
  $("roleSel").value = sc.role;
  updateRoleHint();
  $("scenTag").textContent = sc.attack ? "ATTACK" : "NORMAL";
  $("scenTag").className = "tag " + (sc.attack ? "attack" : "benign");
  $("scenTitle").textContent = sc.title;
  $("scenStory").textContent = sc.story;
  $("scenExpect").textContent = sc.expect || "—";
  $("scenDocWrap").hidden = !sc.doc;
  if (sc.doc) { $("scenDocId").textContent = sc.doc.id; $("scenDoc").textContent = sc.doc.text; }
  $("scenarioCard").hidden = false;
  $("msg").focus();
}
function clearScenario() {
  state.scenario = null;
  for (const b of document.querySelectorAll(".scen")) b.classList.remove("selected");
  $("scenarioCard").hidden = true;
  $("msg").value = "";
}

// ------------------------------------------------------------------ chat
function addMessage(kind, text, meta) {
  $("chatEmpty").hidden = true;
  const who = { user: "You", bot: "HR assistant", err: "Problem" }[kind];
  const node = el("div", { class: `msg ${kind}` }, el("span", { class: "who", text: who }), text);
  if (meta) node.append(el("span", { class: "meta", text: meta }));
  $("messages").append(node);
  node.scrollIntoView({ behavior: "smooth", block: "end" });
  return node;
}

const WAIT_HINTS = [
  "Checking the documents for hidden instructions…",
  "The assistant is working on your request…",
  "Checking each action before it runs…",
  "Almost there. AI services can take a little while…",
];

async function ask(ev) {
  ev?.preventDefault();
  if (state.busy) return;
  const message = $("msg").value.trim();
  if (!message) { $("msg").focus(); return; }
  const person = state.setup.people.find((p) => p.id === $("personSel").value);
  const onLayers = layers();
  const modeText = $("modeBadge").textContent;
  addMessage("user", message, `${person.name} · ${$("roleSel").selectedOptions[0].text} · ${modeText}`);
  if (!state.scenario) $("msg").value = "";  // keep a scenario's question so it can be re-asked with protection switched

  state.busy = true; $("askBtn").disabled = true; $("askBtn").textContent = "Working…";
  const typing = addMessage("bot", "");
  const hints = Object.values(onLayers).some(Boolean) ? WAIT_HINTS : WAIT_HINTS.filter((h) => !h.startsWith("Check"));
  const hint = el("span", { class: "meta", text: hints[0] });
  typing.append(el("span", { class: "typing" }, el("i"), el("i"), el("i")), hint);
  let i = 0; const timer = setInterval(() => { hint.textContent = hints[++i % hints.length]; }, 3500);

  try {
    const res = await fetch("/api/ask", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message, user_id: person.id, role: $("roleSel").value, layers: onLayers,
                             scenario_id: state.scenario ? state.scenario.id : null }),
    });
    const data = await res.json();
    typing.remove();
    if (!res.ok) { addMessage("err", data.error || "Something went wrong."); return; }
    const answer = data.answer || (data.error ? "I couldn't finish this request." : "(no answer)");
    addMessage(data.error ? "err" : "bot", answer, `Took ${(data.ms / 1000).toFixed(1)} s · reference ${data.trace_id}`);
    renderResult(data);
  } catch (e) {
    typing.remove();
    addMessage("err", "Can't reach the HopGuard app. Is it still running in the terminal?");
  } finally {
    clearInterval(timer);
    state.busy = false; $("askBtn").disabled = false; $("askBtn").textContent = "Ask";
  }
}

// ------------------------------------------------------------------ results
const ICONS = { danger: "🚨", shield: "🛡️", ok: "✅", error: "⚠️" };
const MARKS = { allowed: "✓", blocked: "✕", error: "!", off: "–" };
const WORDS = { allowed: "Allowed", blocked: "Blocked", error: "Stopped", off: "Not checked" };

function renderResult(d) {
  state.lastTrace = d.trace_id;
  $("summaryEmpty").hidden = true;
  const o = d.outcome, box = $("outcome");
  box.className = `outcome ${o.level}`; box.hidden = false;
  box.replaceChildren(el("span", { class: "icon", text: ICONS[o.level] }), el("div", {}, el("h3", { text: o.title }), el("p", { text: o.text })));

  const list = $("steps");
  list.replaceChildren();
  if (!d.steps.length) list.append(el("li", {}, el("span", { class: "mark off", text: "–" }),
    el("div", { class: "st", text: "The assistant answered directly, without using any tools." })));
  for (const s of d.steps) {
    const st = d.guard_on || s.kind === "doc" ? s.status : "off";
    const tech = s.tech.length ? el("details", { class: "tech" }, el("summary", { text: "Technical details" }),
      ...s.tech.map((t) => el("code", { text: `${t.layer}: ${t.decision}` + (t.p != null ? ` · score ${t.p}` : "") + (t.ms != null ? ` · ${t.ms} ms` : "") }))) : null;
    list.append(el("li", {},
      el("span", { class: `mark ${st}`, text: MARKS[st] }),
      el("div", { class: "st" }, s.title, el("span", { class: `status-word ${st}`, text: WORDS[st] })),
      el("div", { class: "sd", text: s.detail }), tech));
  }

  renderEmails(d.emails);
  renderAudit(d.audit);
  showTab("summary");
}

function renderEmails(emails) {
  const c = $("outboxCount");
  c.hidden = !emails.length; c.textContent = emails.length;
  c.className = "count" + (emails.some((m) => m.external.length) ? "" : " okc");
  const wrap = $("emails");
  if (!emails.length) { wrap.replaceChildren(el("div", { class: "empty" }, el("p", { text: "No emails were sent for this question." }))); return; }
  wrap.replaceChildren(...emails.map((m) => {
    const ext = new Set(m.external);
    const addr = (a) => el("span", { class: ext.has(a) ? "addr-bad" : "", text: a });
    const head = el("div", { class: "email-head" },
      el("span", {}, "To: ", addr(m.to), ...(m.cc.length ? ["  ·  Copy to: ", ...m.cc.flatMap((a, i) => i ? [", ", addr(a)] : [addr(a)])] : [])),
      el("span", { class: "email-flag" + (ext.size ? "" : " int"), text: ext.size ? "🔴 Left the company" : "✅ Stayed inside the company" }));
    const note = m.disguised ? el("div", { class: "sd", text: "⚠️ The address was disguised: it looked like one address but the link pointed to another." }) : null;
    return el("div", { class: "email" + (ext.size ? " external" : "") }, head, note, el("pre", { text: m.body }));
  }));
}

const VERDICTS = { allow: "Allowed", block: "Blocked", quarantine: "Set aside", info: "Noted", error: "Error" };
const LAYER_NAMES = { G1: "Document check", G3: "Action check", G4: "Company rules", REQUEST: "Question received", ANSWER: "Answer given" };

function renderAudit(a) {
  const badge = $("chainBadge");
  badge.className = "chain " + (a.ok ? "ok" : "bad");
  badge.textContent = a.ok ? `✓ Log is intact (${a.count} entries, none changed)` : `✗ Log was tampered with (problem at entry ${a.bad_row})`;
  let prev = null;
  $("auditRows").replaceChildren(...a.rows.map((r) => {
    const tr = el("tr", { class: prev && prev !== r.trace_id ? "newtrace" : "" },
      el("td", { text: LAYER_NAMES[r.layer] || r.layer }),
      el("td", { class: `v-${r.verdict}`, text: VERDICTS[r.verdict] || r.verdict }),
      el("td", { text: r.p == null ? "" : r.p }),
      el("td", { text: r.ms == null ? "" : `${r.ms} ms` }),
      el("td", { text: r.reason || "" }),
      el("td", { class: "snip", text: r.snippet || "" }));
    prev = r.trace_id;
    return tr;
  }));
  if (!a.rows.length) $("auditRows").append(el("tr", {}, el("td", { colspan: "6", text: "The log is empty. Ask something first." })));
}

async function refreshAudit() {
  try { renderAudit(await (await fetch("/api/audit")).json()); } catch { /* shown on next ask */ }
}

function showTab(name) {
  for (const t of document.querySelectorAll(".tab")) t.classList.toggle("active", t.dataset.tab === name);
  for (const p of document.querySelectorAll(".tabpane")) p.hidden = p.id !== `tab-${name}`;
  if (name === "audit") refreshAudit();
}

// ------------------------------------------------------------------ wiring
$("askForm").addEventListener("submit", ask);
$("msg").addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); ask(); } });
$("guardSwitch").addEventListener("change", onGuardSwitch);
$("roleSel").addEventListener("change", updateRoleHint);
$("scenClear").addEventListener("click", clearScenario);
$("verifyBtn").addEventListener("click", refreshAudit);
$("helpBtn").addEventListener("click", () => $("help").showModal());
$("welcomeClose").addEventListener("click", () => { $("welcome").hidden = true; store("hopguard.welcomeSeen", "1"); });
$("help").addEventListener("close", () => { if ($("help").returnValue === "welcome") $("welcome").hidden = false; });
for (const t of document.querySelectorAll(".tab")) t.addEventListener("click", () => showTab(t.dataset.tab));
for (const c of document.querySelectorAll(".chip")) c.addEventListener("click", () => { clearScenario(); $("msg").value = c.textContent; $("msg").focus(); });

init().catch(() => addMessage("err", "Can't reach the HopGuard app. Start it with: python ui/app.py"));
