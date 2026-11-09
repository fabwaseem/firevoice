/* FireVoice Studio: the browser front end of the FireVoice API (served at /playground). Plain JS, no build step. */
"use strict";

// ------------------------------------------------------------------------------------------------ helpers
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const icon = (n, cls = "") => `<svg class="i ${cls}"><use href="#i-${n}"/></svg>`;
const fmtTime = s => { s = Math.max(0, s || 0); return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`; };
const fmtAgo = t => { const d = Date.now() / 1000 - t; return d < 60 ? "just now" : d < 3600 ? `${Math.floor(d / 60)} min ago` : d < 86400 ? `${Math.floor(d / 3600)} h ago` : new Date(t * 1000).toLocaleDateString(); };
const debounce = (fn, ms = 250) => { let h; return (...a) => { clearTimeout(h); h = setTimeout(() => fn(...a), ms); }; };
const store = {
  get(k, d) { try { const v = localStorage.getItem("fv." + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem("fv." + k, JSON.stringify(v)); } catch { /* private mode: settings just do not persist */ } },
};
const initials = s => { s = String(s || "?").replace(/^(lib|glb|hifi|exp|urd|dsg)-/, "").replace(/^[mfx]-/, ""); const w = s.split(/[\s-]+/).filter(Boolean);
  return ((w.length > 1 ? w[0][0] + w[1][0] : s.slice(0, 2)) || "V").toUpperCase(); };
const TIER = { S: "Top pick", A: "Excellent", B: "Great", C: "Good" };
const tierBadge = v => v.quality?.tier ? `<span class="tier ${v.quality.tier}" title="Listening test: #${v.quality.rank} of ${v.quality.of}">${v.quality.tier === "S" ? "★ " : ""}${TIER[v.quality.tier]}</span>` : "";
const vName = id => { if (!id || id === "default") { const d = (window.S?.voices || []).find(v => v.default); return d ? (d.name || d.voice_id) : "Default voice"; }
  if (id.startsWith("design:")) return "Designed: " + id.slice(7); const v = (window.S?.voices || []).find(x => x.voice_id === id); return v ? (v.name || id) : id; };
const MIME = { mp3: "audio/mpeg", wav: "audio/wav", flac: "audio/flac", ogg: "audio/ogg", opus: "audio/ogg", m4a: "audio/mp4" };
const b64ToBytes = b => Uint8Array.from(atob(b), c => c.charCodeAt(0));

// ------------------------------------------------------------------------------------------------ API
class ApiError extends Error { constructor(status, code, message) { super(message); this.status = status; this.code = code; } }
const API = {
  token: () => store.get("token", ""),
  headers(h = {}) { const t = this.token(); return t ? { ...h, Authorization: "Bearer " + t } : h; },
  url(p) { const t = this.token(); return t ? p + (p.includes("?") ? "&" : "?") + "token=" + encodeURIComponent(t) : p; },
  async req(path, { method = "GET", json, form, timeout = 30000, signal, raw = false } = {}) {
    const ctl = new AbortController(); const timer = timeout ? setTimeout(() => ctl.abort("timeout"), timeout) : null;
    if (signal) signal.addEventListener("abort", () => ctl.abort(signal.reason), { once: true });
    let r;
    try {
      r = await fetch(path, { method, signal: ctl.signal, body: json !== undefined ? JSON.stringify(json) : form,
        headers: this.headers(json !== undefined ? { "Content-Type": "application/json" } : {}) });
    } catch (e) {
      if (ctl.signal.aborted) throw new ApiError(0, ctl.signal.reason === "timeout" ? "timeout" : "aborted", ctl.signal.reason === "timeout" ? "the server took too long to answer" : "cancelled");
      throw new ApiError(0, "offline", "cannot reach the FireVoice server");
    } finally { if (timer) clearTimeout(timer); }
    if (!r.ok) {
      let code = "http_" + r.status, msg = r.statusText || "request failed";
      try { const j = await r.json(); code = j.error?.code || code; msg = j.error?.message || JSON.stringify(j); } catch { /* not JSON */ }
      throw new ApiError(r.status, code, msg);
    }
    return raw ? r : r.status === 204 ? null : r.json();
  },
};

// ------------------------------------------------------------------------------------------------ state
const S = window.S = {
  opt: null, voices: [], styles: [], engines: [], online: null, mode: store.get("mode", "render"), voiceMode: store.get("voiceMode", "library"),
  voice: store.get("voice", "default"), style: store.get("style", "conversational"), engine: store.get("engine", null),
  params: store.get("params", {}), pace: store.get("pace", 1), busy: false, abort: null, history: [], jobs: {}, es: null, vquick: "",
};

// ------------------------------------------------------------------------------------------------ toasts + drawer
function toast(msg, kind = "") {
  const el = document.createElement("div"); el.className = "toast " + kind;
  el.innerHTML = `${icon(kind === "bad" ? "alert" : kind === "ok" ? "check" : "zap", "sm")}<div>${esc(msg)}</div><button class="x">${icon("x", "sm")}</button>`;
  $("#toasts").appendChild(el); const kill = () => el.remove(); el.querySelector(".x").onclick = kill; setTimeout(kill, kind === "bad" ? 7000 : 3500);
}
const Drawer = {
  open(title, body, foot = "") { $("#drawer-title").textContent = title; $("#drawer-body").innerHTML = body; $("#drawer-foot").innerHTML = foot;
    $("#drawer").classList.add("on"); $("#drawer-bg").classList.add("on"); setTimeout(() => $("#drawer-body input, #drawer-body textarea")?.focus(), 250); },
  close() { $("#drawer").classList.remove("on"); $("#drawer-bg").classList.remove("on"); },
};
$("#drawer-x").onclick = Drawer.close; $("#drawer-bg").onclick = Drawer.close;
function busyBtn(btn, on, label) {
  if (!btn) return;
  if (on) { btn._html = btn.innerHTML; btn.disabled = true; btn.innerHTML = `<span class="spin"></span>${label ? esc(label) : ""}`; }
  else { btn.disabled = false; if (btn._html) btn.innerHTML = btn._html; }
}

// ------------------------------------------------------------------------------------------------ router
const PAGES = ["speak", "projects", "dialogue", "changer", "dub", "sound", "voices", "stt", "jobs", "styles", "dictionary", "engines"];
function route() {
  const p = PAGES.includes(location.hash.slice(1)) ? location.hash.slice(1) : "speak";
  $$(".page").forEach(s => s.classList.toggle("on", s.id === "page-" + p));
  $$(".nav a").forEach(a => a.classList.toggle("on", a.dataset.page === p));
  $("#main").scrollTop = 0;
  if (p === "voices") renderVoiceGrid();
  if (p === "jobs") loadJobs();
  if (p === "styles") renderStyles();
  if (p === "engines") loadEngines();
  if (p === "dictionary") loadDict();
  if (p === "projects") window.loadProjects?.();
  if (p === "changer") window.loadChanger?.();
  if (p === "dialogue") window.loadDialogue?.();
  if (p === "dub") window.loadDub?.();
  if (p === "sound") window.loadSound?.();
}
window.addEventListener("hashchange", route);

// ------------------------------------------------------------------------------------------------ server status
async function poll() {
  try {
    const s = await API.req("/api/v1/system", { timeout: 6000 });
    setOnline(true);
    const g = s.gpu || {};
    $("#gpu-name").textContent = g.name ? g.name.replace("NVIDIA GeForce ", "") : "CPU";
    const used = g.vram_used_gb ?? (g.vram_total_gb && g.vram_free_gb != null ? g.vram_total_gb - g.vram_free_gb : null);
    $("#gpu-mem").textContent = g.vram_total_gb ? `${(used ?? 0).toFixed(1)} / ${g.vram_total_gb.toFixed(1)} GB` : "no GPU info";
    $("#gpu-temp").textContent = g.temperature_c != null ? `${g.temperature_c}°C · ${g.utilization ?? 0}%` : "";
    $("#gpu-bar").style.width = g.vram_total_gb ? `${Math.min(100, (100 * (used ?? 0)) / g.vram_total_gb)}%` : "0%";
    $("#gpu-loaded").textContent = s.loaded_engines.length ? "loaded: " + s.loaded_engines.join(", ") : "no engine loaded";
    const active = (s.jobs.running || 0) + (s.jobs.queued || 0); const nj = $("#n-jobs");
    nj.textContent = active ? active : ""; nj.classList.toggle("live", !!active);
    S.sys = s;
    if (!S.opt) await init();
  } catch (e) { if (e.code === "unauthorized") { setOnline(true); toast("This server needs an API token: open Settings", "bad"); } else setOnline(false, e.message); }
}
function setOnline(ok, msg) {
  if (S.online === ok) return; S.online = ok;
  $("#srv-dot").className = "dot " + (ok ? "ok" : "bad");
  $("#offline").classList.toggle("on", !ok); if (!ok) { $("#offline-msg").textContent = `Cannot reach the FireVoice server (${msg || "offline"}). Retrying…`; $("#gpu-name").textContent = "Offline"; }
}
$("#retry").onclick = poll;
setInterval(poll, 8000);

// ------------------------------------------------------------------------------------------------ init
async function init() {
  const [opt, vs] = await Promise.all([API.req("/api/v1/options"), API.req("/api/v1/voices")]);
  S.opt = opt; S.engines = opt.engines; S.styles = opt.styles; S.voices = vs.voices;
  if (!S.engine || !S.engines.some(e => e.name === S.engine && e.ready)) S.engine = opt.default_engine;
  if (!S.styles.some(s => s.name === S.style)) S.style = "conversational";
  $("#n-voices").textContent = S.voices.length; $("#n-styles").textContent = S.styles.length;
  $("#format").innerHTML = opt.formats.filter(f => f !== "pcm16").map(f => `<option>${f}</option>`).join("");
  $("#vlang").innerHTML = `<option value="">All languages</option>` + opt.languages.map(l => `<option value="${esc(l)}">${esc(langName(l))}</option>`).join("");
  restoreForm(); renderEngineSelect(); renderStyleGrid(); renderVoiceQuick(); renderVoiceMini(); renderKnobs(); updateStats(); setMode(S.mode); setVoiceMode(S.voiceMode);
  route();
}
const LANGS = { en: "English", ur: "Urdu", hi: "Hindi", ar: "Arabic", zh: "Chinese", es: "Spanish", fr: "French", de: "German", ja: "Japanese", tr: "Turkish" };
const langName = c => LANGS[c] ? `${LANGS[c]} (${c})` : c;

// ------------------------------------------------------------------------------------------------ speak: form
const FORM_IDS = ["text", "format", "sample_rate", "lufs", "language", "seed", "candidates", "instruct", "overrides", "design"];
function restoreForm() {
  const f = store.get("form", {});
  FORM_IDS.forEach(id => { if (f[id] !== undefined && $("#" + id)) $("#" + id).value = f[id]; });
  if (!$("#text").value) $("#text").value = "Hello! This is FireVoice, running entirely on your own GPU. [pause 400ms] Every sentence is rendered in parallel, checked by speech recognition, and mastered before you hear it.";
  if (f.validate !== undefined) $("#validate").checked = f.validate;
  if (f.keep !== undefined) $("#keep").checked = f.keep;
}
const saveForm = debounce(() => {
  const f = {}; FORM_IDS.forEach(id => f[id] = $("#" + id)?.value); f.validate = $("#validate").checked; f.keep = $("#keep").checked; store.set("form", f);
  ["voice", "style", "engine", "params", "pace", "mode", "voiceMode"].forEach(k => store.set(k, S[k]));
}, 300);
FORM_IDS.forEach(id => $("#" + id)?.addEventListener("input", saveForm)); $("#validate").onchange = saveForm; $("#keep").onchange = saveForm;

function updateStats() {
  const t = $("#text").value.replace(/\[[^\]]*\]/g, " "); const words = (t.match(/\S+/g) || []).length;
  const pauses = [...$("#text").value.matchAll(/\[pause (\d+)ms\]/g)].reduce((a, m) => a + +m[1] / 1000, 0);
  $("#st-words").textContent = words; $("#st-chars").textContent = $("#text").value.length;
  $("#st-dur").textContent = fmtTime(words / 2.6 / (S.pace || 1) + pauses);
}
$("#text").addEventListener("input", updateStats);
$("#clear-text").onclick = () => { $("#text").value = ""; updateStats(); saveForm(); $("#text").focus(); };
$$("[data-ins]").forEach(b => b.onclick = () => insert(b.dataset.ins));
$("#ins-delivery")?.addEventListener("change", e => { if (e.target.value) insert(e.target.value); e.target.value = ""; });
function insert(s) {
  const ta = $("#text"); const a = ta.selectionStart, b = ta.selectionEnd; const pad = a > 0 && !/\s$/.test(ta.value.slice(0, a)) ? " " : "";
  ta.setRangeText(pad + s + " ", a, b, "end"); ta.focus(); updateStats(); saveForm();
}
$("#dice").onclick = () => { $("#seed").value = Math.floor(Math.random() * 1e6); saveForm(); };

// mode
function setMode(m) {
  S.mode = m; $$("#mode-seg button").forEach(b => b.classList.toggle("on", b.dataset.mode === m));
  $("#go-label").textContent = { render: "Render", stream: "Stream", job: "Queue job" }[m]; saveForm();
}
$$("#mode-seg button").forEach(b => b.onclick = () => setMode(b.dataset.mode));

// voice
function setVoiceMode(m) {
  S.voiceMode = m; $$("#voice-seg button").forEach(b => b.classList.toggle("on", b.dataset.v === m));
  $("#voice-library").classList.toggle("hidden", m !== "library"); $("#voice-design").classList.toggle("hidden", m !== "design"); checkCompat(); saveForm();
}
$$("#voice-seg button").forEach(b => b.onclick = () => setVoiceMode(b.dataset.v));
const DESIGN_IDEAS = ["a warm, confident documentary narrator", "a bright young woman podcast host", "a gravelly old storyteller with a British accent",
  "a calm meditation guide, soft and slow", "an energetic sports commentator", "a Pakistani man speaking English with a warm accent"];
$("#design-ideas").innerHTML = DESIGN_IDEAS.map(d => `<button class="chip" data-d="${esc(d)}">${esc(d.replace(/^an? /, ""))}</button>`).join("");
$$("#design-ideas .chip").forEach(c => c.onclick = () => { $("#design").value = c.dataset.d; saveForm(); });

function renderVoiceQuick() {
  const langs = [...new Set(S.voices.map(v => v.language || "en"))];
  const q = [["", "All"], ["g:female", "Female"], ["g:male", "Male"], ["k:designed", "Designed"], ...langs.filter(l => l !== "en").map(l => ["l:" + l, LANGS[l] || l])];
  $("#vquick").innerHTML = q.map(([k, l]) => `<button class="chip ${S.vquick === k ? "on" : ""}" data-q="${k}">${esc(l)}</button>`).join("");
  $$("#vquick .chip").forEach(c => c.onclick = () => { S.vquick = c.dataset.q; renderVoiceQuick(); renderVoiceMini(); });
}
function voiceMatches(v, q, quick) {
  if (quick) { const [k, val] = quick.split(":"); if (k === "g" && v.gender !== val) return false; if (k === "k" && v.kind !== val) return false; if (k === "l" && (v.language || "en") !== val) return false; }
  if (!q) return true; q = q.toLowerCase();
  return [v.voice_id, v.name, v.tagline, v.description, v.accent, v.language, v.gender, ...(v.tags || []), ...(v.traits || []), ...(v.use_cases || [])].join(" ").toLowerCase().includes(q);
}
function voiceSub(v) { return [v.gender || "voice", langName(v.language || "en"), v.accent && v.accent.replace(/ accent$/, "").slice(0, 34), v.kind === "designed" ? "designed" : ""].filter(Boolean).join(" · "); }
const avatarUrl = v => v.avatar ? API.url(`/api/v1/voices/${encodeURIComponent(v.voice_id)}/avatar?v=${v.avatar}`) : null;
function avatar(v, lg) {
  const url = avatarUrl(v);
  return `<div class="avatar ${url ? "img" : v.kind === "designed" ? "design" : esc(v.gender || "neutral")} ${lg ? "lg" : ""}">${url ? `<img src="${esc(url)}" alt="" loading="lazy">` : esc(initials(v.name || v.voice_id))}</div>`;
}
function renderVoiceMini() {
  const q = $("#vsearch").value;
  let list = S.voices.filter(v => voiceMatches(v, q, S.vquick)).sort((a, b) => (a.kind === "designed") - (b.kind === "designed"));   // real voices first
  const def = S.voices.find(v => v.default);
  const rows = [`<div class="v-row ${S.voice === "default" ? "on" : ""}" data-id="default"><div class="avatar neutral">★</div><div class="meta"><div class="id">Default voice</div><div class="sub">${esc(def ? (def.name || def.voice_id) + " · " + (def.tagline || "") : "library default")}</div></div></div>`]
    .concat(list.slice(0, 400).map(v => `<div class="v-row ${S.voice === v.voice_id ? "on" : ""}" data-id="${esc(v.voice_id)}" title="${esc(v.voice_id)}">${avatar(v)}<div class="meta"><div class="id">${esc(v.name || v.voice_id)} ${v.quality?.tier === "S" ? '<span class="tier S">★</span>' : ""}</div><div class="sub">${esc(v.tagline || voiceSub(v))}</div></div>
      ${v.has_ref ? `<button class="playbtn" data-play="${esc(v.voice_id)}" title="Hear ${esc(v.name || v.voice_id)}">${icon("play")}</button>` : ""}</div>`));
  $("#vlist-mini").innerHTML = rows.join("") + (list.length ? "" : `<div class="small dim" style="padding:10px">No voices match.</div>`);
  $$("#vlist-mini .v-row").forEach(r => r.onclick = e => { if (e.target.closest(".playbtn")) return; S.voice = r.dataset.id; $$("#vlist-mini .v-row").forEach(x => x.classList.toggle("on", x === r)); checkCompat(); saveForm(); });
  bindPreview($("#vlist-mini"));
}
$("#vsearch").addEventListener("input", debounce(renderVoiceMini, 120));

// one shared preview player for every "hear the original" button
let PREV = null;
function bindPreview(root) {
  $$("[data-play]", root).forEach(b => b.onclick = e => {
    e.stopPropagation(); const a = $("#preview-audio"); const id = b.dataset.play;
    if (PREV === id && !a.paused) { a.pause(); return; }
    $$("[data-play].on").forEach(x => { x.classList.remove("on"); x.innerHTML = icon("play"); });
    a.src = API.url(`/api/v1/voices/${encodeURIComponent(id)}/${b.dataset.orig ? "audio" : "preview"}`); a.play().catch(err => toast("cannot play: " + err.message, "bad"));
    PREV = id; b.classList.add("on"); b.innerHTML = icon("pause");
    a.onended = a.onpause = () => { b.classList.remove("on"); b.innerHTML = icon("play"); };
  });
}

// engine
function engine() { return S.engines.find(e => e.name === S.engine) || S.engines[0]; }
function renderEngineSelect() {
  $("#engine").innerHTML = S.engines.map(e => `<option value="${e.name}" ${e.ready ? "" : "disabled"}>${esc(e.title)}${e.loaded ? "  ● loaded" : ""}${e.ready ? "" : "  (not installed)"}</option>`).join("");
  $("#engine").value = S.engine; renderEngineInfo();
}
function renderEngineInfo() {
  const e = engine(); if (!e) return;
  $("#engine-badges").innerHTML = [e.loaded ? `<span class="tag ok">loaded</span>` : `<span class="tag">idle</span>`, e.commercial ? "" : `<span class="tag warn">non-commercial</span>`].join("");
  const caps = ["clone", "design", "instruct", "tags"].filter(k => e[k]);
  $("#engine-note").innerHTML = `${e.sample_rate / 1000} kHz · ${esc(e.license)} · can ${caps.join(", ") || "speak"}${e.speed_rtf ? ` · RTF ${e.speed_rtf}` : ""}${e.notes ? "<br>" + esc(e.notes) : ""}`;
  $("#tag-chips").innerHTML = e.tags ? ["laugh", "chuckle", "giggle", "sigh", "gasp", "cough", "clear throat", "sniff", "groan", "hmm"].map(t => `<button class="chip" data-ins="[${t}]">[${t}]</button>`).join("") : "";
  $$("#tag-chips [data-ins]").forEach(b => b.onclick = () => insert(b.dataset.ins));
  checkCompat();
}
$("#engine").onchange = () => { S.engine = $("#engine").value; renderEngineInfo(); renderKnobs(); saveForm(); };
function checkCompat() {
  const e = engine(); if (!e) return null; let msg = null;
  if (S.voiceMode === "design" && !e.design && !e.presets?.length) msg = `${e.title} cannot design voices; pick VoxCPM2, OmniVoice, Qwen3 VoiceDesign, Breeze or Maya1.`;
  if (S.voiceMode === "library" && !e.clone && S.voice !== "default") msg = `${e.title} cannot clone a library voice; switch the voice to Design.`;
  $("#engine-note").classList.toggle("warn-row", !!msg); if (msg) $("#engine-note").textContent = msg;
  return msg;
}

// style
function renderStyleGrid() {
  $("#style-grid").innerHTML = S.styles.map(s => `<button class="style-opt ${s.name === S.style ? "on" : ""}" data-s="${esc(s.name)}" title="${esc(s.description)}"><div class="t">${esc(s.title || s.name)}</div><div class="d">${esc(s.description)}</div></button>`).join("");
  $$("#style-grid .style-opt").forEach(b => b.onclick = () => { S.style = b.dataset.s; $$("#style-grid .style-opt").forEach(x => x.classList.toggle("on", x === b)); $("#style-name").textContent = S.style; saveForm(); });
  $("#style-name").textContent = S.style; $("#style-grid .style-opt.on")?.scrollIntoView({ block: "nearest" });
}

// knobs: pace + every engine parameter from its schema
function knobHTML(p, val, isDefault) {
  const pct = p.min != null ? (100 * ((val ?? p.default ?? p.min) - p.min)) / (p.max - p.min) : 50;
  return `<div class="knob ${isDefault ? "" : "set"}" data-k="${esc(p.name)}"><div class="top"><span class="n">${esc(p.label || p.name)}</span><span class="k">${esc(p.name)}</span>
    <button class="reset" title="Back to default">${icon("reset", "sm")}</button><span class="v ${isDefault ? "def" : ""}">${isDefault ? "default " + (p.default ?? "") : val}</span></div>
    <input type="range" class="rng ${isDefault ? "def" : ""}" min="${p.min}" max="${p.max}" step="${p.step || (p.type === "int" ? 1 : 0.05)}" value="${val ?? p.default ?? p.min}" style="--p:${pct}%">
    ${p.help ? `<div class="help">${esc(p.help)}</div>` : ""}</div>`;
}
function renderKnobs() {
  const pace = { name: "pace", label: "Pace", type: "float", min: 0.5, max: 2, step: 0.05, default: 1, help: "tempo multiplier on top of the style" };
  $("#knobs-delivery").innerHTML = knobHTML(pace, S.pace, S.pace === 1);
  bindKnob($("#knobs-delivery .knob"), pace, v => { S.pace = v ?? 1; updateStats(); });
  const e = engine(); const box = $("#knobs-engine"); const vals = S.params[e.name] || {};
  if (!e.params.length) { box.innerHTML = `<div class="small dim">${esc(e.title)} has no extra settings.</div>`; return; }
  box.innerHTML = `<div class="sep"></div><label class="f" style="margin-bottom:10px">${esc(e.title)} settings</label>` + e.params.map(p => {
    const v = vals[p.name];
    if ((p.type === "float" || p.type === "int") && p.min != null) return knobHTML(p, v, v === undefined);
    if (p.type === "bool") return `<div class="knob" data-k="${p.name}"><label class="toggle"><input type="checkbox" ${v ? "checked" : ""}><span class="sw"></span>${esc(p.label || p.name)}</label>${p.help ? `<div class="help">${esc(p.help)}</div>` : ""}</div>`;
    if (p.type === "enum") return `<div class="field" data-k="${p.name}"><label class="f">${esc(p.label || p.name)}</label><select class="inp"><option value="">Default (${esc(p.default)})</option>${p.choices.map(c => `<option ${v === c ? "selected" : ""}>${esc(c)}</option>`).join("")}</select></div>`;
    if (p.type === "vector") return `<div class="field" data-k="${p.name}"><label class="f">${esc(p.label || p.name)} <span class="hint">(${(p.labels || []).join(", ")})</span></label><input class="inp mono" value="${esc((v || []).join(", "))}" placeholder="${p.length} numbers between ${p.min} and ${p.max}"></div>`;
    return `<div class="field" data-k="${p.name}"><label class="f">${esc(p.label || p.name)}</label><input class="inp" value="${esc(v ?? "")}" placeholder="${esc(p.default ?? p.help ?? "")}"></div>`;
  }).join("");
  e.params.forEach(p => {
    const el = $(`[data-k="${p.name}"]`, box); const set = v => { const cur = { ...(S.params[e.name] || {}) }; if (v === undefined || v === "" || v === null) delete cur[p.name]; else cur[p.name] = v; S.params[e.name] = cur; saveForm(); };
    if (el.classList.contains("knob") && el.querySelector("input[type=range]")) bindKnob(el, p, set);
    else if (p.type === "bool") el.querySelector("input").onchange = ev => set(ev.target.checked || undefined);
    else if (p.type === "vector") el.querySelector("input").oninput = ev => set(ev.target.value.trim() ? ev.target.value.split(",").map(x => +x.trim()) : undefined);
    else el.querySelector("select,input").oninput = ev => set(ev.target.value || undefined);
  });
}
function bindKnob(el, p, onSet) {
  const r = el.querySelector("input[type=range]"), v = el.querySelector(".v");
  const paint = () => r.style.setProperty("--p", `${(100 * (r.value - p.min)) / (p.max - p.min)}%`);
  r.oninput = () => { el.classList.add("set"); r.classList.remove("def"); v.classList.remove("def"); v.textContent = r.value; paint(); onSet(p.type === "int" ? parseInt(r.value) : parseFloat(r.value)); };
  el.querySelector(".reset").onclick = () => { el.classList.remove("set"); r.classList.add("def"); v.classList.add("def"); v.textContent = "default " + (p.default ?? ""); r.value = p.default ?? p.min; paint(); onSet(undefined); };
}

// ------------------------------------------------------------------------------------------------ speak: request
function buildRequest() {
  const e = engine(); const text = $("#text").value.trim();
  if (!text) throw new Error("Write something to say first.");
  const compat = checkCompat(); if (compat) throw new Error(compat);
  let voice = S.voice;
  if (S.voiceMode === "design") { const d = $("#design").value.trim(); if (!d) throw new Error("Describe the voice to design, or switch to Library."); voice = "design:" + d; }
  const b = { text, engine: e.name, voice, style: S.style, pace: S.pace, seed: +$("#seed").value || 1234, candidates: +$("#candidates").value,
    validate: $("#validate").checked, params: { ...(S.params[e.name] || {}) }, format: $("#format").value, keep_takes: $("#keep").checked };
  if ($("#instruct").value.trim()) b.instruct = $("#instruct").value.trim();
  const lang = $("#language").value.trim(); if (lang && lang !== "auto") b.language = lang;
  b.lufs = $("#lufs").value === "" ? null : +$("#lufs").value;
  if ($("#sample_rate").value) b.sample_rate = +$("#sample_rate").value;
  const ov = $("#overrides").value.trim(); if (ov) { try { b.style_overrides = JSON.parse(ov); } catch { throw new Error("Style overrides must be valid JSON, for example {\"pause\": 1.2}"); } }
  return b;
}
$("#copy-json").onclick = async () => { try { await navigator.clipboard.writeText(JSON.stringify(buildRequest(), null, 2)); toast("Request JSON copied", "ok"); } catch (e) { toast(e.message, "bad"); } };
$("#copy-curl").onclick = async () => {
  try { const b = buildRequest(); const t = API.token();
    await navigator.clipboard.writeText(`curl -s ${location.origin}/api/v1/tts -H "Content-Type: application/json"${t ? ` -H "Authorization: Bearer ${t}"` : ""} -o out.${b.format} -d '${JSON.stringify(b).replace(/'/g, "'\\''")}'`);
    toast("curl command copied", "ok"); } catch (e) { toast(e.message, "bad"); }
};

