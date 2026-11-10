// How the backend's Python environment is built: one recipe for the installed app's runtime (bundle-backend.mjs puts it
// in backend.json, and src-tauri/src/backend.rs follows it on first run) and for the dev environment in backend/.venv
// (dev-setup.mjs), so development runs on exactly what users get.
export const RECIPE = {
  python: "3.12",
  extras: ["desktop"],
  torch: "2.11.0",
  torch_index: "https://download.pytorch.org/whl/cu128",
  // chatterbox-tts pins torch 2.6, which has no RTX 50-series kernels; the backend is tested on these instead
  overrides: ["torch==2.11.0", "torchaudio==2.11.0"],
};

/** Extras the dev environment adds on top (tests). */
export const DEV_EXTRAS = ["dev"];
