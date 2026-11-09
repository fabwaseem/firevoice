/* FireVoice Studio: voice tools (voice changer page, clip cleaning, per-style clips, design candidates). Loaded after
   app.js and uses its helpers ($, API, esc, icon, toast, Drawer, busyBtn, S, reloadVoices, editVoice). */
"use strict";

// ------------------------------------------------------------------------------------------------ voice changer
const VC = { blob: null, name: "", rec: null };
window.loadChanger = function loadChanger() {
  const sel = $("#vc-voice"); const keep = sel.value || S.voice;
  sel.innerHTML = `<option value="default">Default voice</option>` + S.voices.filter(v => v.kind !== "designed" || v.has_ref !== false)
    .map(v => `<option value="${esc(v.voice_id)}">${esc(v.name || v.voice_id)}${v.tagline ? " · " + esc(v.tagline) : ""}</option>`).join("");
  sel.value = keep;
};
function setSource(blob, name) {
  VC.blob = blob; VC.name = name;
  const a = $("#vc-src"); a.src = URL.createObjectURL(blob); a.classList.remove("hidden");
  $("#vc-file-name").textContent = `${name} · ${(blob.size / 1024).toFixed(0)} KB`;
  const fd = new FormData(); fd.append("file", blob, name);
  API.req("/api/v1/audio/analyze", { method: "POST", form: fd, timeout: 60000 }).then(r => {
    $("#vc-check").innerHTML = `Recording: <b>${esc(r.verdict)}</b> · ${r.duration}s · SNR ${r.snr_db ?? "?"} dB${r.notes?.length ? " · " + esc(r.notes.join("; ")) : ""}`;
  }).catch(() => { $("#vc-check").textContent = ""; });
}
(() => {
  const d = $("#vc-file-drop"), f = $("#vc-file"); if (!d) return;
  d.onclick = () => f.click();
  f.onchange = () => { const x = f.files[0]; if (x) setSource(x, x.name); };
  d.ondragover = e => { e.preventDefault(); d.classList.add("over"); }; d.ondragleave = () => d.classList.remove("over");
  d.ondrop = e => { e.preventDefault(); d.classList.remove("over"); const x = e.dataTransfer.files[0]; if (x) setSource(x, x.name); };
  $("#vc-rec").onclick = async () => {
    if (VC.rec) { VC.rec.stop(); return; }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true }); const chunks = [];
      const rec = new MediaRecorder(stream); VC.rec = rec;
      rec.ondataavailable = e => chunks.push(e.data);
      rec.onstop = () => { stream.getTracks().forEach(t => t.stop()); VC.rec = null; $("#vc-rec").innerHTML = `${icon("mic")}Record`; $("#vc-rec-state").textContent = "";
        setSource(new Blob(chunks, { type: rec.mimeType }), "recording.webm"); };
      rec.start(); $("#vc-rec").innerHTML = `${icon("stop")}Stop`; $("#vc-rec-state").textContent = "recording…";
    } catch (e) { toast(`Microphone: ${e.message}`, "bad"); }
  };
  $("#vc-go").onclick = async () => {
    if (!VC.blob) return toast("Record or choose a recording first", "bad");
    const btn = $("#vc-go"); busyBtn(btn, true, "Changing the voice…");
    const fd = new FormData(); fd.append("file", VC.blob, VC.name); fd.append("voice", $("#vc-voice").value); fd.append("format", "mp3");
    try {
      const r = await API.req("/api/v1/voice-changer", { method: "POST", form: fd, timeout: 0, raw: true });
      const url = URL.createObjectURL(await r.blob()); const vn = $("#vc-voice").selectedOptions[0]?.textContent.split(" · ")[0] || "voice";
      $("#vc-out").innerHTML = `<audio controls autoplay src="${url}" style="width:100%"></audio>
        <div class="row" style="margin-top:8px"><a class="btn sm" href="${url}" download="${esc(vn)}-voice-changer.mp3">${icon("download", "sm")}Download</a><span class="small dim">${r.headers.get("X-Duration") || ""}s in ${esc(vn)}</span></div>`;
    } catch (e) { toast(e.message, "bad"); } finally { busyBtn(btn, false); }
  };
})();

// ------------------------------------------------------------------------------------------------ watermark check
(function initWatermarkCheck() {
  const go = $("#wm-go"); if (!go) return;
  go.onclick = async () => {
    const f = $("#wm-file").files[0]; if (!f) return toast("Choose a file first", "bad");
    busyBtn(go, true, "Listening…");
    const fd = new FormData(); fd.append("file", f, f.name);
    try {
      const r = await API.req("/api/v1/audio/detect", { method: "POST", form: fd, timeout: 0 });
      const tag = r.firevoice ? `<span class="tag ok">made by FireVoice${r.kind ? " · " + esc(r.kind) : ""}</span>`
        : r.watermarked ? `<span class="tag warn">AI watermark, not FireVoice's</span>` : `<span class="tag">no watermark found</span>`;
      $("#wm-out").innerHTML = `${tag} <span class="small dim">${Math.round(r.probability * 100)}% of ${r.seconds}s carries a mark</span>`;
    } catch (e) { toast(e.message, "bad"); } finally { busyBtn(go, false); }
  };
})();

