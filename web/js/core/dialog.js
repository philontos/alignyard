// Promise-based confirmation dialog backed by the #dialog modal in index.html.
// The module wires the OK/Cancel buttons and backdrop handling once at load time.
import { $ } from "./dom.js";

let dlgResolve = null;
function openDialog({ title = "", message = "", okText, danger = false, checkbox = null }) {
  okText = okText || t("dialog.ok");
  return new Promise((resolve) => {
    dlgResolve = resolve;
    $("dlg-title").textContent = title;
    $("dlg-title").style.display = title ? "" : "none";
    $("dlg-msg").textContent = message;
    const ok = $("dlg-ok");
    ok.textContent = okText;
    ok.className = danger ? "danger" : "";
    const check = $("dlg-check");
    if (checkbox) {
      $("dlg-check-input").checked = checkbox.checked !== false;
      $("dlg-check-label").textContent = checkbox.label || "";
      check.style.display = "flex";
    } else {
      check.style.display = "none";
    }
    $("dialog").style.display = "flex";
  });
}
export function closeDialog(result) {
  $("dialog").style.display = "none";
  const r = dlgResolve; dlgResolve = null;
  if (r) r(result);
}
export function confirmDialog(message, opts = {}) { return openDialog({ message, ...opts }).then(Boolean); }
export async function confirmDialogWithCheckbox(message, opts = {}) {
  const result = await openDialog({ message, ...opts });
  return {
    confirmed: Boolean(result),
    checked: Boolean(result && opts.checkbox && $("dlg-check-input").checked),
  };
}
$("dlg-ok").onclick = () => closeDialog(true);
$("dlg-cancel").onclick = () => closeDialog(null);
$("dialog").addEventListener("click", (e) => { if (e.target.id === "dialog") closeDialog(null); });
