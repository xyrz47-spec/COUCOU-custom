// Permission requests Coucou answers by itself (Settings → Claude Code →
// "Approve without asking"), so the work goes on with nobody at the card.
// Pure: the mode, the tool and what it was called with in, yes or no out.
//
// Off unless the user turns it on. Even at its widest it never answers a
// question the agent asks the user, a plan put up for approval, or a command
// that looks as if it destroys or publishes something: those come up as a card
// like any other request.

/** `settings.autoApprove`: "" asks every time. */
export const AUTO_APPROVE_MODES = ["", "edits", "all"] as const;
export type AutoApprove = (typeof AUTO_APPROVE_MODES)[number];

export function isAutoApprove(value: unknown): value is AutoApprove {
  return typeof value === "string" && (AUTO_APPROVE_MODES as readonly string[]).includes(value);
}

/** The tools that change a file and nothing else. */
const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

/** Tools whose request is the user's own to answer, whatever the mode. */
const ALWAYS_ASKED = new Set(["AskUserQuestion", "ExitPlanMode"]);

/**
 * What a command that should still be shown looks like: it deletes for good,
 * rewrites history, wipes a disk, shuts the machine down, drops a database,
 * runs what it has just downloaded, takes more rights, or publishes. A list of
 * shapes, not a proof: it errs towards asking.
 */
const DESTRUCTIVE: RegExp[] = [
  /\brm\s+(?:\S+\s+)*?-\S*[rf]/i,
  /\b(?:rmdir|rd)\s+(?:\S+\s+)*?\/s\b/i,
  /\bdel\s+(?:\S+\s+)*?\/[sqf]\b/i,
  /\bremove-item\b.*-(?:recurse|force)\b/i,
  /\bgit\s+push\b.*(?:--force\b|--force-with-lease\b|\s-f\b|\s\+\S)/i,
  /\bgit\s+reset\s+--hard\b/i,
  /\bgit\s+clean\b/i,
  /\bgit\s+checkout\s+(?:--\s|\.)/i,
  /\bgit\s+restore\b/i,
  /\bgit\s+branch\s+-D\b/,
  /\b(?:mkfs\S*|fdisk|diskpart)\b/i,
  /\bformat\s+[a-z]:/i,
  /\bdd\s+if=/i,
  />\s*\/dev\/(?:sd|nvme|disk)/i,
  /\b(?:shutdown|reboot|halt|poweroff)\b/i,
  /\breg\s+delete\b/i,
  /\bdrop\s+(?:table|database|schema)\b/i,
  /\btruncate\s+table\b/i,
  /\|\s*(?:sudo\s+)?(?:ba|z|da)?sh\b/i,
  /\b(?:iex|invoke-expression)\b/i,
  /\bsudo\b/i,
  /\bch(?:mod|own)\s+-R\b/,
  /\b(?:npm|pnpm|yarn|cargo|gem|twine)\s+(?:\S+\s+)*?(?:publish|upload)\b/i,
  /\bgh\s+release\s+(?:create|delete)\b/i,
];

/** True when `command` has the shape of something that cannot be taken back. */
export function looksDestructive(command: string): boolean {
  return DESTRUCTIVE.some((shape) => shape.test(command));
}

/**
 * Whether a permission request is answered "allow" without a card.
 * `input` is the tool's input as the relay passes it on (a long command comes
 * cut, ending in "…": what cannot be read whole is asked about).
 */
export function autoApproves(mode: string, tool: string, input: Record<string, unknown>): boolean {
  if (ALWAYS_ASKED.has(tool)) return false;
  if (mode === "edits") return EDIT_TOOLS.has(tool);
  if (mode !== "all") return false;
  const command = typeof input.command === "string" ? input.command : "";
  if (command.endsWith("…")) return false;
  return !looksDestructive(command);
}
