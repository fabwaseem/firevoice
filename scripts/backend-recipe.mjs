// How the backend's Python environment is built: one recipe for the installed app's runtime (bundle-backend.mjs puts it
// in backend.json, and src-tauri/src/backend.rs follows it on first run) and for the dev environment in backend/.venv
// (dev-setup.mjs), so development runs on exactly what users get.
export const RECIPE = {
  python: "3.12",
  extras: ["desktop"],
  torch: "2.11.0",
  // CUDA 12.8 on Windows and Linux; the CUDA index has no macOS builds, so a Mac gets the CPU index (which carries the
  // Apple Silicon wheels, with Metal support). The recipe is written into backend.json by the build on each OS.
  torch_index: process.platform === "darwin" ? "https://download.pytorch.org/whl/cpu" : "https://download.pytorch.org/whl/cu128",
  // chatterbox-tts pins torch 2.6, which has no RTX 50-series kernels; the backend is tested on these instead
  // resemblyzer asks for webrtcvad, which is published only as source (it needs a C compiler on the user's computer, which
  // most do not have): never install it; webrtcvad-wheels (same module, ready-made for every system) is in the desktop extra
  overrides: ["torch==2.11.0", "torchaudio==2.11.0", "webrtcvad ; python_version < '0'"],
};

/** Extras the dev environment adds on top (tests). */
export const DEV_EXTRAS = ["dev"];