function setBusy(on) {
  S.busy = on; $("#go").disabled = on; $("#stop").classList.toggle("hidden", !on);
  if (on) { $("#go")._html = $("#go").innerHTML; $("#go").innerHTML = `<span class="spin"></span><span id="go-timer">Working…</span>`; }
  else if ($("#go")._html) { $("#go").innerHTML = $("#go")._html; }
}
$("#stop").onclick = () => S.abort?.abort("user");
$("#go").onclick = () => go();
async function go() {
  if (S.busy) return;
  let b; try { b = buildRequest(); } catch (e) { toast(e.message, "bad"); return; }
  if (S.mode === "job") return queueJob(b);
  const e = engine(); S.abort = new AbortController(); setBusy(true);
  const t0 = performance.now(); const tick = setInterval(() => { const el = $("#go-timer"); if (el) el.textContent = `${((performance.now() - t0) / 1000).toFixed(1)}s${e.loaded ? "" : " · loading engine"}`; }, 100);
  try { if (S.mode === "stream") await doStream(b, t0); else await doRender(b, t0); }
  catch (err) { if (err.code !== "aborted") { toast(err.message, "bad"); showError(err); } else toast("Stopped"); }
  finally { clearInterval(tick); setBusy(false); S.abort = null; refreshEngines(); }
}
function showError(err) { $("#result").innerHTML = `<div class="empty"><svg class="i"><use href="#i-alert"/></svg><b>${esc(err.code || "error")}</b><span class="small">${esc(err.message)}</span></div>`; }

