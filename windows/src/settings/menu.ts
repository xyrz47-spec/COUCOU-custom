// Settings → Menu: which chat provider answers the Menu tab (views/menu.ts,
// src-tauri/src/menu.rs). Empty is the chat's own; a JEV server goes in as the
// Custom server, whose address and model are set in Settings → Chat.

import { PROVIDERS } from "../core/providers";
import type { Settings } from "../core/state";
import { h } from "../views/dom";
import { t } from "../i18n/i18n";

export function menuSection(current: () => Settings, save: () => Promise<void>): HTMLElement {
  const pick = h("select", { class: "sk-where" }) as HTMLSelectElement;
  pick.append(h("option", { value: "", text: t("Same as the chat") }));
  for (const def of PROVIDERS) pick.append(h("option", { value: def.id, text: def.name }));
  pick.value = current().menuProvider ?? "";
  pick.addEventListener("change", () => {
    current().menuProvider = pick.value;
    void save();
  });
  return h(
    "section",
    {},
    h("h2", {}, h("span", { text: t("Menu") })),
    h("div", {
      class: "hint",
      text: t("The Menu tab sends the sentence you type, and the dishes already shown, to this provider. A JEV server goes in as the Custom server (its address and model are in Settings → Chat)."),
    }),
    h("div", { class: "row" }, h("span", { text: t("Answered by") }), pick),
  );
}
