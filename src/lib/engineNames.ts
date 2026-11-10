/** Engine id -> FireVoice name ("voxcpm2" -> "Inferno"), learned from every engines / system / options response, so
 * toasts and other code outside React can show names too. Unknown ids come back unchanged. */
let names: Record<string, string> = {};

export function rememberEngineNames(map?: Record<string, string> | null) {
  if (map) names = { ...names, ...map };
}

export function engineName(id?: string | null): string {
  return id ? (names[id] ?? id) : "";
}