async function doRender(b, t0) {
  $("#result").innerHTML = `<div class="skeleton" style="height:64px"></div><div class="metrics">${"<div class='skeleton' style='height:52px'></div>".repeat(4)}</div>`;
  const j = await API.req("/api/v1/tts", { method: "POST", json: { ...b, response: "json" }, timeout: 0, signal: S.abort.signal });
  const blob = new Blob([b64ToBytes(j.audio_base64)], { type: MIME[j.format] || "audio/mpeg" });
  const item = { id: Date.now(), text: b.text, voice: b.voice, style: b.style, engine: j.engine, format: j.format, blob, info: j, rtt: (performance.now() - t0) / 1000 };
  S.history.unshift(item); renderHistory(); showResult(item, true);
}

async function doStream(b, t0) {
  const ctx = new AudioContext(); let at = 0, firstAt = null, total = 0, sr = 0; const pcm = []; let doneInfo = null; const words = [];
  $("#result").innerHTML = `<div class="player"><button class="pp" disabled>${icon("pause")}</button><div class="wave"><canvas id="live-wave"></canvas></div><span class="time" id="live-time">0:00</span></div>
    <div class="chunkbar" id="chunkbar"></div><div class="metrics"><div class="metric"><div class="l">First audio</div><div class="v" id="m-first">…</div></div>
    <div class="metric"><div class="l">Sentences</div><div class="v" id="m-chunks">0</div></div><div class="metric"><div class="l">Status</div><div class="v" id="m-status">streaming</div></div></div><div class="words" id="live-words"></div>`;
  const cv = $("#live-wave"); let startCtx = null;
  const draw = () => { if (!cv.isConnected) return; const all = concat(pcm); const played = startCtx === null ? 0 : (ctx.currentTime - startCtx) / Math.max(0.01, all.length / (sr || 1));
    drawWave(cv, peaks(all, 180), Math.min(1, played), Math.max(1, all.length / (sr || 1)) / Math.max(1, total || all.length / (sr || 1))); $("#live-time").textContent = fmtTime(startCtx === null ? 0 : ctx.currentTime - startCtx);
    if (!doneInfo || ctx.currentTime < at) requestAnimationFrame(draw); };
  requestAnimationFrame(draw);
  const r = await API.req("/api/v1/tts/stream", { method: "POST", json: { ...b, format: "wav" }, timeout: 0, signal: S.abort.signal, raw: true });
  const reader = r.body.pipeThrough(new TextDecoderStream()).getReader(); let buf = "";
  S.abort.signal.addEventListener("abort", () => { try { ctx.close(); } catch { /* closed */ } }, { once: true });
  for (;;) {
    const { value, done } = await reader.read(); if (done) break; buf += value; let i;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const block = buf.slice(0, i); buf = buf.slice(i + 2);
      const data = block.split("\n").filter(l => l.startsWith("data:")).map(l => l.slice(5)).join("\n"); if (!data) continue;
      const ev = JSON.parse(data);
      if (ev.type === "chunk") {
        total = ev.total;
        if (!$("#chunkbar").children.length) $("#chunkbar").innerHTML = "<i></i>".repeat(ev.total);
        if (!ev.final) { $("#chunkbar").children[ev.index]?.classList.add("got"); $("#m-chunks").textContent = `${ev.index + 1} / ${ev.total}`; }
        ev.words.forEach(w => { words.push(w); const s = document.createElement("span"); s.textContent = w.text; $("#live-words").append(s, " "); });
        if (!ev.audio_base64) continue;
        const ab = await ctx.decodeAudioData(b64ToBytes(ev.audio_base64).buffer); sr = ab.sampleRate; pcm.push(ab.getChannelData(0).slice());
        if (firstAt === null) { firstAt = (performance.now() - t0) / 1000; $("#m-first").innerHTML = `${firstAt.toFixed(2)}<small>s</small>`; at = ctx.currentTime + 0.06; startCtx = at; }
        const src = ctx.createBufferSource(); src.buffer = ab; src.connect(ctx.destination); const when = Math.max(at, ctx.currentTime); src.start(when); at = when + ab.duration;
        const idx = ev.index; src.onended = () => $("#chunkbar")?.children[idx]?.classList.replace("got", "play");
      } else if (ev.type === "done") { doneInfo = ev; $("#m-status").innerHTML = `<span style="color:var(--ok)">done</span>`; }
      else if (ev.type === "error") throw new ApiError(400, ev.code, ev.message);
    }
  }
  if (!doneInfo) throw new ApiError(0, "aborted", "stream ended early");
  const all = concat(pcm); const blob = encodeWav(all, sr);
  const item = { id: Date.now(), text: b.text, voice: b.voice, style: b.style, engine: doneInfo.engine, format: "wav", blob, streamed: true, firstAt,
    info: { ...doneInfo, words, format: "wav", sample_rate: sr }, rtt: (performance.now() - t0) / 1000 };
  S.history.unshift(item); renderHistory();
  const wait = Math.max(0, (at - ctx.currentTime) * 1000);
  setTimeout(() => { try { ctx.close(); } catch { /* closed */ } if ($("#live-wave")) showResult(item, false); }, wait + 150);
}
const concat = arrs => { const n = arrs.reduce((a, x) => a + x.length, 0); const out = new Float32Array(n); let o = 0; arrs.forEach(x => { out.set(x, o); o += x.length; }); return out; };
function encodeWav(f32, sr) {
  const b = new ArrayBuffer(44 + f32.length * 2), v = new DataView(b); const w = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  w(0, "RIFF"); v.setUint32(4, 36 + f32.length * 2, true); w(8, "WAVE"); w(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, sr, true); v.setUint32(28, sr * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, "data"); v.setUint32(40, f32.length * 2, true);
  for (let i = 0; i < f32.length; i++) v.setInt16(44 + i * 2, Math.max(-1, Math.min(1, f32[i])) * 0x7fff, true);
  return new Blob([b], { type: "audio/wav" });
}

async function queueJob(b) {
  const fmt = b.format, sr = b.sample_rate; delete b.format; delete b.sample_rate;
  try { const j = await API.req("/api/v1/jobs", { method: "POST", json: { kind: "tts", payload: { request: b, format: fmt, sample_rate: sr ?? null } } });
    toast(`Queued: ${j.title}`, "ok"); location.hash = "#jobs"; } catch (e) { toast(e.message, "bad"); }
}

