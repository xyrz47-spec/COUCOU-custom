// Settings → JEV: the TypeSafe API key that JEV (src-tauri/src/jev.rs) works
// with, and what is sent. The key goes to the credential store (never to disk);
// this page can only save it, remove it, and ask whether one is saved.

import { Bridge } from "../core/bridge";
import { h } from "../views/dom";
import { t } from "../i18n/i18n";

const KEY = "typesafe-api-key";

export function jevSection(): HTMLElement {
  const input = h("input", { type: "password", placeholder: t("TypeSafe API key"), style: "flex:1 1 220px;min-width:0", autocomplete: "off" }) as HTMLInputElement;
  const save = h("button", { class: "primary", text: t("Save") }) as HTMLButtonElement;
  const test = h("button", { text: t("Test the key") }) as HTMLButtonElement;
  const remove = h("button", { class: "danger", text: t("Remove") }) as HTMLButtonElement;
  const status = h("div", { class: "hint" });
  const note = h("div", { class: "notice err", style: "display:none" });

  const say = (text: string) => {
    note.textContent = text;
    note.style.display = text ? "" : "none";
  };

  async function refresh() {
    const has = (await Bridge.secretPresent(KEY)) ?? false;
    status.textContent = has ? t("A key is saved.") : t("No key saved: nothing is sent to TypeSafe.");
    test.disabled = !has;
    remove.disabled = !has;
  }

  save.addEventListener("click", () => {
    const value = input.value.trim();
    if (!value) return;
    Bridge.secretSet(KEY, value)
      .then(() => {
        input.value = "";
        say("");
        return refresh();
      })
      .catch((err) => say(String(err)));
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") save.click();
  });
  remove.addEventListener("click", () => {
    Bridge.secretClear(KEY).then(() => { say(""); return refresh(); }).catch((err) => say(String(err)));
  });
  test.addEventListener("click", () => {
    test.disabled = true;
    status.textContent = t("Asking JEV…");
    Bridge.jevCheckKey()
      .then(() => { say(""); return refresh().then(() => { status.textContent = t("The key works."); }); })
      .catch((err) => { say(String(err).replace(/^Error:\s*/, "")); return refresh(); })
      .finally(() => { test.disabled = false; });
  });

  void refresh();
  return h(
    "section",
    {},
    h("h2", {}, h("span", { text: t("JEV") })),
    h("div", {
      class: "hint",
      text: t("JEV is TypeSafe's model for quick, structured judgements. With a key, the Check tab reads a message you paste: how it sounds, how urgent it is, whether it needs a reply, whether it could sound rude. It reads; it does not write."),
    }),
    h("div", { class: "row" }, input, save),
    h("div", { class: "row" }, test, remove),
    status,
    note,
    h("div", {
      class: "hint",
      text: t("What is sent to api.typesafe.ai: the message you pasted, cut to 3,000 characters, only when you press Check, and nothing is kept once you leave the tab. The key is kept in the system credential store."),
    }),
  );
}
