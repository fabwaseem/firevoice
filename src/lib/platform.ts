/** Which system the app is running on, from the webview (macOS gets native window buttons and Cmd shortcuts). */
const ua = typeof navigator === "undefined" ? "" : `${navigator.platform ?? ""} ${navigator.userAgent}`;

export const isMac = /Mac/i.test(ua) && !/iPhone|iPad/i.test(ua);
export const isWindows = /Win/i.test(ua);

/** The modifier people press for shortcuts: ⌘ on a Mac, Ctrl elsewhere. */
export const modKey = isMac ? "⌘" : "Ctrl";