// ------------------------------------------------------------------------------------------------ waveform player
function peaks(f32, n) {
  const out = new Float32Array(n); if (!f32.length) return out; const step = Math.max(1, Math.floor(f32.length / n));
  for (let i = 0; i < n; i++) { let m = 0; const s = i * step, e = Math.min(f32.length, s + step); for (let j = s; j < e; j += 4) { const a = Math.abs(f32[j]); if (a > m) m = a; } out[i] = m; }
  const mx = Math.max(...out, 0.01); return out.map(x => Math.pow(x / mx, 0.8));
}
function drawWave(cv, pk, progress = 0, fill = 1) {
  const dpr = window.devicePixelRatio || 1, w = cv.clientWidth, h = cv.clientHeight; if (!w) return;
  if (cv.width !== w * dpr) { cv.width = w * dpr; cv.height = h * dpr; }
  const c = cv.getContext("2d"); c.setTransform(dpr, 0, 0, dpr, 0, 0); c.clearRect(0, 0, w, h);
  const n = pk.length, gap = 2, bw = Math.max(1.5, (w * fill) / n - gap); const grad = c.createLinearGradient(0, 0, w, 0);
  grad.addColorStop(0, "#ff9a5c"); grad.addColorStop(1, "#ff6a3d");
  for (let i = 0; i < n; i++) { const x = (i * (w * fill)) / n, bh = Math.max(2, pk[i] * (h - 6)); c.fillStyle = i / n < progress ? grad : "#2b3142";
    c.beginPath(); c.roundRect ? c.roundRect(x, (h - bh) / 2, bw, bh, 2) : c.rect(x, (h - bh) / 2, bw, bh); c.fill(); }
}
async function blobPeaks(blob, n = 220) {
  try { const ctx = new OfflineAudioContext(1, 1, 44100); const ab = await ctx.decodeAudioData(await blob.arrayBuffer()); return peaks(ab.getChannelData(0), n); }
  catch { return new Float32Array(n).fill(0.4); }
}
function showResult(item, autoplay) {
  const j = item.info; const url = item.url || (item.url = URL.createObjectURL(item.blob));
  $("#res-tags").innerHTML = `<span class="tag">${esc(vName(item.voice).slice(0, 40))}</span><span class="tag acc">${esc(item.engine)}</span><span class="tag">${esc(item.style)}</span>${item.streamed ? '<span class="tag info">streamed</span>' : ""}`;
  const warns = j.warnings || [];
  $("#result").innerHTML = `<div class="player"><button class="pp" id="pp">${icon("play")}</button><div class="wave" id="wave"><canvas></canvas></div><span class="time" id="ptime">0:00 / ${fmtTime(j.duration)}</span></div>
    <audio id="player" src="${url}" preload="auto"></audio>
    <div class="metrics">
      <div class="metric"><div class="l">Duration</div><div class="v">${(+j.duration).toFixed(1)}<small>s</small></div></div>
      <div class="metric"><div class="l">${item.streamed ? "First audio" : "Render"}</div><div class="v">${item.streamed ? item.firstAt.toFixed(2) : (+j.seconds).toFixed(1)}<small>s</small></div></div>
      <div class="metric"><div class="l">Speed (RTF)</div><div class="v">${j.rtf ?? "-"}</div></div>
      <div class="metric"><div class="l">Sentences</div><div class="v">${j.chunks ?? "-"}<small>${j.takes ? ` · ${j.takes} takes` : ""}</small></div></div>
      <div class="metric"><div class="l">Format</div><div class="v">${esc(item.format)}<small> ${Math.round((j.sample_rate || 0) / 1000)} kHz</small></div></div>
    </div>
    ${warns.length ? `<div class="warns">${warns.map(w => `<div class="warn-row">${esc(w)}</div>`).join("")}</div>` : ""}
    <div class="words" id="pwords">${(j.words || []).map(w => `<span data-s="${w.start}" data-e="${w.end}">${esc(w.text)}</span>`).join(" ")}</div>
    <div class="row" style="margin-top:12px"><a class="btn sm" download="firevoice-${item.id}.${item.format}" href="${url}">${icon("download", "sm")}Download ${esc(item.format)}</a>
      <button class="btn sm ghost" data-sub="srt">${icon("cc", "sm")}SRT</button><button class="btn sm ghost" data-sub="vtt">${icon("cc", "sm")}VTT</button>
      <button class="btn sm ghost" id="reuse">${icon("reset", "sm")}Load these settings</button></div>
    ${j.render_id ? `<div class="takes" id="takes"><div class="skeleton" style="height:48px"></div></div>` : ""}`;
  const a = $("#player"), cv = $("#wave canvas"), pp = $("#pp"), ws = $$("#pwords span"); let pk = new Float32Array(220).fill(0.3);
  const draw = () => drawWave(cv, pk, a.duration ? a.currentTime / a.duration : 0);
  blobPeaks(item.blob).then(p => { pk = p; draw(); }); draw();
  let raf; const loop = () => { draw(); $("#ptime").textContent = `${fmtTime(a.currentTime)} / ${fmtTime(a.duration || j.duration)}`;
    ws.forEach(s => s.classList.toggle("hl", a.currentTime >= +s.dataset.s && a.currentTime < +s.dataset.e)); if (!a.paused) raf = requestAnimationFrame(loop); };
  a.onplay = () => { pp.innerHTML = icon("pause"); loop(); }; a.onpause = a.onended = () => { pp.innerHTML = icon("play"); cancelAnimationFrame(raf); loop(); };
  pp.onclick = () => a.paused ? a.play() : a.pause();
  $("#wave").onclick = ev => { const r = $("#wave").getBoundingClientRect(); if (a.duration) { a.currentTime = ((ev.clientX - r.left) / r.width) * a.duration; loop(); } };
  ws.forEach(s => s.onclick = () => { a.currentTime = +s.dataset.s; a.play(); });
  $("#reuse").onclick = () => { $("#text").value = item.text; updateStats(); toast("Script restored"); };
  $$("[data-sub]").forEach(b => b.onclick = () => downloadSubtitles(item, b.dataset.sub));
  if (j.render_id) loadTakes(item);
  if (autoplay) a.play().catch(() => { /* autoplay blocked: the play button still works */ });
}

// ------------------------------------------------------------------------------------------------ subtitles
async function downloadSubtitles(item, fmt) {
  try {
    let text;
    if (item.info.render_id) {
      const r = await API.req(`/api/v1/renders/${item.info.render_id}/subtitles?format=${fmt}`, { raw: true }); text = await r.text();
    } else {
      const r = await API.req("/api/v1/subtitles", { method: "POST", json: { words: item.info.words || [], format: fmt }, raw: true }); text = await r.text();
    }
    const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([text], { type: fmt === "vtt" ? "text/vtt" : "application/x-subrip" }));
    a.download = `firevoice-${item.id}.${fmt}`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  } catch (e) { toast(e.message, "bad"); }
}

// ------------------------------------------------------------------------------------------------ takes and QA
// Every passage of a kept render with its takes: what the speech check heard, A/B playback, a new take, lock.
let TAKE_AUDIO = null;
function playTake(rid, i, n, btn) {
  if (TAKE_AUDIO) { TAKE_AUDIO.pause(); $$(".takes .pt.on").forEach(x => x.classList.remove("on")); if (TAKE_AUDIO._key === `${i}.${n}`) { TAKE_AUDIO = null; return; } }
  $("#player")?.pause();
  TAKE_AUDIO = new Audio(API.url(`/api/v1/renders/${rid}/chunks/${i}/takes/${n}/audio?format=mp3`)); TAKE_AUDIO._key = `${i}.${n}`;
  btn?.classList.add("on"); TAKE_AUDIO.onended = () => { btn?.classList.remove("on"); TAKE_AUDIO = null; };
  TAKE_AUDIO.play().catch(e => toast(e.message, "bad"));
}
function qaHTML(chunk, take) {
  const qa = take?.qa;
  if (!qa) return esc(chunk.text);
  const words = qa.words.map(w => w.status === "ok" ? esc(w.text)
    : `<mark class="${w.status}" title="${w.status === "changed" ? `heard: ${esc(w.heard)}` : "not heard"}">${esc(w.text)}</mark>`).join(" ");
  return words + (qa.extra?.length ? ` <span class="extra" title="heard but not in the script">+ ${esc(qa.extra.join(" "))}</span>` : "");
}
async function loadTakes(item) {
  const box = $("#takes"); if (!box) return;
  const rid = item.info.render_id;
  await mountTakes(box, rid, async () => {
    const [aud, w] = await Promise.all([API.req(`/api/v1/renders/${rid}/audio?format=${item.format === "pcm16" ? "wav" : item.format}`, { raw: true }), API.req(`/api/v1/renders/${rid}/words`)]);
    if (item.url) URL.revokeObjectURL(item.url); item.url = null; item.blob = await aud.blob();
    item.info = { ...item.info, words: w.words, duration: w.duration }; renderHistory(); showResult(item, false);
  });
}
// The takes panel of any kept render (a result on Speak, or a project paragraph). `onChanged` runs after a swap,
// a new take or a lock, so the owner can reload the stitched audio.
async function mountTakes(box, rid, onChanged) {
  let m; try { m = await API.req(`/api/v1/renders/${rid}`); } catch (e) { box.innerHTML = `<span class="small dim">${esc(e.message)}</span>`; return; }
  const flagged = m.chunks.filter(c => c.flagged).length;
  box.innerHTML = `<div class="takes-h"><b>Passages and takes</b><span class="small dim">${m.chunks.length} passage${m.chunks.length === 1 ? "" : "s"}${flagged ? ` · <span class="flag">${flagged} to check</span>` : " · all passed the speech check"}</span>
      <div class="grow"></div><button class="btn sm ghost" data-quality title="Similarity to the voice, DNSMOS and drift of the stitched audio">${icon("check", "sm")}Quality</button>
      <button class="btn sm ghost" data-regen title="New takes for every unlocked passage">${icon("dice", "sm")}Re-take unlocked</button></div>
    <div class="quality-box"></div>
    ${m.chunks.map(c => { const cur = c.takes.find(t => t.n === c.chosen);
      return `<div class="take-row ${c.flagged ? "flagged" : ""} ${c.locked ? "locked" : ""}" data-i="${c.index}">
        <div class="tx">${qaHTML(c, cur)}</div>
        <div class="tk">${c.takes.map(t => `<button class="pill pt ${t.n === c.chosen ? "cur" : ""}" data-n="${t.n}" title="take ${t.n}: score ${t.score}, ${t.duration}s, seed ${t.seed}${t.n === c.chosen ? " (in use)" : " (click to play, double-click to use)"}">${t.n}</button>`).join("")}
          <button class="btn sm icon ghost" data-act="edit" title="Edit words: re-record only what you change" ${c.locked ? "disabled" : ""}>${icon("edit", "sm")}</button>
          <button class="btn sm icon ghost" data-act="new" title="New take of this passage">${icon("plus", "sm")}</button>
          <button class="btn sm icon ghost" data-act="lock" title="${c.locked ? "Unlock" : "Lock: keep this take when re-taking the rest"}">${icon(c.locked ? "lock" : "unlock", "sm")}</button></div></div>`; }).join("")}
    <div class="small dim" style="margin-top:6px">Click a take to hear it, double-click to use it. Underlined words were missed or misheard by the speech check.</div>`;
  const act = async (btn, fn, done) => {
    busyBtn(btn, true);
    try { await fn(); if (onChanged) await onChanged(); await mountTakes(box, rid, onChanged); if (done) toast(done, "ok"); }
    catch (e) { toast(e.message, "bad"); busyBtn(btn, false); }
  };
  $$(".take-row", box).forEach(row => {
    const i = +row.dataset.i;
    $$(".pt", row).forEach(b => {
      b.onclick = () => playTake(rid, i, +b.dataset.n, b);
      b.ondblclick = () => act(b, () => API.req(`/api/v1/renders/${rid}/chunks/${i}/choose`, { method: "POST", json: { take: +b.dataset.n } }), `Passage ${i + 1} uses take ${b.dataset.n}`);
    });
    $("[data-act=new]", row).onclick = e => act(e.currentTarget, () => API.req(`/api/v1/renders/${rid}/chunks/${i}/takes`, { method: "POST", json: {}, timeout: 0 }), `New take for passage ${i + 1}`);
    $("[data-act=edit]", row).onclick = () => {
      const c = m.chunks.find(x => x.index === i), tx = $(".tx", row);
      if ($("textarea", tx)) return;
      const before = tx.innerHTML;
      tx.innerHTML = `<textarea class="inp" rows="2" style="width:100%">${esc(c.text)}</textarea>
        <div class="row" style="gap:6px;margin-top:6px"><button class="btn sm primary" data-ed="splice" title="Keep the original audio; only the changed words are new">Splice in</button>
        <button class="btn sm ghost" data-ed="passage" title="Use the whole re-recorded passage">Re-record passage</button><button class="btn sm ghost" data-ed="cancel">Cancel</button></div>`;
      const ta = $("textarea", tx); ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length);
      $$("[data-ed]", tx).forEach(b => b.onclick = () => {
        if (b.dataset.ed === "cancel") { tx.innerHTML = before; return; }
        if (ta.value.trim() === c.text) { toast("Change some words first", ""); return; }
        act(b, async () => {
          const r = await API.req(`/api/v1/renders/${rid}/chunks/${i}/edit`, { method: "POST", json: { text: ta.value, mode: b.dataset.ed }, timeout: 0 });
          const e = r.chunks.find(x => x.index === i).takes.slice(-1)[0].edit || {};
          if (e.note) toast(e.note, "");
        }, b.dataset.ed === "splice" ? `Passage ${i + 1}: edited words spliced in` : `Passage ${i + 1} re-recorded`);
      });
    };
    $("[data-act=lock]", row).onclick = e => act(e.currentTarget, () => API.req(`/api/v1/renders/${rid}/chunks/${i}/lock`, { method: "POST", json: { locked: !row.classList.contains("locked") } }));
  });
  $("[data-regen]", box).onclick = e => act(e.currentTarget, () => API.req(`/api/v1/renders/${rid}/regenerate`, { method: "POST", json: {}, timeout: 0 }), "New takes for every unlocked passage");
  $("[data-quality]", box).onclick = async e => {
    const b = e.currentTarget; busyBtn(b, true, "Listening…");
    try { $(".quality-box", box).innerHTML = `<div class="card" style="padding:12px;margin:8px 0">${qualityHTML(await API.req(`/api/v1/renders/${rid}/quality`, { timeout: 0 }))}</div>`; }
    catch (err) { toast(err.message, "bad"); } finally { busyBtn(b, false); }
  };
}

