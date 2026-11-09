/* FireVoice Studio: the Projects page (long-form: chapters of paragraphs, each with its own takes). Loaded after app.js
   and uses its helpers ($, API, esc, icon, toast, Drawer, busyBtn, mountTakes, S). */
"use strict";

const PJ = { list: [], cur: null, saving: null, dirty: false, job: null, open: new Set(), audio: null };
const STATUS_LABEL = { draft: "draft", stale: "changed", rendered: "ready", locked: "locked", working: "rendering" };

// ------------------------------------------------------------------------------------------------ list
window.loadProjects = async function loadProjects() {
  if (PJ.cur) { renderEditor(); return; }
  try { PJ.list = (await API.req("/api/v1/projects")).projects; } catch (e) { toast(e.message, "bad"); return; }
  $("#n-projects").textContent = PJ.list.length || "";
  $("#pj-list-view").classList.remove("hidden"); $("#pj-editor").classList.add("hidden");
  const bar = c => { const n = Object.values(c).reduce((a, b) => a + b, 0) || 1;
    return `<div class="pj-bar">${["rendered", "locked", "stale", "draft"].map(k => `<i class="${k}" style="width:${(100 * c[k]) / n}%"></i>`).join("")}</div>`; };
  $("#pj-grid").innerHTML = PJ.list.length ? PJ.list.map(p => `<div class="pj-card" data-id="${esc(p.id)}">
      <h3>${esc(p.title)}</h3><div class="small dim">${p.chapters} chapter${p.chapters === 1 ? "" : "s"} · ${p.paragraphs} paragraphs · ${p.words} words</div>
      ${bar(p.counts)}
      <div class="meta"><span class="tag ok">${p.counts.rendered + p.counts.locked} ready</span>${p.counts.stale ? `<span class="tag warn">${p.counts.stale} changed</span>` : ""}
        ${p.counts.draft ? `<span class="tag">${p.counts.draft} draft</span>` : ""}<span class="tag">${fmtTime(p.duration)}</span><span class="dim">edited ${fmtAgo(p.updated)}</span></div></div>`).join("")
    : `<div class="empty" style="grid-column:1/-1">${icon("book")}<b>No projects yet</b><span class="small">Paste a whole script: heading lines start chapters, blank lines split paragraphs.</span></div>`;
  $$("#pj-grid .pj-card").forEach(c => c.onclick = () => openProject(c.dataset.id));
};

const SAMPLE_BOOK = `# Chapter One
The keeper climbed the stairs every evening at dusk, one hundred and twelve of them, counting each step out loud.

At the top, he trimmed the wick, wiped the great lens, and waited for the first ship of the night.

# Chapter Two
The fog came in early that October. By midnight the lamp was the only thing left in the world.

Far out on the water, a bell answered.`;

$("#pj-new").onclick = () => {
  const opt = (sel, items) => items.map(([v, l]) => `<option value="${esc(v)}" ${v === sel ? "selected" : ""}>${esc(l)}</option>`).join("");
  Drawer.open("New project", `
    <div class="field"><label class="f">Title</label><input class="inp" id="np-title" placeholder="The Lighthouse Keeper" value="The Lighthouse Keeper"></div>
    <div class="field"><label class="f">Script <span class="hint">(optional: "# Title" or "Chapter 1" lines start chapters, blank lines split paragraphs)</span></label>
      <textarea class="inp" id="np-text" rows="12" placeholder="# Chapter One&#10;The keeper climbed the stairs every evening at dusk.">${esc(SAMPLE_BOOK)}</textarea></div>
    <div class="grid2"><div class="field"><label class="f">Voice</label><select class="inp" id="np-voice">${opt(S.voice, [["default", "Default voice"], ...S.voices.map(v => [v.voice_id, `${v.name || v.voice_id}${v.tagline ? " · " + v.tagline : ""}`])])}</select></div>
      <div class="field"><label class="f">Style</label><select class="inp" id="np-style">${opt(S.style === "conversational" ? "audiobook" : S.style, S.styles.map(s => [s.name, s.title || s.name]))}</select></div></div>`,
    `<button class="btn ghost" onclick="Drawer.close()">Cancel</button><button class="btn primary" id="np-go">${icon("plus")}Create</button>`);
  $("#np-go").onclick = async () => {
    const btn = $("#np-go"); busyBtn(btn, true);
    try {
      const p = await API.req("/api/v1/projects", { method: "POST", json: { title: $("#np-title").value.trim() || "Untitled project", text: $("#np-text").value,
        defaults: { voice: $("#np-voice").value, style: $("#np-style").value, engine: S.engine } } });
      Drawer.close(); openProject(p.id, p);
    } catch (e) { toast(e.message, "bad"); busyBtn(btn, false); }
  };
};
$("#pj-import").onclick = () => $("#pj-file").click();
$("#pj-file").onchange = async () => {
  const f = $("#pj-file").files[0]; if (!f) return;
  const fd = new FormData(); fd.append("file", f);
  try { const p = await API.req("/api/v1/projects/import", { method: "POST", form: fd, timeout: 0 }); toast(`Imported ${p.title}`, "ok"); openProject(p.id, p); }
  catch (e) { toast(e.message, "bad"); } finally { $("#pj-file").value = ""; }
};

