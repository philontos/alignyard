import test from "node:test";
import assert from "node:assert/strict";

const ids = [
  "dialog",
  "dlg-title",
  "dlg-msg",
  "dlg-check",
  "dlg-check-input",
  "dlg-check-label",
  "dlg-ok",
  "dlg-cancel",
];
const elements = Object.fromEntries(ids.map((id) => [
  id,
  {
    id,
    style: {},
    addEventListener(type, handler) { this[`on${type}`] = handler; },
  },
]));

globalThis.document = { getElementById: (id) => elements[id] };
globalThis.t = (key) => key;

const { confirmDialog, confirmDialogWithCheckbox } = await import("./dialog.js");

test("checkbox confirmation defaults checked and reports a manual uncheck", async () => {
  const pending = confirmDialogWithCheckbox("Stop?", {
    checkbox: { label: "Also remove the worktree", checked: true },
  });

  assert.equal(elements["dlg-check"].style.display, "flex");
  assert.equal(elements["dlg-check-input"].checked, true);
  assert.equal(elements["dlg-check-label"].textContent, "Also remove the worktree");

  elements["dlg-check-input"].checked = false;
  elements["dlg-ok"].onclick();
  assert.deepEqual(await pending, { confirmed: true, checked: false });
});

test("checkbox confirmation reports the default checked choice", async () => {
  const pending = confirmDialogWithCheckbox("Stop?", {
    checkbox: { label: "Also remove the worktree", checked: true },
  });
  elements["dlg-ok"].onclick();
  assert.deepEqual(await pending, { confirmed: true, checked: true });
});

test("ordinary confirmations hide the optional checkbox", async () => {
  const pending = confirmDialog("Delete?");
  assert.equal(elements["dlg-check"].style.display, "none");
  elements["dlg-ok"].onclick();
  assert.equal(await pending, true);
});