// ------------------------------------------------------------------------------------------------ dictionary page
let DICT = { rules: [], builtin: [] };
async function loadDict() {
  try { DICT = await API.req("/api/v1/dictionary"); } catch (e) { toast(e.message, "bad"); return; }
  $("#n-dict").textContent = DICT.rules.length || "";
  $("#dt").innerHTML = DICT.rules.length ? DICT.rules.map(r => `<tr data-id="${esc(r.id)}">
      <td><input class="inp sm" data-f="match" value="${esc(r.match)}"></td><td><input class="inp sm" data-f="say" value="${esc(r.say)}"></td>
      <td><label class="toggle sm"><input type="checkbox" data-f="case" ${r.case ? "checked" : ""}><span class="sw"></span>exact case</label>
        <label class="toggle sm"><input type="checkbox" data-f="anywhere" ${r.whole_word ? "" : "checked"}><span class="sw"></span>inside words</label></td>
      <td style="text-align:right"><button class="btn sm icon ghost" data-del title="Delete">${icon("trash", "sm")}</button></td></tr>`).join("")
    : `<tr><td colspan="4"><span class="small dim">No rules yet. Add a name or word above that the voices say wrong.</span></td></tr>`;
  $$("#dt tr[data-id]").forEach(tr => {
    const id = tr.dataset.id;
    const save = debounce(async () => {
      const body = { match: $("[data-f=match]", tr).value, say: $("[data-f=say]", tr).value, case: $("[data-f=case]", tr).checked, whole_word: !$("[data-f=anywhere]", tr).checked };
      try { await API.req(`/api/v1/dictionary/${id}`, { method: "PATCH", json: body }); } catch (e) { toast(e.message, "bad"); }
    }, 500);
    $$("input", tr).forEach(x => x.addEventListener(x.type === "checkbox" ? "change" : "input", save));
    $("[data-del]", tr).onclick = async () => { try { await API.req(`/api/v1/dictionary/${id}`, { method: "DELETE" }); loadDict(); } catch (e) { toast(e.message, "bad"); } };
  });
  $("#d-builtin").innerHTML = DICT.builtin.map(b => `<span class="bi"><b>${esc(b.match)}</b> ${esc(b.say)}</span>`).join("");
}
$("#d-add").onclick = async () => {
  const body = { match: $("#d-match").value.trim(), say: $("#d-say").value.trim(), case: $("#d-case").checked, whole_word: !$("#d-anywhere").checked };
  if (!body.match) { toast("Write the word as it appears in scripts", "bad"); return; }
  try { await API.req("/api/v1/dictionary", { method: "POST", json: body }); $("#d-match").value = $("#d-say").value = ""; toast(`Added ${body.match}`, "ok"); loadDict(); }
  catch (e) { toast(e.message, "bad"); }
};
$("#d-say").addEventListener("keydown", e => { if (e.key === "Enter") $("#d-add").click(); });
$("#d-run").onclick = async () => {
  const text = $("#d-test").value.trim(); if (!text) return;
  try { const r = await API.req("/api/v1/dictionary/test", { method: "POST", json: { text, engine: S.engine } }); $("#d-out").textContent = r.spoken; }
  catch (e) { toast(e.message, "bad"); }
};
$("#d-test").addEventListener("keydown", e => { if (e.key === "Enter") $("#d-run").click(); });
$("#d-hear").onclick = async () => {
  const text = $("#d-test").value.trim(); if (!text) { toast("Type a sentence first", "bad"); return; }
  const btn = $("#d-hear"); busyBtn(btn, true);
  try {
    const r = await API.req("/api/v1/tts", { method: "POST", json: { text, engine: S.engine, voice: S.voice, style: S.style, format: "mp3" }, timeout: 0, raw: true });
    const a = $("#d-audio"); a.src = URL.createObjectURL(await r.blob()); a.play();
  } catch (e) { toast(e.message, "bad"); } finally { busyBtn(btn, false); }
};
$("#dict-export").onclick = () => {
  const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([JSON.stringify({ rules: DICT.rules }, null, 1)], { type: "application/json" }));
  a.download = "firevoice-dictionary.json"; a.click();
};
$("#dict-import").onclick = () => $("#d-file").click();
$("#d-file").onchange = async () => {
  const f = $("#d-file").files[0]; if (!f) return;
  try {
    let data = JSON.parse(await f.text()); let rules = Array.isArray(data) ? data : data.rules ?? data;
    if (!Array.isArray(rules)) rules = Object.entries(rules).map(([match, say]) => ({ match, say }));
    if (!confirm(`Replace your ${DICT.rules.length} rule(s) with ${rules.length} from ${f.name}?`)) return;
    await API.req("/api/v1/dictionary", { method: "PUT", json: { rules } }); toast(`Imported ${rules.length} rule(s)`, "ok"); loadDict();
  } catch (e) { toast(e.message, "bad"); } finally { $("#d-file").value = ""; }
};
window.addEventListener("resize", debounce(() => { const cv = $("#wave canvas"); if (cv) $("#player")?.dispatchEvent(new Event("pause")); }, 150));

function renderHistory() {
  if (!S.history.length) { $("#history").innerHTML = `<span class="small dim">Renders from this session appear here.</span>`; return; }
  $("#history").innerHTML = S.history.slice(0, 30).map((h, i) => `<div class="h-row"><button class="playbtn" data-h="${i}">${icon("play")}</button>
    <div class="meta"><div class="t">${esc(h.text.replace(/\[[^\]]*\]/g, "").slice(0, 110))}</div><div class="s">${esc(vName(h.voice).slice(0, 50))} · ${esc(h.style)} · ${esc(h.engine)} · ${(+h.info.duration).toFixed(1)}s${h.streamed ? " · streamed" : ""}</div></div>
    <a class="btn sm icon ghost" title="Download" download="firevoice-${h.id}.${h.format}" href="${h.url || (h.url = URL.createObjectURL(h.blob))}">${icon("download", "sm")}</a></div>`).join("");
  $$("#history [data-h]").forEach(b => b.onclick = () => { showResult(S.history[+b.dataset.h], true); $("#result").scrollIntoView({ behavior: "smooth", block: "center" }); });
}
$("#clear-history").onclick = () => { S.history.forEach(h => h.url && URL.revokeObjectURL(h.url)); S.history = []; renderHistory(); };

// ------------------------------------------------------------------------------------------------ voices page
let VF = { q: "", lang: "", gender: "", kind: "", shelf: "" };
let SHELVES = [];
async function loadShelves() {
  try { SHELVES = (await API.req("/api/v1/voices/collections")).collections; } catch { SHELVES = []; }
  $("#shelves").innerHTML = [`<button class="shelf ${VF.shelf ? "" : "on"}" data-shelf=""><div class="t">All voices</div><div class="n">${S.voices.length} voices</div></button>`]
    .concat(SHELVES.map(c => `<button class="shelf ${VF.shelf === c.id ? "on" : ""}" data-shelf="${c.id}" title="${esc(c.description)}"><div class="t">${esc(c.title)}</div><div class="n">${c.voices.length} voices</div></button>`)).join("");
  $$("#shelves .shelf").forEach(b => b.onclick = () => { VF.shelf = b.dataset.shelf; $$("#shelves .shelf").forEach(x => x.classList.toggle("on", x === b)); renderVoiceGrid(); });
}
function renderVoiceGrid() {
  if (!SHELVES.length && S.voices.length) loadShelves();
  const shelf = VF.shelf ? new Set((SHELVES.find(c => c.id === VF.shelf) || { voices: [] }).voices) : null;
  const list = S.voices.filter(v => (!shelf || shelf.has(v.voice_id)) && voiceMatches(v, VF.q, "") && (!VF.lang || (v.language || "en") === VF.lang) && (!VF.gender || v.gender === VF.gender) && (!VF.kind || v.kind === VF.kind))
    .sort((a, b) => VF.shelf ? ((a.quality?.rank ?? 999) - (b.quality?.rank ?? 999)) : (a.kind === "designed") - (b.kind === "designed"));
  $("#voices-sub").textContent = `${S.voices.length} voices · ${S.voices.filter(v => v.kind === "designed").length} designed · ${new Set(S.voices.map(v => v.language || "en")).size} languages. Showing ${list.length}.`;
  $("#vgrid").innerHTML = list.map(v => `<div class="vcard"><div class="head">${avatar(v, true)}<div class="meta"><div class="vname">${v.default ? `<span class="star">★</span> ` : ""}${esc(v.name || v.voice_id)}</div>
      <div class="small muted">${esc(voiceSub(v))}</div></div>${v.has_ref ? `<button class="playbtn" data-play="${esc(v.voice_id)}" title="Hear ${esc(v.name || v.voice_id)} introduce themselves">${icon("play")}</button>` : ""}</div>
      <div class="desc">${esc(v.tagline || v.description || "No description")}</div>
      ${v.use_cases?.length ? `<div class="uses">Great for <b>${v.use_cases.map(esc).join("</b>, <b>")}</b></div>` : ""}
      <div class="tags">${tierBadge(v)}${(v.styles || []).map(s => `<span class="tag acc">style: ${esc(s)}</span>`).join("")}<span class="tag" title="voice id">${esc(v.voice_id)}</span></div>
      <div class="foot"><button class="btn sm primary" data-use="${esc(v.voice_id)}">${icon("wave", "sm")}Use</button><button class="btn sm" data-edit="${esc(v.voice_id)}">${icon("edit", "sm")}Edit</button>
      <div style="flex:1"></div><button class="btn sm icon ghost" title="Make default" data-def="${esc(v.voice_id)}">${icon("star", "sm")}</button></div></div>`).join("")
    || `<div class="empty" style="grid-column:1/-1"><svg class="i"><use href="#i-users"/></svg><b>No voices match</b><span class="small">Clear the filters or add a voice.</span></div>`;
  bindPreview($("#vgrid"));
  $$("#vgrid [data-use]").forEach(b => b.onclick = () => { S.voice = b.dataset.use; setVoiceMode("library"); $("#vsearch").value = ""; S.vquick = ""; renderVoiceQuick(); renderVoiceMini(); saveForm(); location.hash = "#speak"; toast(`Voice: ${vName(S.voice)}`, "ok"); });
  $$("#vgrid [data-def]").forEach(b => b.onclick = () => setDefault(b.dataset.def));
  $$("#vgrid [data-edit]").forEach(b => b.onclick = () => editVoice(b.dataset.edit));
}
$("#vq").addEventListener("input", debounce(e => { VF.q = e.target.value; renderVoiceGrid(); }, 100));
$("#vlang").onchange = e => { VF.lang = e.target.value; renderVoiceGrid(); };
$$("#vgender button").forEach(b => b.onclick = () => { VF.gender = b.dataset.g; $$("#vgender button").forEach(x => x.classList.toggle("on", x === b)); renderVoiceGrid(); });
$$("#vkind button").forEach(b => b.onclick = () => { VF.kind = b.dataset.k; $$("#vkind button").forEach(x => x.classList.toggle("on", x === b)); renderVoiceGrid(); });
async function reloadVoices() { S.voices = (await API.req("/api/v1/voices")).voices; SHELVES = []; $("#n-voices").textContent = S.voices.length; renderVoiceGrid(); renderVoiceMini(); renderVoiceQuick(); }
async function setDefault(id) { try { await API.req(`/api/v1/voices/${encodeURIComponent(id)}/default`, { method: "POST" }); toast(`${id} is now the default voice`, "ok"); reloadVoices(); } catch (e) { toast(e.message, "bad"); } }