// ------------------------------------------------------------------------------------------------ editor
async function openProject(id, data) {
  try { PJ.cur = data || await API.req(`/api/v1/projects/${id}`); } catch (e) { toast(e.message, "bad"); return; }
  PJ.open.clear(); renderEditor();
}
function closeProject() { flushSave(); PJ.cur = null; PJ.job = null; window.loadProjects(); }

function voiceOptions(sel, inherit) {
  return `<option value="">${esc(inherit)}</option>` + S.voices.map(v => `<option value="${esc(v.voice_id)}" ${v.voice_id === sel ? "selected" : ""}>${esc(v.name || v.voice_id)}</option>`).join("");
}
function styleOptions(sel, inherit) {
  return `<option value="">${esc(inherit)}</option>` + S.styles.map(s => `<option value="${esc(s.name)}" ${s.name === sel ? "selected" : ""}>${esc(s.title || s.name)}</option>`).join("");
}

function renderEditor() {
  const p = PJ.cur; if (!p) return;
  $("#pj-list-view").classList.add("hidden"); const box = $("#pj-editor"); box.classList.remove("hidden");
  const d = p.defaults || {}; const c = p.counts;
  const todo = c.draft + c.stale;
  box.innerHTML = `
    <div class="pj-head"><button class="btn sm ghost" id="pj-back">${icon("chev", "sm")}All projects</button>
      <input class="title" id="pj-title" value="${esc(p.title)}" aria-label="Project title">
      <span class="tag ok">${c.rendered + c.locked} ready</span>${c.stale ? `<span class="tag warn">${c.stale} changed</span>` : ""}${c.draft ? `<span class="tag">${c.draft} draft</span>` : ""}
      <span class="tag">${p.words} words · ${fmtTime(p.duration)}</span><span class="small dim" id="pj-saved">saved</span></div>
    <div class="row" style="margin-bottom:14px;gap:8px">
      <button class="btn primary" id="pj-render" ${todo ? "" : "disabled"}>${icon("play")}${todo ? `Render ${todo} changed paragraph${todo === 1 ? "" : "s"}` : "Everything is rendered"}</button>
      <span id="pj-job" class="small dim"></span><div class="grow"></div>
      <select class="inp" id="pj-fmt" style="width:auto"><option value="m4b">M4B audiobook (chapters)</option><option value="mp3">MP3</option><option value="wav">WAV</option><option value="srt">Subtitles (SRT)</option><option value="vtt">Subtitles (VTT)</option></select>
      <label class="toggle" title="Bring the export inside audiobook limits (loudness, peaks)"><input type="checkbox" id="pj-master"><span class="sw"></span>Audiobook master</label>
      <button class="btn" id="pj-export">${icon("download")}Export</button>
      <button class="btn" id="pj-check">${icon("check")}Check</button>
      <button class="btn ghost" id="pj-bundle" title="The project with every take, as one zip">${icon("download")}Bundle</button>
      <button class="btn ghost icon" id="pj-delete" title="Delete project">${icon("trash")}</button>
    </div>
    <details class="card adv-card" style="margin-bottom:14px"><summary class="card-h"><h3>Defaults</h3><span class="small dim">voice ${esc(vName(d.voice || "default"))} · style ${esc(d.style || "conversational")} · used by every paragraph without its own</span></summary>
      <div class="card-b pj-defaults">
        <div class="field"><label class="f">Voice</label><select class="inp" data-def="voice">${voiceOptions(d.voice, "Default voice")}</select></div>
        <div class="field"><label class="f">Style</label><select class="inp" data-def="style">${styleOptions(d.style, "conversational")}</select></div>
        <div class="field"><label class="f">Pause between paragraphs (ms)</label><input class="inp" type="number" min="0" max="30000" data-def="paragraph_gap_ms" value="${d.paragraph_gap_ms ?? 700}"></div>
        <div class="field"><label class="f">Pause between chapters (ms)</label><input class="inp" type="number" min="0" max="30000" data-def="chapter_gap_ms" value="${d.chapter_gap_ms ?? 2500}"></div>
      </div></details>
    <div id="pj-checkout"></div>
    <div id="pj-chapters">${p.chapters.map(chapterHTML).join("")}</div>
    <button class="btn" id="pj-add-ch">${icon("plus")}Add chapter</button>`;
  bindEditor();
}