// ------------------------------------------------------------------------------------------------ voice editor: clip and style clips
window.voiceToolsSection = function voiceToolsSection(v) {
  const body = $("#drawer-body"); if (!body || !v.has_ref) return;
  const built = v.styles || [];
  const options = S.styles.filter(s => s.instruct && !built.includes(s.name)).map(s => `<option value="${esc(s.name)}">${esc(s.title || s.name)}</option>`).join("");
  const q = v.quality_check?.after || v.quality_check?.before;
  body.insertAdjacentHTML("beforeend", `<div class="vt-sec">
    <div class="f" style="margin-bottom:6px">Reference clip ${q ? `<span class="tag ${q.verdict === "good" ? "ok" : q.verdict === "poor" ? "bad" : "warn"}">${esc(q.verdict)} · SNR ${q.snr_db} dB</span>` : ""}</div>
    <div class="row" style="gap:6px"><select class="inp" id="vt-strength" style="width:auto"><option value="light">Light</option><option value="medium" selected>Medium</option><option value="strong">Strong</option></select>
      <button class="btn sm" id="vt-clean">${icon("sparkle", "sm")}Clean the clip</button><button class="btn sm ghost" id="vt-restore" title="Put the original recording back">${icon("reset", "sm")}Restore original</button></div>
    <div class="f" style="margin:14px 0 6px">Style clips <span class="hint">(the voice's own take for a style: renders in that style keep both the voice and the delivery)</span></div>
    <div class="chips" id="vt-styles">${built.length ? built.map(s => `<span class="chip on">${esc(s)} <button class="x" data-del="${esc(s)}" title="Remove">${icon("x", "sm")}</button></span>`).join("") : '<span class="small dim">none yet</span>'}</div>
    ${options ? `<div class="row" style="gap:6px;margin-top:8px"><select class="inp" id="vt-style" style="width:auto">${options}</select><button class="btn sm" id="vt-build">${icon("plus", "sm")}Build clip</button></div>` : ""}
  </div>`);
  const id = encodeURIComponent(v.voice_id);
  const reopen = async () => { await reloadVoices(); editVoice(v.voice_id); };
  $("#vt-clean").onclick = async e => {
    busyBtn(e.currentTarget, true, "Cleaning…");
    try { const r = await API.req(`/api/v1/voices/${id}/clean`, { method: "POST", json: { strength: $("#vt-strength").value }, timeout: 120000 });
      toast(`Cleaned: SNR ${r.quality_check.before.snr_db} → ${r.quality_check.after.snr_db} dB`, "ok"); reopen(); }
    catch (err) { toast(err.message, "bad"); busyBtn(e.currentTarget, false); }
  };
  $("#vt-restore").onclick = async () => { try { await API.req(`/api/v1/voices/${id}/restore-original`, { method: "POST" }); toast("Original clip restored", "ok"); reopen(); } catch (err) { toast(err.message, "bad"); } };
  $$("#vt-styles [data-del]").forEach(b => b.onclick = async () => {
    try { await API.req(`/api/v1/voices/${id}/styles/${encodeURIComponent(b.dataset.del)}`, { method: "DELETE" }); reopen(); } catch (err) { toast(err.message, "bad"); }
  });
  $("#vt-build") && ($("#vt-build").onclick = async e => {
    busyBtn(e.currentTarget, true, "Rendering…");
    try { await API.req(`/api/v1/voices/${id}/styles/${encodeURIComponent($("#vt-style").value)}/build`, { method: "POST", json: {}, timeout: 0 }); toast("Style clip built", "ok"); reopen(); }
    catch (err) { toast(err.message, "bad"); busyBtn(e.currentTarget, false); }
  });
};

// ------------------------------------------------------------------------------------------------ design: try several versions first
window.bindDesignCandidates = function bindDesignCandidates() {
  const btn = $("#dz-try"); if (!btn) return;
  btn.onclick = async () => {
    const description = $("#dz-desc").value.trim(); if (!description) return toast("Describe the voice first", "bad");
    busyBtn(btn, true, "Rendering 3 versions…");
    try {
      const body = { description, n: 3, engine: $("#dz-engine").value }; if ($("#dz-text").value.trim()) body.text = $("#dz-text").value.trim();
      const b = await API.req("/api/v1/voices/design/candidates", { method: "POST", json: body, timeout: 0 });
      $("#dz-cands")?.remove();
      $("#drawer-body").insertAdjacentHTML("beforeend", `<div id="dz-cands" class="vt-sec"><div class="f" style="margin-bottom:6px">Pick the one you like</div>
        ${b.candidates.map(c => `<div class="row dz-cand" style="gap:8px;margin-bottom:6px"><button class="playbtn" data-n="${c.n}">${icon("play")}</button>
          <span>Version ${c.n}</span><span class="small dim">${c.duration}s</span><div class="grow"></div><button class="btn sm primary" data-keep="${c.n}">${icon("check", "sm")}Keep this one</button></div>`).join("")}</div>`);
      let au = null;
      $$("#dz-cands [data-n]").forEach(p => p.onclick = () => { au?.pause(); au = new Audio(API.url(`/api/v1/voices/design/candidates/${b.batch}/${p.dataset.n}/audio`)); au.play(); });
      $$("#dz-cands [data-keep]").forEach(k => k.onclick = async () => {
        const name = $("#dz-name").value.trim(); if (!name) return toast("Give the voice a name first", "bad");
        busyBtn(k, true);
        try { const v = await API.req(`/api/v1/voices/design/candidates/${b.batch}/${k.dataset.keep}/keep`, { method: "POST", json: { name, gender: $("#dz-gender").value } });
          toast(`Kept ${v.voice_id}`, "ok"); Drawer.close(); reloadVoices(); }
        catch (e) { toast(e.message, "bad"); busyBtn(k, false); }
      });
    } catch (e) { toast(e.message, "bad"); } finally { busyBtn(btn, false); }
  };
};