const GENDER_OPTS = g => ["", "female", "male", "neutral"].map(x => `<option value="${x}" ${g === x ? "selected" : ""}>${x || "unspecified"}</option>`).join("");
function dropzone(id, accept = "audio/*") {
  return `<div class="drop" id="${id}-drop">${icon("upload")}<div><b>Drop a clip</b> or click to choose</div><div class="small dim" id="${id}-name">6-20 s of clean speech · any format</div></div><input type="file" id="${id}" accept="${accept}" class="hidden">`;
}
function bindDrop(id) {
  const d = $(`#${id}-drop`), f = $(`#${id}`); const show = () => { const x = f.files[0]; if (x) $(`#${id}-name`).textContent = `${x.name} · ${(x.size / 1024).toFixed(0)} KB`; };
  d.onclick = () => f.click(); f.onchange = show;
  d.ondragover = e => { e.preventDefault(); d.classList.add("over"); }; d.ondragleave = () => d.classList.remove("over");
  d.ondrop = e => { e.preventDefault(); d.classList.remove("over"); if (e.dataTransfer.files[0]) { f.files = e.dataTransfer.files; show(); } };
}
$("#open-add").onclick = () => {
  Drawer.open("Add a voice from a recording", `${dropzone("ad-file")}
    <div class="grid2" style="margin-top:14px"><div class="field"><label class="f">Name</label><input class="inp" id="ad-name" placeholder="my-voice"></div>
    <div class="field"><label class="f">Gender</label><select class="inp" id="ad-gender">${GENDER_OPTS("")}</select></div>
    <div class="field"><label class="f">Language</label><input class="inp" id="ad-lang" placeholder="en"></div><div class="field"><label class="f">Accent</label><input class="inp" id="ad-accent" placeholder="e.g. Lahore, Scottish"></div></div>
    <div class="field"><label class="f">Description</label><input class="inp" id="ad-desc" placeholder="warm, mid-forties, slight gravel"></div>
    <div class="field"><label class="f">Transcript <span class="hint">(blank = transcribe automatically)</span></label><textarea class="inp" id="ad-tr" rows="2"></textarea></div>
    <div class="field"><label class="f">Tags <span class="hint">(comma-separated)</span></label><input class="inp" id="ad-tags"></div>
    <div class="field"><label class="f">Clean the clip <span class="hint">(takes out hiss, hum and room noise before cloning)</span></label>
      <select class="inp" id="ad-clean"><option value="">No, use it as recorded</option><option value="light">Light</option><option value="medium" selected>Medium</option><option value="strong">Strong</option><option value="neural">Neural (best; needs the voice separator)</option></select></div>
    <div class="field"><label class="f">Who gave consent <span class="hint">(the speaker's name, kept in the voice's consent record)</span></label><input class="inp" id="ad-consent-by" placeholder="e.g. Sara Khan"></div>
    <label class="toggle"><input type="checkbox" id="ad-consent"><span class="sw"></span>I own this voice or have permission to use it</label>`,
    `<button class="btn ghost" onclick="Drawer.close()">Cancel</button><button class="btn primary" id="ad-go">${icon("plus")}Add voice</button>`);
  bindDrop("ad-file");
  $("#ad-go").onclick = async () => {
    const f = $("#ad-file").files[0]; if (!f) return toast("Choose a clip first", "bad"); if (!$("#ad-name").value.trim()) return toast("Give the voice a name", "bad");
    if (!$("#ad-consent").checked) return toast("Confirm you have permission to use this voice", "bad");
    const fd = new FormData(); fd.append("file", f); fd.append("name", $("#ad-name").value.trim()); fd.append("consent", "true");
    [["gender", "ad-gender"], ["language", "ad-lang"], ["accent", "ad-accent"], ["description", "ad-desc"], ["transcript", "ad-tr"], ["tags", "ad-tags"], ["clean", "ad-clean"], ["consent_by", "ad-consent-by"]].forEach(([k, id]) => fd.append(k, $("#" + id).value));
    busyBtn($("#ad-go"), true, "Adding…");
    try {
      const v = await API.req("/api/v1/voices", { method: "POST", form: fd, timeout: 180000 });
      const q = v.quality_check?.after || v.quality_check?.before;
      toast(`Added ${v.voice_id}${q ? ` · clip ${q.verdict}, SNR ${q.snr_db} dB` : ""}`, q && q.verdict === "poor" ? "bad" : "ok");
      if (q?.notes?.length) toast(q.notes.join("; "), q.verdict === "poor" ? "bad" : "");
      Drawer.close(); reloadVoices();
    }
    catch (e) { toast(e.message, "bad"); busyBtn($("#ad-go"), false); }
  };
};
$("#open-design").onclick = () => {
  const eng = S.engines.filter(e => e.design && e.ready);
  Drawer.open("Design a voice", `<p class="muted" style="margin-top:0">Describe a voice and FireVoice invents it, then locks the take as the voice's reference clip, so it sounds the same everywhere afterwards.</p>
    <div class="field"><label class="f">Name</label><input class="inp" id="dz-name" placeholder="my-narrator"></div>
    <div class="field"><label class="f">Description</label><textarea class="inp" id="dz-desc" rows="3" placeholder="a calm, warm middle-aged male narrator with a slight British accent"></textarea></div>
    <div class="chips" style="margin-bottom:12px">${DESIGN_IDEAS.map(d => `<button class="chip" data-d="${esc(d)}">${esc(d.replace(/^an? /, ""))}</button>`).join("")}</div>
    <div class="grid2"><div class="field"><label class="f">Engine</label><select class="inp" id="dz-engine">${eng.map(e => `<option value="${e.name}">${esc(e.title)}</option>`).join("")}</select></div>
    <div class="field"><label class="f">Gender</label><select class="inp" id="dz-gender">${GENDER_OPTS("")}</select></div></div>
    <div class="field"><label class="f">Reference line <span class="hint">(optional, what the designed voice says)</span></label><textarea class="inp" id="dz-text" rows="2"></textarea></div>`,
    `<button class="btn ghost" onclick="Drawer.close()">Cancel</button><button class="btn" id="dz-try">${icon("dice")}Try 3 versions</button><button class="btn primary" id="dz-go">${icon("sparkle")}Design voice</button>`);
  window.bindDesignCandidates?.();
  $$("#drawer-body [data-d]").forEach(c => c.onclick = () => { $("#dz-desc").value = c.dataset.d; });
  $("#dz-go").onclick = async () => {
    const body = { name: $("#dz-name").value.trim(), description: $("#dz-desc").value.trim(), engine: $("#dz-engine").value, gender: $("#dz-gender").value };
    if ($("#dz-text").value.trim()) body.text = $("#dz-text").value.trim();
    if (!body.name || !body.description) return toast("A name and a description are needed", "bad");
    busyBtn($("#dz-go"), true, "Designing… (the first load can take minutes)");
    try { const v = await API.req("/api/v1/voices/design", { method: "POST", json: body, timeout: 0 }); toast(`Designed ${v.voice_id}`, "ok"); Drawer.close(); reloadVoices(); }
    catch (e) { toast(e.message, "bad"); busyBtn($("#dz-go"), false); }
  };
};
async function editVoice(id) {
  let v; try { v = await API.req(`/api/v1/voices/${encodeURIComponent(id)}`); } catch (e) { return toast(e.message, "bad"); }
  setTimeout(() => {
    window.voiceToolsSection?.(v);
    const btn = $("#ed-avatar"), file = $("#ed-avatar-file"); if (!btn || !file) return;
    btn.onclick = () => file.click();
    file.onchange = async () => {
      const f = file.files[0]; if (!f) return; const fd = new FormData(); fd.append("file", f);
      try { await API.req(`/api/v1/voices/${encodeURIComponent(v.voice_id)}/avatar`, { method: "POST", form: fd }); toast("Avatar updated", "ok"); await reloadVoices(); editVoice(v.voice_id); }
      catch (e) { toast(e.message, "bad"); }
    };
  }, 0);
  setTimeout(async () => {
    try {
      const c = await API.req(`/api/v1/voices/${encodeURIComponent(v.voice_id)}/consent`);
      const el = $("#ed-consent"); if (!el) return;
      el.textContent = c.basis === "consent" ? `Consent: ${c.by || "given"} · ${c.via} · ${(c.time || "").slice(0, 10)}${c.clip_note ? " · " + c.clip_note : ""}` : `Use rests on: ${c.basis}`;
    } catch { /* older server */ }
  }, 0);
  Drawer.open(v.name || v.voice_id, `<div class="row" style="gap:12px;margin-bottom:16px"><button class="avatar-edit" id="ed-avatar" title="Change avatar">${avatar(v, true)}<span>${icon("edit", "sm")}</span></button><input type="file" id="ed-avatar-file" accept="image/*" class="hidden"><div style="flex:1"><div style="font-weight:800;font-size:17px">${esc(v.name || v.voice_id)} ${tierBadge(v)}</div><div class="small muted">${esc(v.voice_id)} · ${esc(v.source || "")}</div><div class="small dim" id="ed-consent"></div></div>
      ${v.has_ref ? `<button class="playbtn" data-play="${esc(v.voice_id)}" title="Introduction">${icon("play")}</button><button class="playbtn" data-play="${esc(v.voice_id)}" data-orig="1" title="Original recording">${icon("mic")}</button>` : ""}</div>
    <div class="field"><label class="f">Tagline <span class="hint">(shown under the name)</span></label><input class="inp" id="ed-tagline" value="${esc(v.tagline || "")}"></div>
    <div class="grid2"><div class="field"><label class="f">Display name</label><input class="inp" id="ed-name" value="${esc(v.name || "")}"></div>
    <div class="field"><label class="f">Gender</label><select class="inp" id="ed-gender">${GENDER_OPTS(v.gender || "")}</select></div>
    <div class="field"><label class="f">Language</label><input class="inp" id="ed-lang" value="${esc(v.language || "")}"></div><div class="field"><label class="f">Accent</label><input class="inp" id="ed-accent" value="${esc(v.accent || "")}"></div></div>
    <div class="field"><label class="f">Description</label><textarea class="inp" id="ed-desc" rows="2">${esc(v.description || "")}</textarea></div>
    <div class="field"><label class="f">Tags</label><input class="inp" id="ed-tags" value="${esc((v.tags || []).join(", "))}"></div>
    <div class="field"><label class="f">Transcript of the reference clip <span class="hint">(cloning engines use it)</span></label><textarea class="inp" id="ed-tr" rows="3">${esc(v.transcript || "")}</textarea></div>
    <div class="sep"></div><label class="f">Per-style reference clips</label>
    <div class="tags" style="margin-bottom:10px">${(v.styles || []).map(s => `<span class="tag acc">${esc(s)}</span>`).join("") || '<span class="small dim">None yet: add a whispered take for horror, a bright one for excited…</span>'}</div>
    <div class="grid2"><select class="inp" id="ed-style">${S.styles.map(s => `<option>${esc(s.name)}</option>`).join("")}</select><button class="btn" id="ed-style-btn">${icon("upload", "sm")}Upload clip for style</button></div>
    <input type="file" id="ed-style-file" accept="audio/*" class="hidden">`,
    `<button class="btn danger" id="ed-del">${icon("trash", "sm")}Delete</button><div style="flex:1"></div><button class="btn ghost" onclick="Drawer.close()">Cancel</button><button class="btn primary" id="ed-save">${icon("check")}Save</button>`);
  bindPreview($("#drawer-body"));
  $("#ed-style-btn").onclick = () => $("#ed-style-file").click();
  $("#ed-style-file").onchange = async e => { const f = e.target.files[0]; if (!f) return; const fd = new FormData(); fd.append("file", f);
    try { await API.req(`/api/v1/voices/${encodeURIComponent(id)}/styles/${encodeURIComponent($("#ed-style").value)}`, { method: "POST", form: fd, timeout: 180000 }); toast("Style clip added", "ok"); reloadVoices(); editVoice(id); } catch (err) { toast(err.message, "bad"); } };
  $("#ed-save").onclick = async () => {
    busyBtn($("#ed-save"), true, "Saving…");
    try {
      await API.req(`/api/v1/voices/${encodeURIComponent(id)}`, { method: "PATCH", json: { name: $("#ed-name").value, gender: $("#ed-gender").value, language: $("#ed-lang").value,
        accent: $("#ed-accent").value, description: $("#ed-desc").value, tagline: $("#ed-tagline").value, tags: $("#ed-tags").value.split(",").map(t => t.trim()).filter(Boolean) } });
      if ($("#ed-tr").value.trim() !== (v.transcript || "").trim()) await API.req(`/api/v1/voices/${encodeURIComponent(id)}/transcript`, { method: "PUT", json: { transcript: $("#ed-tr").value.trim() } });
      toast("Saved", "ok"); Drawer.close(); reloadVoices();
    } catch (e) { toast(e.message, "bad"); busyBtn($("#ed-save"), false); }
  };
  $("#ed-del").onclick = async () => {
    if (!confirm(`Delete the voice "${id}"? Its reference clip is removed from disk and cannot be recovered.`)) return;
    try { await API.req(`/api/v1/voices/${encodeURIComponent(id)}`, { method: "DELETE" }); toast(`Deleted ${id}`, "ok"); Drawer.close(); if (S.voice === id) S.voice = "default"; reloadVoices(); } catch (e) { toast(e.message, "bad"); }
  };
}

