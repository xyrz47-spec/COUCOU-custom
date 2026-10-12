// JEV's line on a permission card (src-tauri/src/jev.rs): the words for the
// risk it reports. Advice only; the card's two buttons stay the way to decide.

import type { JevRisk } from "./bridge";
import { N_, t } from "../i18n/i18n";

const LEVELS: Record<JevRisk["level"], string> = {
  low: N_("JEV: looks routine"),
  medium: N_("JEV: worth reading before you allow"),
  high: N_("JEV: could change or send things you may not want"),
  unsure: N_("JEV is not sure about this one"),
};

const SCOPES: Record<string, string> = {
  read_only: N_("only reads"),
  edit_files: N_("edits project files"),
  run_code: N_("runs code"),
  network: N_("uses the network"),
  system: N_("touches the system"),
};

/** The one line for a risk: how it looks, then what the action mainly does. */
export function riskLine(risk: JevRisk): string {
  const level = LEVELS[risk.level] ?? LEVELS.unsure;
  const scope = SCOPES[risk.scope];
  return scope ? `${t(level)} · ${t(scope)}` : t(level);
}
