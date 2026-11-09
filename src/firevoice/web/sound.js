/* FireVoice Studio: the Sound page (sound effects, ambience and music beds). Uses app.js helpers. */
"use strict";

const SN = { kind: "sfx", engines: [] };
const SN_IDEAS = {
  sfx: ["a wooden door creaks open slowly, footsteps on a stone floor", "rain on a tin roof, distant thunder", "a busy cafe, cups clinking, soft chatter", "a crowd cheers in a stadium"],
  music: ["calm lo-fi piano bed for a podcast intro, warm and slow", "upbeat acoustic guitar, bright, for a product video", "tense cinematic strings, low and slow", "soft ambient pads for meditation"],
};

window.loadSound = async function loadSound() {
  try { SN.engines = (await API.req("/api/v1/engines?task=sfx")).engines; } catch (e) { toast(e.message, "bad"); }
  drawKind();
};

function drawKind() {
  $$("#sn-kind button").forEach(b => b.classList.toggle("on", b.dataset.k === SN.kind));
  $("#sn-prompt").placeholder = SN_IDEAS[SN.kind][0];
  $("#sn-ideas").innerHTML = SN_IDEAS[SN.kind].map(t => `<button class="pill" data-idea="${esc(t)}">${esc(t)}</button>`).join("");
  $$("#sn-ideas [data-idea]").forEach(b => b.onclick = () => { $("#sn-prompt").value = b.dataset.idea; });
  const e = SN.engines.find(x => x.name === (SN.kind === "music" ? "musicgen" : "audioldm2"));
  $("#sn-engine").innerHTML = e ? (e.ready ? `${esc(e.title)} · ${esc(e.license)}` : `${esc(e.title)} is not installed: <a href="#engines">install it on Engines</a>`) : "";
  $("#sn-go").disabled = !(e && e.ready);
}

$$("#sn-kind button").forEach(b => b.onclick = () => { SN.kind = b.dataset.k; $("#sn-len").value = SN.kind === "music" ? 8 : 5; $("#sn-len-v").textContent = `${$("#sn-len").value} s`; drawKind(); });
$("#sn-len").oninput = e => { $("#sn-len-v").textContent = `${e.target.value} s`; };

$("#sn-go").onclick = async () => {
  const prompt = $("#sn-prompt").value.trim(); if (!prompt) return toast("Describe the sound first", "bad");
  const btn = $("#sn-go"); busyBtn(btn, true, "Making it…");
  const body = { prompt, kind: SN.kind, duration: +$("#sn-len").value, format: "mp3" };
  if ($("#sn-seed").value.trim()) body.seed = +$("#sn-seed").value.trim();
  try {
    const r = await API.req("/api/v1/sound", { method: "POST", json: body, timeout: 0, raw: true });
    const url = URL.createObjectURL(await r.blob()), seed = r.headers.get("X-Seed");
    $("#sn-list").insertAdjacentHTML("afterbegin", `<div class="card" style="padding:12px 14px;margin-bottom:8px"><div class="row" style="gap:12px;flex-wrap:wrap">
      <div style="flex:1;min-width:200px"><div>${esc(prompt)}</div><div class="small dim">${SN.kind === "music" ? "music" : "effect"} · ${r.headers.get("X-Duration")}s · seed ${esc(seed)}</div></div>
      <audio controls src="${url}" style="height:36px"></audio><a class="btn sm icon ghost" title="Download" download="${esc(prompt.slice(0, 40).replace(/[^a-z0-9]+/gi, "-"))}.mp3" href="${url}">${icon("download", "sm")}</a>
      <button class="btn sm icon ghost" title="Again with this seed" data-seed="${esc(seed)}">${icon("dice", "sm")}</button></div></div>`);
    $("#sn-list [data-seed]").onclick = e => { $("#sn-seed").value = e.currentTarget.dataset.seed; $("#sn-prompt").value = prompt; };
  } catch (e) { toast(e.message, "bad"); } finally { busyBtn(btn, false); }
};