// ------------------------------------------------------------------------------------------------ speech to text
$("#lvl").innerHTML = "<i></i>".repeat(48);
let REC = null;
$("#rec").onclick = async () => {
  if (REC) { REC.stop(); return; }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true }); const chunks = []; const rec = new MediaRecorder(stream); REC = rec;
    const ac = new AudioContext(); const an = ac.createAnalyser(); an.fftSize = 128; ac.createMediaStreamSource(stream).connect(an); const data = new Uint8Array(an.frequencyBinCount);
    const bars = $$("#lvl i"); const t0 = Date.now(); $("#lvl").classList.add("on"); $("#rec").classList.add("on"); $("#rec").innerHTML = icon("stop", "lg");
    const tick = () => { if (REC !== rec) return; an.getByteFrequencyData(data); bars.forEach((b, i) => b.style.height = `${4 + (data[i % data.length] / 255) * 30}px`);
      $("#rec-time").textContent = fmtTime((Date.now() - t0) / 1000); requestAnimationFrame(tick); };
    tick();
    rec.ondataavailable = e => chunks.push(e.data);
    rec.onstop = () => { stream.getTracks().forEach(t => t.stop()); ac.close(); REC = null; $("#lvl").classList.remove("on"); $("#rec").classList.remove("on"); $("#rec").innerHTML = icon("mic", "lg");
      bars.forEach(b => b.style.height = "4px"); transcribe(new Blob(chunks, { type: rec.mimeType }), "microphone.webm"); };
    rec.start();
  } catch (e) { toast("Microphone: " + e.message, "bad"); }
};
(function () {
  const d = $("#sdrop"), f = $("#sfile"); d.onclick = () => f.click(); f.onchange = () => f.files[0] && transcribe(f.files[0], f.files[0].name);
  d.ondragover = e => { e.preventDefault(); d.classList.add("over"); }; d.ondragleave = () => d.classList.remove("over");
  d.ondrop = e => { e.preventDefault(); d.classList.remove("over"); const x = e.dataTransfer.files[0]; if (x) transcribe(x, x.name); };
})();
async function transcribe(blob, name) {
  const fd = new FormData(); fd.append("file", blob, name); fd.append("language", $("#slang").value || "auto"); fd.append("beam_size", $("#sbeam").value);
  if ($("#skeys")?.value.trim()) fd.append("keyterms", $("#skeys").value.trim());
  if ($("#sdiar")?.checked) fd.append("diarize", "true");
  $("#stt-out").innerHTML = `<div class="skeleton" style="height:22px;width:70%"></div><div class="skeleton" style="height:22px;margin-top:10px"></div><div class="skeleton" style="height:22px;width:55%;margin-top:10px"></div>`;
  try {
    const j = await API.req("/api/v1/stt", { method: "POST", form: fd, timeout: 600000 }); const url = URL.createObjectURL(blob);
    $("#stt-out").innerHTML = `<audio id="stt-audio" controls src="${url}" style="width:100%"></audio>
      <div class="words" id="stt-words" style="font-size:17px;max-height:none">${j.words.map((w, i) => `${w.speaker && w.speaker !== j.words[i - 1]?.speaker ? `${i ? "<br>" : ""}<b class="tag acc" style="margin-right:6px">${esc(w.speaker)}</b>` : ""}<span data-s="${w.start}" data-e="${w.end}">${esc(w.roman || w.text)}</span>`).join(" ") || esc(j.text_roman || j.text)}</div>
      <div class="metrics"><div class="metric"><div class="l">Language</div><div class="v">${esc(LANGS[j.language] || j.language)}<small> ${Math.round((j.language_probability || 0) * 100)}%</small></div></div>
      <div class="metric"><div class="l">Audio</div><div class="v">${j.duration.toFixed(1)}<small>s</small></div></div><div class="metric"><div class="l">Took</div><div class="v">${j.seconds.toFixed(2)}<small>s</small></div></div>
      <div class="metric"><div class="l">Words</div><div class="v">${j.words.length}</div></div></div><p class="small dim">${esc(j.model)} on ${esc(j.device)} · click a word to jump to it</p>`;
    const a = $("#stt-audio"); const ws = $$("#stt-words span");
    ws.forEach(s => s.onclick = () => { a.currentTime = +s.dataset.s; a.play(); });
    a.ontimeupdate = () => ws.forEach(s => s.classList.toggle("hl", a.currentTime >= +s.dataset.s && a.currentTime < +s.dataset.e));
    $("#stt-copy").classList.remove("hidden"); $("#stt-copy").onclick = () => navigator.clipboard.writeText(j.text_roman || j.text).then(() => toast("Transcript copied", "ok"));
    $("#stt-out").insertAdjacentHTML("beforeend", `<div class="row" style="gap:8px"><button class="btn sm ghost" data-stsub="srt">${icon("cc", "sm")}SRT</button><button class="btn sm ghost" data-stsub="vtt">${icon("cc", "sm")}VTT</button></div>`);
    $$("[data-stsub]").forEach(b => b.onclick = () => downloadSubtitles({ id: "transcript", info: { words: j.words } }, b.dataset.stsub));
  } catch (e) { $("#stt-out").innerHTML = `<div class="empty"><svg class="i"><use href="#i-alert"/></svg><b>${esc(e.code)}</b><span class="small">${esc(e.message)}</span></div>`; }
}

// ------------------------------------------------------------------------------------------------ jobs
let JF = "";
$$("#jfilter button").forEach(b => b.onclick = () => { JF = b.dataset.s; $$("#jfilter button").forEach(x => x.classList.toggle("on", x === b)); drawJobs(); });
async function loadJobs() {
  try { (await API.req("/api/v1/jobs?limit=300")).jobs.forEach(j => S.jobs[j.id] = j); drawJobs(); } catch (e) { toast(e.message, "bad"); }
  if (S.es) return;
  const es = new EventSource(API.url("/api/v1/jobs/events")); S.es = es;
  ["queued", "running", "progress", "done", "failed", "cancelled"].forEach(t => es.addEventListener(t, e => { const ev = JSON.parse(e.data); S.jobs[ev.job.id] = ev.job; drawJobsSoon();
    if (t === "done") toast(`Finished: ${ev.job.title}`, "ok"); if (t === "failed") toast(`Failed: ${ev.job.title}`, "bad"); }));
}
const drawJobsSoon = debounce(() => drawJobs(), 80);
const STATUS_TAG = { queued: "", running: "info", done: "ok", failed: "bad", cancelled: "warn" };
function drawJobs() {
  const list = Object.values(S.jobs).filter(j => !JF || (JF === "active" ? ["queued", "running"].includes(j.status) : j.status === JF)).sort((a, b) => b.created - a.created);
  if (!$("#page-jobs").classList.contains("on")) return;
  $("#jt").innerHTML = list.map(j => {
    const res = j.status === "done" ? (j.result.audio ? `<audio controls preload="none" src="${API.url(`/api/v1/jobs/${j.id}/audio`)}" style="width:100%;height:36px"></audio>`
      : j.result.voice ? `voice <b>${esc(j.result.voice.voice_id)}</b> ready` : "done") : j.error ? `<span class="small" style="color:var(--bad)">${esc(j.error.code)}: ${esc(j.error.message.slice(0, 160))}</span>` : `<span class="small muted">${esc(j.message || "")}</span>`;
    const actions = ["queued", "running"].includes(j.status) ? `<button class="btn sm danger" data-cancel="${j.id}">Cancel</button>`
      : `${j.result?.audio ? `<a class="btn sm icon ghost" title="Download" href="${API.url(`/api/v1/jobs/${j.id}/audio?download=true`)}">${icon("download", "sm")}</a>` : ""}<button class="btn sm icon ghost" title="Delete" data-del="${j.id}">${icon("trash", "sm")}</button>`;
    return `<tr><td><div style="font-weight:700">${esc(j.title)}</div><div class="small dim">${esc(j.kind)} · ${fmtAgo(j.created)}${j.elapsed ? ` · took ${j.elapsed}s` : ""}</div></td>
      <td><span class="tag ${STATUS_TAG[j.status]}">${esc(j.status)}</span></td>
      <td><div class="progress ${j.status === "done" ? "ok" : j.status === "failed" ? "bad" : ""}"><i style="width:${Math.round((j.progress || 0) * 100)}%"></i></div><div class="small dim" style="margin-top:4px">${j.step}/${j.steps || "?"}</div></td>
      <td>${res}</td><td style="text-align:right;white-space:nowrap">${actions}</td></tr>`;
  }).join("") || `<tr><td colspan="5"><div class="empty"><svg class="i"><use href="#i-layers"/></svg><b>No jobs here</b><span class="small">On the Speak page switch the mode to Background job to queue long scripts.</span></div></td></tr>`;
  $$("#jt [data-cancel]").forEach(b => b.onclick = () => API.req(`/api/v1/jobs/${b.dataset.cancel}/cancel`, { method: "POST" }).then(j => { S.jobs[j.id] = j; drawJobs(); }).catch(e => toast(e.message, "bad")));
  $$("#jt [data-del]").forEach(b => b.onclick = () => API.req(`/api/v1/jobs/${b.dataset.del}`, { method: "DELETE" }).then(() => { delete S.jobs[b.dataset.del]; drawJobs(); }).catch(e => toast(e.message, "bad")));
}

// ------------------------------------------------------------------------------------------------ styles
function renderStyles() {
  $("#scards").innerHTML = S.styles.map(s => `<div class="scard" data-s="${esc(s.name)}"><div class="t">${esc(s.title || s.name)} ${s.builtin ? "" : '<span class="tag acc">yours</span>'}</div>
    <div class="d">${esc(s.description)}</div>${s.instruct ? `<div class="ins">"${esc(s.instruct)}"</div>` : ""}
    <div class="tags"><span class="tag">pace ${s.pace}</span><span class="tag">pause ${s.pause}</span><span class="tag">temp ${s.temperature}</span><span class="tag">cfg ${s.cfg}</span></div></div>`).join("");
  $$("#scards .scard").forEach(c => c.onclick = () => editStyle(c.dataset.s));
}
const STYLE_FIELDS = [["title", "Title", "text"], ["description", "Description", "text"], ["instruct", "Delivery instruction", "area"], ["pace", "Pace", "num"], ["pause", "Pause scale", "num"],
  ["temperature", "Temperature", "num"], ["top_p", "Top-p", "num"], ["cfg", "Guidance (cfg)", "num"], ["exaggeration", "Exaggeration (Chatterbox)", "num"], ["desc", "Designed-voice description add-on", "text"], ["sample", "Showcase paragraph", "area"]];
function editStyle(name) {
  const s = name ? S.styles.find(x => x.name === name) : null; const isNew = !s;
  Drawer.open(isNew ? "New style" : `Style: ${s.title || s.name}`, `<div class="field"><label class="f">Name <span class="hint">(letters, digits, - and _)</span></label><input class="inp" id="sx-name" value="${esc(s?.name || "")}" ${isNew ? "" : "readonly"}></div>
    ${STYLE_FIELDS.map(([k, l, t]) => `<div class="field"><label class="f">${l}</label>${t === "area" ? `<textarea class="inp" rows="3" data-f="${k}">${esc(s?.[k] ?? "")}</textarea>` : `<input class="inp" data-f="${k}" ${t === "num" ? 'type="number" step="0.05"' : ""} value="${esc(s?.[k] ?? "")}">`}</div>`).join("")}
    ${s?.builtin ? `<p class="small dim">Saving a built-in style stores your own version that overrides it.</p>` : ""}`,
    `${s && !s.builtin ? `<button class="btn danger" id="sx-del">${icon("trash", "sm")}Delete</button>` : ""}<div style="flex:1"></div>${s ? `<button class="btn" id="sx-use">${icon("wave", "sm")}Use on Speak</button>` : ""}<button class="btn primary" id="sx-save">${icon("check")}Save</button>`);
  $("#sx-use")?.addEventListener("click", () => { S.style = s.name; renderStyleGrid(); saveForm(); Drawer.close(); location.hash = "#speak"; });
  $("#sx-del")?.addEventListener("click", async () => { if (!confirm(`Delete your style "${s.name}"?`)) return;
    try { await API.req(`/api/v1/styles/${encodeURIComponent(s.name)}`, { method: "DELETE" }); toast("Style deleted", "ok"); Drawer.close(); reloadStyles(); } catch (e) { toast(e.message, "bad"); } });
  $("#sx-save").onclick = async () => {
    const n = $("#sx-name").value.trim().toLowerCase(); if (!n) return toast("Give the style a name", "bad");
    const body = {}; $$("#drawer-body [data-f]").forEach(el => { const v = el.value.trim(); if (v !== "") body[el.dataset.f] = el.type === "number" ? +v : v; });
    try { await API.req(`/api/v1/styles/${encodeURIComponent(n)}`, { method: "PUT", json: body }); toast("Style saved", "ok"); Drawer.close(); reloadStyles(); } catch (e) { toast(e.message, "bad"); }
  };
}
$("#new-style").onclick = () => editStyle(null);
async function reloadStyles() { S.styles = (await API.req("/api/v1/styles")).styles; $("#n-styles").textContent = S.styles.length; renderStyles(); renderStyleGrid(); }