function chapterHTML(ch, ci) {
  return `<div class="card pj-chapter" data-ch="${esc(ch.id)}">
    <div class="ch-h"><span class="small dim">${ci + 1}</span><input class="ch-title" value="${esc(ch.title)}" aria-label="Chapter title">
      <span class="small dim">${ch.paragraphs.length} paragraph${ch.paragraphs.length === 1 ? "" : "s"} · ${fmtTime(ch.duration)}</span>
      <button class="btn sm ghost" data-ch-play title="Play the chapter">${icon("play", "sm")}</button>
      <button class="btn sm ghost icon" data-ch-del title="Delete chapter">${icon("trash", "sm")}</button></div>
    <div class="ch-b">${ch.paragraphs.map(paraHTML).join("")}</div>
    <div style="padding:10px 14px"><button class="btn sm ghost" data-add-para>${icon("plus", "sm")}Add paragraph</button></div></div>`;
}
function paraHTML(para) {
  const st = para.status;
  const open = PJ.open.has(para.id) && para.render;
  return `<div class="pj-para" data-p="${esc(para.id)}">
    <div><div class="pj-st ${st}">${STATUS_LABEL[st]}</div>${para.render ? `<div class="small dim" style="text-align:center;margin-top:4px">${fmtTime(para.render.duration)}</div>` : ""}</div>
    <div><textarea rows="2" aria-label="Paragraph text">${esc(para.text)}</textarea>
      <div class="opts"><select data-f="voice" title="Voice for this paragraph">${voiceOptions(para.voice, "project voice")}</select>
        <select data-f="style" title="Style for this paragraph">${styleOptions(para.style, "project style")}</select></div></div>
    <div class="acts">
      <button class="btn sm icon ghost" data-act="play" title="Play" ${para.render ? "" : "disabled"}>${icon("play", "sm")}</button>
      <button class="btn sm icon ghost" data-act="render" title="${st === "draft" ? "Render" : "Render again"}">${icon(st === "draft" ? "zap" : "reset", "sm")}</button>
      <button class="btn sm icon ghost" data-act="takes" title="Takes and speech check" ${para.render ? "" : "disabled"}>${icon("layers", "sm")}</button>
      <button class="btn sm icon ghost" data-act="lock" title="${para.locked ? "Unlock" : "Lock: skip when rendering what changed"}">${icon(para.locked ? "lock" : "unlock", "sm")}</button>
      <button class="btn sm icon ghost" data-act="del" title="Delete paragraph">${icon("trash", "sm")}</button></div>
    ${open ? `<div class="takes" data-takes></div>` : ""}</div>`;
}

// ------------------------------------------------------------------------------------------------ editing and saving
function readStructure() {
  return $$("#pj-chapters .pj-chapter").map(chEl => {
    const ch = PJ.cur.chapters.find(c => c.id === chEl.dataset.ch) || {};
    return { id: chEl.dataset.ch, title: $(".ch-title", chEl).value, paragraphs: $$(".pj-para", chEl).map(pEl => {
      const old = ch.paragraphs?.find(x => x.id === pEl.dataset.p) || {};
      return { id: pEl.dataset.p, text: $("textarea", pEl).value, voice: $("[data-f=voice]", pEl).value || null, style: $("[data-f=style]", pEl).value || null,
               pace: old.pace ?? null, locked: !!old.locked };
    }) };
  });
}
async function save(extra = {}) {
  if (!PJ.cur) return;
  $("#pj-saved") && ($("#pj-saved").textContent = "saving…");
  try {
    const p = await API.req(`/api/v1/projects/${PJ.cur.id}`, { method: "PATCH", json: { title: $("#pj-title")?.value, chapters: readStructure(), ...extra } });
    PJ.cur = p; PJ.dirty = false; refreshStatuses();
    $("#pj-saved") && ($("#pj-saved").textContent = "saved");
  } catch (e) { toast(e.message, "bad"); $("#pj-saved") && ($("#pj-saved").textContent = "not saved"); }
}
const saveSoon = debounce(save, 800);
function flushSave() { if (PJ.dirty) save(); }
// update statuses and counts in place, so typing is never interrupted by a re-render
function refreshStatuses() {
  const p = PJ.cur;
  for (const ch of p.chapters) for (const para of ch.paragraphs) {
    const el = $(`.pj-para[data-p="${para.id}"] .pj-st`); if (!el) continue;
    el.className = "pj-st " + para.status; el.textContent = STATUS_LABEL[para.status];
  }
  const todo = p.counts.draft + p.counts.stale; const b = $("#pj-render");
  if (b && !PJ.job) { b.disabled = !todo; b.innerHTML = `${icon("play")}${todo ? `Render ${todo} changed paragraph${todo === 1 ? "" : "s"}` : "Everything is rendered"}`; }
}

