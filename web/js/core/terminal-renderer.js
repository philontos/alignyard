// xterm 5.5 defaults to its DOM renderer. On Chrome/macOS, the DOM renderer's
// span/letter-spacing path can omit the final CJK cell even though xterm's
// Unicode buffer contains it. Prefer the official 2D canvas addon and retain
// DOM as a no-crash fallback when the vendored addon cannot load.
export function activateCanvasRenderer(term, addon = globalThis.CanvasAddon) {
  if (!term || typeof addon?.CanvasAddon !== "function") return false;
  term.loadAddon(new addon.CanvasAddon());
  return true;
}
