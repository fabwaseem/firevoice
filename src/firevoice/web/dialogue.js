/* FireVoice Studio: the Dialogue page (multi-speaker scripts). Uses app.js helpers. */
"use strict";

const DG = { cast: {}, speakers: [], audio: null };
const DG_EXAMPLE = `Ayesha: Assalam o Alaikum, and welcome back to the show!
Bilal: Thanks for having me. (laughs) I promise to keep it short this time.
Ayesha: You said that last week too.
Bilal: Fair. But this time I mean it.
Narrator: He did not keep it short.`;

window.loadDialogue = function loadDialogue() {
  if (!$("#dg-script").value.trim()) $("#dg-script").value = store.get("dialogue", "") || DG_EXAMPLE;   // a ready example on first visit
  if (!DG.speakers.length && $("#dg-script").value.trim()) detect();
};
$("#dg-script")?.addEventListener("input", debounce(() => store.set("dialogue", $("#dg-script").value), 400));
$("#dg-example").onclick = () => { $("#dg-script").value = DG_EXAMPLE; store.set("dialogue", DG_EXAMPLE); detect(); };
$("#dg-gap").oninput = e => { $("#dg-gap-v").textContent = `${e.target.value} ms`; };
$("#dg-detect").onclick = () => detect();

async function detect() {
  const script = $("#dg-script").value.trim(); if (!script) return toast("Write a script first", "bad");
  let r; try { r = await API.req("/api/v1/dialogue/parse", { method: "POST", json: { script, cast: DG.cast } }); } catch (e) { toast(e.message, "bad"); return; }
  DG.speakers = r.speakers; DG.cast = r.cast;
  $("#dg-info").textContent = `${r.turns.length} turns · ${r.speakers.length} speaker${r.speakers.length === 1 ? "" : "s"}`;
  const vopts = sel => S.voices.map(v => `<option value="${esc(v.voice_id)}" ${v.voice_id === sel ? "selected" : ""}>${esc(v.name || v.voice_id)}</option>`).join("");
  const sopts = sel => `<option value="">default style</option>` + S.styles.map(s => `<option value="${esc(s.name)}" ${s.name === sel ? "selected" : ""}>${esc(s.title || s.name)}</option>`).join("");
  $("#dg-cast").innerHTML = r.speakers.map(n => { const c = r.cast[n] || {}; const v = S.voices.find(x => x.voice_id === c.voice);
    return `<div class="row dg-row" data-s="${esc(n)}" style="gap:8px;margin-bottom:8px">${v ? avatar(v) : ""}<b style="min-width:90px">${esc(n)}</b>
      <select class="inp" data-f="voice" style="flex:1">${vopts(c.voice)}</select><select class="inp" data-f="style" style="width:auto">${sopts(c.style)}</select>
      <button class="playbtn" data-prev="${esc(c.voice || "")}" title="Hear this voice">${icon("play")}</button></div>`; }).join("");
  $$("#dg-cast .dg-row").forEach(row => {
    const n = row.dataset.s;
    $$("select", row).forEach(sel => sel.onchange = () => { DG.cast[n] = { ...DG.cast[n], [sel.dataset.f]: sel.value || undefined };
      if (sel.dataset.f === "voice") { $("[data-prev]", row).dataset.prev = sel.value; const v = S.voices.find(x => x.voice_id === sel.value); const av = $(".avatar", row); if (av && v) av.outerHTML = avatar(v); } });
    $("[data-prev]", row).onclick = e => { DG.audio?.pause(); DG.audio = new Audio(API.url(`/api/v1/voices/${encodeURIComponent(e.currentTarget.dataset.prev)}/preview`)); DG.audio.play(); };
  });
  $("#dg-go").disabled = false;
}

$("#dg-go").onclick = async () => {
  const script = $("#dg-script").value.trim(); if (!script) return;
  const btn = $("#dg-go"); busyBtn(btn, true, "Rendering every turn…");
  const body = { script, cast: DG.cast, gap_ms: +$("#dg-gap").value, defaults: { engine: S.engine }, format: "mp3", response: "json" };
  try {
    const j = await API.req("/api/v1/dialogue", { method: "POST", json: body, timeout: 0 });
    const url = URL.createObjectURL(new Blob([b64ToBytes(j.audio_base64)], { type: "audio/mpeg" }));
    $("#dg-out").innerHTML = `<audio id="dg-player" controls autoplay src="${url}" style="width:100%"></audio>
      <div class="dg-turns">${j.turns.map(t => `<div class="dg-turn" data-t="${t.start}"><span class="tag">${esc(t.speaker)}</span> ${esc(t.text)}<span class="small dim"> ${fmtTime(t.start)}</span></div>`).join("")}</div>
      <div class="row" style="margin-top:10px;gap:8px"><a class="btn sm" href="${url}" download="dialogue.mp3">${icon("download", "sm")}Mix (MP3)</a>
        <button class="btn sm ghost" id="dg-zip">${icon("download", "sm")}Mix, stems and subtitles (zip)</button></div>`;
    const pl = $("#dg-player");
    $$(".dg-turn").forEach(el => el.onclick = () => { pl.currentTime = +el.dataset.t; pl.play(); });
    pl.ontimeupdate = () => $$(".dg-turn").forEach((el, i, all) => el.classList.toggle("on", pl.currentTime >= +el.dataset.t && (i === all.length - 1 || pl.currentTime < +all[i + 1].dataset.t)));
    $("#dg-zip").onclick = async e => {
      busyBtn(e.currentTarget, true);
      try { const r = await API.req("/api/v1/dialogue", { method: "POST", json: { ...body, response: "zip", format: "wav" }, timeout: 0, raw: true });
        const a = document.createElement("a"); a.href = URL.createObjectURL(await r.blob()); a.download = "dialogue.zip"; a.click(); }
      catch (err) { toast(err.message, "bad"); } finally { busyBtn(e.currentTarget, false); }
    };
  } catch (e) { toast(e.message, "bad"); } finally { busyBtn(btn, false); }
};