function bindEditor() {
  const box = $("#pj-editor"); const id = PJ.cur.id;
  $("#pj-back").onclick = closeProject;
  const edited = () => { PJ.dirty = true; saveSoon(); };
  box.addEventListener("input", e => { if (e.target.matches("textarea, .ch-title, #pj-title")) edited(); });
  $$("[data-f]", box).forEach(sel => sel.onchange = edited);
  $$("[data-def]", box).forEach(el => el.onchange = () => {
    const defaults = { ...PJ.cur.defaults }; $$("[data-def]", box).forEach(x => { const v = x.value; defaults[x.dataset.def] = x.type === "number" ? +v : v || undefined; });
    save({ defaults }).then(renderEditor);
  });
  $("#pj-add-ch").onclick = async () => { await save({ chapters: [...readStructure(), { title: `Chapter ${PJ.cur.chapters.length + 1}`, paragraphs: [{ text: "" }] }] }); renderEditor(); };
  $$("[data-add-para]", box).forEach(b => b.onclick = async () => {
    const s = readStructure(); const ch = s.find(x => x.id === b.closest(".pj-chapter").dataset.ch); ch.paragraphs.push({ text: "" });
    await save({ chapters: s }); renderEditor(); $$(`.pj-chapter[data-ch="${ch.id}"] textarea`).pop()?.focus();
  });
  $$("[data-ch-del]", box).forEach(b => b.onclick = async () => {
    const chId = b.closest(".pj-chapter").dataset.ch; const ch = PJ.cur.chapters.find(c => c.id === chId);
    if (!confirm(`Delete "${ch.title}" and its ${ch.paragraphs.length} paragraph(s), with their takes?`)) return;
    await save({ chapters: readStructure().filter(x => x.id !== chId) }); renderEditor();
  });
  $$("[data-ch-play]", box).forEach(b => b.onclick = () => playUrl(`/api/v1/projects/${id}/export?format=mp3&chapter=${b.closest(".pj-chapter").dataset.ch}&allow_missing=true`, b));
  $$(".pj-para", box).forEach(el => {
    const pid = el.dataset.p;
    $("[data-act=play]", el).onclick = e => playUrl(`/api/v1/projects/${id}/paragraphs/${pid}/audio?format=mp3`, e.currentTarget);
    $("[data-act=render]", el).onclick = async e => {
      const btn = e.currentTarget; if (PJ.dirty) await save();
      busyBtn(btn, true); $(".pj-st", el).className = "pj-st working"; $(".pj-st", el).textContent = STATUS_LABEL.working;
      try { PJ.cur = await API.req(`/api/v1/projects/${id}/paragraphs/${pid}/render`, { method: "POST", timeout: 0 }); renderEditor(); }
      catch (err) { toast(err.message, "bad"); busyBtn(btn, false); refreshStatuses(); }
    };
    $("[data-act=takes]", el).onclick = () => { PJ.open.has(pid) ? PJ.open.delete(pid) : PJ.open.add(pid); renderEditor(); };
    $("[data-act=lock]", el).onclick = async () => {
      const para = PJ.cur.chapters.flatMap(c => c.paragraphs).find(x => x.id === pid);
      try { PJ.cur = await API.req(`/api/v1/projects/${id}/paragraphs/${pid}/lock`, { method: "POST", json: { locked: !para.locked } }); renderEditor(); }
      catch (err) { toast(err.message, "bad"); }
    };
    $("[data-act=del]", el).onclick = async () => {
      const s = readStructure(); s.forEach(ch => ch.paragraphs = ch.paragraphs.filter(x => x.id !== pid));
      await save({ chapters: s }); renderEditor();
    };
    const tk = $("[data-takes]", el);
    if (tk) { const para = PJ.cur.chapters.flatMap(c => c.paragraphs).find(x => x.id === pid); mountTakes(tk, para.render.id, null); }
  });
  $("#pj-render").onclick = renderChanged;
  $("#pj-export").onclick = async e => {
    const fmt = $("#pj-fmt").value; const master = $("#pj-master").checked ? "&master=audiobook" : "";
    const btn = e.currentTarget; busyBtn(btn, true);
    try {
      const r = await API.req(`/api/v1/projects/${id}/export?format=${fmt}${master}`, { raw: true, timeout: 0 });
      const name = (r.headers.get("content-disposition") || "").match(/filename="([^"]+)"/)?.[1] || `${PJ.cur.title}.${fmt}`;
      const a = document.createElement("a"); a.href = URL.createObjectURL(await r.blob()); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    } catch (err) { toast(err.message, "bad"); } finally { busyBtn(btn, false); }
  };
  $("#pj-check").onclick = async e => {
    const btn = e.currentTarget; busyBtn(btn, true);
    try {
      const r = await API.req(`/api/v1/projects/${id}/check${$("#pj-master").checked ? "?master=audiobook" : ""}`, { timeout: 0 });
      $("#pj-checkout").innerHTML = `<div class="card" style="margin-bottom:14px"><div class="card-h"><h3>Audiobook check</h3><span class="tag ${r.pass ? "ok" : "warn"}">${r.pass ? "every chapter passes" : "some checks fail"}</span>
        <div class="grow"></div><span class="small dim">${r.master ? "with the audiobook master" : "as rendered; tick Audiobook master to fix loudness and peaks on export"}</span></div>
        <table class="table pj-check"><thead><tr><th>Chapter</th>${(r.chapters.find(c => c.checks.length)?.checks || []).map(x => `<th>${esc(x.name)}<div class="small dim">${esc(x.target)}</div></th>`).join("")}</tr></thead>
        <tbody>${r.chapters.map(c => `<tr><td>${esc(c.title)}</td>${c.checks.length ? c.checks.map(x => `<td><span class="tag ${x.ok ? "ok" : "bad"}">${x.value} ${esc(x.unit)}</span></td>`).join("") : `<td colspan="5" class="dim">${esc(c.note || "")}</td>`}</tr>`).join("")}</tbody></table></div>`;
    } catch (err) { toast(err.message, "bad"); } finally { busyBtn(btn, false); }
  };
  $("#pj-bundle").onclick = () => { const a = document.createElement("a"); a.href = API.url(`/api/v1/projects/${id}/bundle`); a.download = ""; a.click(); };
  $("#pj-delete").onclick = async () => {
    if (!confirm(`Delete "${PJ.cur.title}" and every take in it? This cannot be undone.`)) return;
    try { await API.req(`/api/v1/projects/${id}`, { method: "DELETE" }); PJ.cur = null; window.loadProjects(); } catch (err) { toast(err.message, "bad"); }
  };
}