// ------------------------------------------------------------------------------------------------ engines
async function refreshEngines() { try { S.engines = (await API.req("/api/v1/engines")).engines; renderEngineSelect(); } catch { /* offline banner handles it */ } }
async function loadEngines() {
  try {
    const [es, all, s] = await Promise.all([API.req("/api/v1/engines"), API.req("/api/v1/engines?task=all"), API.req("/api/v1/system")]); S.engines = es.engines; renderEngineSelect();
    const TASK = { tts: "", sfx: "sound", vc: "voice changer", tool: "audio tool" };
    const g = s.gpu || {};
    $("#sys-metrics").innerHTML = [["GPU", g.name ? g.name.replace("NVIDIA GeForce ", "") : "none"], ["VRAM used", g.vram_total_gb ? `${(g.vram_used_gb ?? 0).toFixed(1)}<small> / ${g.vram_total_gb.toFixed(1)} GB</small>` : "-"],
      ["GPU load", g.utilization != null ? `${g.utilization}<small>%</small>` : "-"], ["Temperature", g.temperature_c != null ? `${g.temperature_c}<small>°C</small>` : "-"],
      ["Loaded", s.loaded_engines.join(", ") || "none"], ["Voices", s.voices], ["Styles", s.styles], ["Uptime", fmtTime(s.uptime_seconds)], ["Version", s.version]]
      .map(([l, v]) => `<div class="metric"><div class="l">${l}</div><div class="v">${v}</div></div>`).join("");
    $("#ecards").innerHTML = all.engines.map(e => `<div class="ecard ${e.loaded ? "loaded" : ""}"><div class="row"><div style="flex:1"><div class="t">${esc(e.title)}</div><div class="n">${esc(e.name)}${TASK[e.task] ? ` · ${TASK[e.task]}` : ""}</div></div>
        ${e.loaded ? '<span class="tag ok">loaded</span>' : e.ready ? '<span class="tag">ready</span>' : '<span class="tag bad">not installed</span>'}</div>
      <div class="tags">${["clone", "design", "instruct", "tags"].filter(k => e[k]).map(k => `<span class="tag acc">${k}</span>`).join("")}<span class="tag">${esc(e.license)}</span>${e.commercial ? "" : '<span class="tag warn">non-commercial</span>'}</div>
      <div class="notes">${esc(e.notes || e.description || "")}${e.problems?.length ? `<div style="color:var(--bad)">${esc(e.problems.join("; "))}</div>` : ""}</div>
      <div class="stats"><span>RTF <b>${e.speed_rtf ?? "-"}</b></span><span><b>${e.sample_rate / 1000}</b> kHz</span><span>~<b>${e.vram_gb}</b> GB</span><span><b>${e.languages.includes("*") ? "600+" : e.languages.length}</b> lang</span>${e.loaded ? `<span><b>${e.workers}</b> worker(s)</span>` : ""}</div>
      <div class="install" id="inst-${e.name}"></div>
      <div class="row">${e.ready ? (e.loaded ? `<button class="btn sm" data-unload="${e.name}">Unload</button>` : `<button class="btn sm primary" data-load="${e.name}">${icon("zap", "sm")}Load now</button>`) : ""}
        ${!e.ready && e.installable ? `<button class="btn sm primary" data-install="${e.name}">${icon("download", "sm")}Install</button>` : ""}
        ${!e.ready && !e.installable ? `<button class="btn sm ghost" data-howto="${e.name}">How to install</button>` : ""}
        <button class="btn sm ghost" data-use-engine="${e.name}" ${e.ready ? "" : "disabled"}>Use on Speak</button>
        ${e.ready && e.installable && !e.loaded ? `<button class="btn sm ghost" data-uninstall="${e.name}" title="Delete this engine's venv">Remove</button>` : ""}</div></div>`).join("");
    $$("#ecards [data-install]").forEach(b => b.onclick = () => installEngine(b.dataset.install, b));
    $$("#ecards [data-howto]").forEach(b => b.onclick = async () => { try { const p = await API.req(`/api/v1/engines/${b.dataset.howto}/install?sizes=false`); $(`#inst-${b.dataset.howto}`).innerHTML = `<div class="notes">${esc(p.manual || "Not installable from here.")}</div>`; } catch (e) { toast(e.message, "bad"); } });
    $$("#ecards [data-uninstall]").forEach(b => b.onclick = async () => {
      const keep = !confirm(`Remove ${b.dataset.uninstall}'s Python environment?\n\nOK also deletes its downloaded weights; Cancel keeps the weights.`);
      if (!confirm(`Remove ${b.dataset.uninstall} now?`)) return;
      try { const r = await API.req(`/api/v1/engines/${b.dataset.uninstall}/install?weights=${!keep}`, { method: "DELETE" }); toast(`Removed ${r.removed.length} folder(s)${r.also_affects.length ? "; also used by " + r.also_affects.join(", ") : ""}`, "ok"); } catch (e) { toast(e.message, "bad"); }
      loadEngines(); });
    Object.entries(S.installing || {}).forEach(([name, j]) => drawInstall(name, j));
    loadPaths();
    $$("#ecards [data-load]").forEach(b => b.onclick = async () => { busyBtn(b, true, "Loading…"); try { await API.req(`/api/v1/engines/${b.dataset.load}/load`, { method: "POST", json: {}, timeout: 0 }); toast(`${b.dataset.load} loaded`, "ok"); } catch (e) { toast(e.message, "bad"); } loadEngines(); poll(); });
    $$("#ecards [data-unload]").forEach(b => b.onclick = async () => { busyBtn(b, true, "Unloading…"); try { await API.req(`/api/v1/engines/${b.dataset.unload}/unload`, { method: "POST", timeout: 60000 }); toast(`${b.dataset.unload} unloaded`, "ok"); } catch (e) { toast(e.message, "bad"); } loadEngines(); poll(); });
    $$("#ecards [data-use-engine]").forEach(b => b.onclick = () => { S.engine = b.dataset.useEngine; renderEngineSelect(); renderKnobs(); saveForm(); location.hash = "#speak"; });
  } catch (e) { toast(e.message, "bad"); }
}

async function installEngine(name, btn) {
  try {
    const plan = await API.req(`/api/v1/engines/${name}/install`);
    const todo = plan.steps.filter(s => !s.done).map(s => "• " + s.what).join("\n");
    const code = plan.repo_code ? `

This engine runs code from its own repository (pinned to a fixed version). Install only engines you trust.` : "";
    if (!confirm(`Install ${name}?\n\n${todo}\n\nAbout ${plan.estimated_gb ?? "?"} GB to download (less when another engine already fetched the same torch).${code}`)) return;
    busyBtn(btn, true, "Starting…");
    const j = await API.req(`/api/v1/engines/${name}/install`, { method: "POST" });
    S.installing = { ...(S.installing || {}), [name]: j }; drawInstall(name, j);
    const tick = async () => {
      let v; try { v = await API.req(`/api/v1/jobs/${j.id}`); } catch { return setTimeout(tick, 3000); }
      S.installing[name] = v; drawInstall(name, v);
      if (["queued", "running"].includes(v.status)) return setTimeout(tick, 1500);
      delete S.installing[name];
      v.status === "done" ? toast(`${name} installed`, "ok") : toast(`${name}: ${v.error?.message || v.status}`, "bad");
      refreshEngines(); loadEngines();
    };
    setTimeout(tick, 1000);
  } catch (e) { toast(e.message, "bad"); busyBtn(btn, false); }
}
function drawInstall(name, j) {
  const el = $(`#inst-${name}`); if (!el) return;
  const live = ["queued", "running"].includes(j.status);
  el.innerHTML = `<div class="notes">${esc(j.message || j.status)}</div><div class="progress ${j.status === "failed" ? "bad" : j.status === "done" ? "ok" : ""}"><i style="width:${Math.round(100 * (j.progress || 0))}%"></i></div>
    <div class="row" style="gap:6px">${live ? `<button class="btn sm ghost" data-icancel="${j.id}">Cancel</button>` : ""}<a class="btn sm ghost" href="${API.url(`/api/v1/jobs/${j.id}/files/install.log`)}" target="_blank">Log</a></div>`;
  el.querySelector("[data-icancel]")?.addEventListener("click", () => API.req(`/api/v1/jobs/${j.id}/cancel`, { method: "POST" }).catch(e => toast(e.message, "bad")));
}
async function loadPaths() {
  try {
    const p = await API.req("/api/v1/system/paths");
    const row = (k, label, hint) => `<div class="field"><label class="f">${label} <span class="hint">(${esc(p[k].source)}${p[k].exists ? "" : ", missing"})</span></label>
      <input class="inp" data-path="${k}" value="${esc(p.settings[k] || "")}" placeholder="${esc(p[k].path || hint)}"></div>`;
    $("#paths-card").innerHTML = `<div class="field"><label class="f">Data folder <span class="hint">(FIREVOICE_HOME; voices, renders, projects)</span></label><input class="inp" value="${esc(p.home.path)}" disabled></div>
      ${row("engines_dir", "Engine folder", "venvs")}${row("weights_dir", "Model weights", "weights")}${row("ffmpeg", "ffmpeg", "ffmpeg.exe")}
      <label class="toggle" style="margin:4px 0 12px"><input type="checkbox" id="wm-policy" ${p.watermark?.policy !== "off" ? "checked" : ""} ${p.watermark?.available ? "" : "disabled"}><span class="sw"></span>
        Mark every output as AI speech (inaudible watermark)${p.watermark?.available ? "" : " · needs the audioseal package"}</label>
      <div class="row"><button class="btn sm primary" id="paths-save">Save</button><span class="hint">Leave a field empty for the default shown in grey.</span></div>`;
    $("#paths-save").onclick = async () => {
      const body = {}; $$("[data-path]").forEach(i => { if (i.value.trim() !== (p.settings[i.dataset.path] || "")) body[i.dataset.path] = i.value.trim(); });
      const wm = $("#wm-policy").checked ? "all" : "off"; if (wm !== (p.watermark?.policy || "all")) body.watermark = wm;
      if (!Object.keys(body).length) return toast("Nothing changed", "");
      try { const r = await API.req("/api/v1/system/settings", { method: "PUT", json: body }); toast(r.restart_required ? "Saved. Restart the server to use the new engine folders." : "Saved", "ok"); loadPaths(); } catch (e) { toast(e.message, "bad"); }
    };
  } catch (e) { $("#paths-card").textContent = e.message; }
}

// ------------------------------------------------------------------------------------------------ settings + shortcuts
$("#open-settings").onclick = () => {
  Drawer.open("Settings", `<div class="field"><label class="f">API token <span class="hint">(only when the server was started with --token)</span></label><input class="inp mono" id="set-token" type="password" value="${esc(API.token())}"></div>
    <div class="sep"></div><label class="f">Keyboard shortcuts</label>
    <div class="small muted" style="line-height:2"><span class="kbd">Ctrl ↵</span> render / stream / queue · <span class="kbd">Esc</span> stop or close · <span class="kbd">/</span> search voices · <span class="kbd">1</span>-<span class="kbd">6</span> switch pages</div>
    <div class="sep"></div><label class="f">Local data</label><p class="small muted">The studio remembers your script and settings in this browser. Renders in "This session" are kept in memory only.</p>
    <button class="btn danger" id="set-reset">${icon("reset", "sm")}Reset saved settings</button>
    <div class="sep"></div><p class="small dim">FireVoice ${esc(S.sys?.version || "")} · API docs at <a href="/docs" target="_blank">/docs</a> · font: Urbanist (SIL OFL)</p>`,
    `<button class="btn primary" id="set-save">${icon("check")}Save</button>`);
  $("#set-save").onclick = () => { store.set("token", $("#set-token").value.trim()); Drawer.close(); S.opt = null; S.es?.close(); S.es = null; poll(); toast("Settings saved", "ok"); };
  $("#set-reset").onclick = () => { if (!confirm("Forget the saved script and settings?")) return; ["form", "voice", "style", "engine", "params", "pace", "mode", "voiceMode"].forEach(k => { try { localStorage.removeItem("fv." + k); } catch { /* ignore */ } }); location.reload(); };
};
document.addEventListener("keydown", e => {
  const typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName);
  if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); if (!location.hash || location.hash === "#speak") go(); return; }
  if (e.key === "Escape") { if ($("#drawer").classList.contains("on")) Drawer.close(); else if (S.busy) S.abort?.abort("user"); return; }
  if (typing) return;
  if (e.key === "/") { e.preventDefault(); if (location.hash === "#voices") $("#vq").focus(); else { location.hash = "#speak"; $("#vsearch").focus(); } }
  if (/^[1-6]$/.test(e.key)) location.hash = "#" + PAGES[+e.key - 1];
});
window.Drawer = Drawer;

// ------------------------------------------------------------------------------------------------ boot
route();
poll();
