/* FireVoice Studio: the Dubbing page (a recording or video into another language). Uses app.js helpers. */
"use strict";

const DB = { file: null, langs: null, job: null, speakers: [] };
const LANG_NAMES = { en: "English", de: "German", es: "Spanish", fr: "French", it: "Italian", pt: "Portuguese", nl: "Dutch", pl: "Polish",
  ru: "Russian", uk: "Ukrainian", tr: "Turkish", ar: "Arabic", fa: "Persian", hi: "Hindi", ur: "Urdu", bn: "Bengali", pa: "Punjabi",
  ta: "Tamil", te: "Telugu", ja: "Japanese", ko: "Korean", zh: "Chinese", id: "Indonesian", ms: "Malay", vi: "Vietnamese", th: "Thai",
  sv: "Swedish", no: "Norwegian", da: "Danish", fi: "Finnish", el: "Greek", he: "Hebrew", cs: "Czech", ro: "Romanian", hu: "Hungarian" };

window.loadDub = async function loadDub() {
  if (!DB.langs) {
    try { DB.langs = (await API.req("/api/v1/dub/languages")).languages; } catch (e) { toast(e.message, "bad"); return; }
    const named = DB.langs.filter(c => LANG_NAMES[c]).sort((a, b) => LANG_NAMES[a].localeCompare(LANG_NAMES[b]));
    const rest = DB.langs.filter(c => !LANG_NAMES[c]);
    const opts = [...named.map(c => `<option value="${c}">${LANG_NAMES[c]} (${c})</option>`), ...rest.map(c => `<option value="${c}">${c}</option>`)].join("");
    $("#db-to").innerHTML = opts; $("#db-to").value = store.get("dubTo", "es");
    $("#db-from").innerHTML = `<option value="auto">Detect</option>` + opts;
  }
  $("#db-voice").innerHTML = `<option value="">Default voice</option>` + S.voices.map(v => `<option value="${esc(v.voice_id)}">${esc(v.name || v.voice_id)}</option>`).join("");
};

bindDrop("db-file");
$("#db-to")?.addEventListener("change", e => store.set("dubTo", e.target.value));
$("#db-bg").oninput = e => { $("#db-bg-v").textContent = `${Math.round(e.target.value * 100)}%`; };
$("#db-keep").onchange = e => { $("#db-consent-row").classList.toggle("hidden", !e.target.checked); $("#db-voice").disabled = e.target.checked; };

$("#db-go").onclick = async () => {
  DB.file = $("#db-file").files[0] || null;
  if (!DB.file) return toast("Choose a recording or video first", "bad");
  const keep = $("#db-keep").checked;
  if (keep && !$("#db-consent").checked) return toast("Confirm you have the rights to clone the voices in this recording", "bad");
  const fd = new FormData();
  fd.append("file", DB.file, DB.file.name); fd.append("target_language", $("#db-to").value); fd.append("source_language", $("#db-from").value);
  fd.append("voice", keep ? "" : $("#db-voice").value); fd.append("keep_voices", keep ? "true" : "false"); fd.append("consent", keep ? "true" : "false");
  fd.append("background", $("#db-bg").value); fd.append("format", "mp3"); fd.append("translator", $("#db-tr").value);
  const btn = $("#db-go"); busyBtn(btn, true, "Uploading…");
  try {
    const j = await API.req("/api/v1/dub", { method: "POST", form: fd, timeout: 0 });
    DB.job = j.id; follow(j.id);
  } catch (e) { toast(e.message, "bad"); busyBtn(btn, false); }
};

async function follow(id) {
  const btn = $("#db-go");
  let j; try { j = await API.req(`/api/v1/jobs/${id}`); } catch { return setTimeout(() => follow(id), 3000); }
  const live = ["queued", "running"].includes(j.status);
  $("#db-out").innerHTML = `<div class="row" style="gap:8px"><span class="tag ${j.status === "done" ? "ok" : j.status === "failed" ? "bad" : "info"}">${esc(j.status)}</span><span class="small dim">${esc(j.message || "")}</span>
      ${live ? `<button class="btn sm ghost" id="db-cancel">Cancel</button>` : ""}</div>
    ${live ? `<div class="progress" style="margin-top:8px"><i style="width:${Math.round(100 * (j.progress || 0))}%"></i></div>` : ""}`;
  $("#db-cancel")?.addEventListener("click", () => API.req(`/api/v1/jobs/${id}/cancel`, { method: "POST" }).catch(e => toast(e.message, "bad")));
  if (live) return setTimeout(() => follow(id), 1500);
  busyBtn(btn, false);
  if (j.status === "failed") return toast(j.error?.message || "Dubbing failed", "bad");
  if (j.status !== "done") return;
  const r = j.result, f = n => API.url(`/api/v1/jobs/${id}/files/${n}`);
  const video = r.files.find(n => /\.(mp4|mov|mkv)$/.test(n));
  let lines = []; try { lines = (await API.req(`/api/v1/jobs/${id}/files/lines.json`)).lines; } catch { /* listing is optional */ }
  $("#db-out").insertAdjacentHTML("beforeend", `<div style="margin-top:12px">
      ${video ? `<video controls src="${f(video)}" style="width:100%;max-height:360px;border-radius:12px;background:#000"></video>` : `<audio controls autoplay src="${f(r.audio)}" style="width:100%"></audio>`}
      <div class="row" style="gap:8px;margin-top:8px;flex-wrap:wrap">${r.files.filter(n => n !== "lines.json").map(n => `<a class="btn sm" href="${f(n)}?download=1" download="${esc(n)}">${icon("download", "sm")}${esc(n)}</a>`).join("")}
        <span class="small dim">${esc(r.source_language)} → ${esc(r.target_language)} · ${r.lines} lines · ${r.duration}s${r.voices_kept ? " · original voices kept" : ""}</span></div>
      ${lines.length ? `<table class="table" style="margin-top:12px"><tr><th>at</th><th>original</th><th>dubbed</th><th>speed</th></tr>${lines.map(l => `<tr><td class="small dim">${fmtTime(l.at)}</td><td class="small">${esc(l.text)}</td><td>${esc(l.translation)}</td><td class="small dim">${l.speed > 1 ? l.speed + "x" : ""}</td></tr>`).join("")}</table>` : ""}</div>`);
}