function playUrl(path, btn) {
  if (PJ.audio) { PJ.audio.pause(); const was = PJ.audio._btn; PJ.audio = null; was?.classList.remove("on"); if (was === btn) return; }
  $("#player")?.pause();
  const a = new Audio(API.url(path)); a._btn = btn; PJ.audio = a; btn?.classList.add("on");
  a.onended = () => { btn?.classList.remove("on"); PJ.audio = null; };
  a.play().catch(e => toast(e.message, "bad"));
}

async function renderChanged() {
  const id = PJ.cur.id; if (PJ.dirty) await save();
  let job; try { job = await API.req(`/api/v1/projects/${id}/render`, { method: "POST", json: { scope: "stale" } }); } catch (e) { toast(e.message, "bad"); return; }
  PJ.job = job.id; const btn = $("#pj-render"); busyBtn(btn, true, "Rendering");
  // follow the job; refresh statuses as paragraphs finish
  for (;;) {
    await new Promise(r => setTimeout(r, 1500));
    if (!PJ.cur || PJ.cur.id !== id || PJ.job !== job.id) return;
    let j; try { j = await API.req(`/api/v1/jobs/${job.id}`); } catch { continue; }
    const el = $("#pj-job"); if (el) el.textContent = j.message ? `${j.message}` : "";
    try { PJ.cur = await API.req(`/api/v1/projects/${id}`); refreshStatuses(); } catch { /* keep going */ }
    if (["done", "failed", "cancelled"].includes(j.status)) {
      PJ.job = null; renderEditor();
      const failed = j.result?.failed?.length || 0;
      toast(j.status === "done" ? `Rendered ${j.result?.rendered ?? 0} paragraph(s)${failed ? `, ${failed} failed` : ""}` : `Render ${j.status}`, j.status === "done" && !failed ? "ok" : "bad");
      return;
    }
  }
}
