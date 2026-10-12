// Thin wrapper over the Tauri commands/events. Every call is a no-op when the
// page is opened in a plain browser, so the island can be iterated on with
// `npm run dev` alone.

import { invoke } from "@tauri-apps/api/core";
import { emitTo, listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import type { Settings } from "./state";
import type { RecapHistory, RecapPrefs } from "../recap/summary";
import type { SpotifyState } from "./spotify";
import type { FoundPlace, WeatherNow } from "./weather";

export const IS_TAURI =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T | null> {
  if (!IS_TAURI) return null;
  try {
    return await invoke<T>(cmd, args);
  } catch (err) {
    console.error(`[coucou] ${cmd} failed`, err);
    return null;
  }
}

export interface BootInfo {
  settings: Settings;
  /** Logical screen rect of the monitor the island lives on. */
  screen: { x: number; y: number; width: number; height: number; scale: number };
  version: string;
  hookPath: string;
  /** False where the OS has no global cursor (Wayland): see Island.followPageCursor. */
  cursorPoll: boolean;
}

export const Bridge = {
  boot: () => call<BootInfo>("boot"),
  /** The system's languages as the webview sees them, for Rust's own texts (i18n.rs). */
  setSystemLanguages: (languages: string[]) => call<void>("set_system_languages", { languages }),

  saveSettings: (settings: Settings) => call<void>("save_settings", { settings }),

  /** Shrink the window down to the invisible wake strip (hidden) or back to full. */
  setCollapsed: (collapsed: boolean) => call<void>("set_collapsed", { collapsed }),

  /**
   * Pushes the island shape in window coordinates. Rust flips click-through from
   * its own cursor poll, so the flag is never a frame behind a click.
   */
  setIslandRect: (x: number, y: number, width: number, height: number) =>
    call<void>("set_island_rect", { x, y, width, height }),

  /** Give the window keyboard focus (chat field) and take it away again. */
  focusWindow: (focused: boolean) => call<void>("focus_window", { focused }),

  reposition: () => call<void>("reposition"),

  /** Displays the island can be pinned to: `key` is what `settings.screen` stores. */
  listMonitors: () => call<{ key: string; label: string }[]>("list_monitors"),

  openUrl: (url: string) => call<void>("open_url", { url }),

  /** Which of these sounds have a file of the user's own in the sounds folder. */
  customSounds: (names: readonly string[]) => call<string[]>("custom_sounds", { names }),
  /** The user's file for one sound, as raw bytes. */
  customSound: (name: string) => call<ArrayBuffer>("custom_sound", { name }),
  revealSoundsFolder: () => call<void>("reveal_sounds_folder"),
  /** Tells the island to read the sounds folder again ("sounds-changed"). */
  reloadSounds: () => call<void>("reload_sounds"),

  /** "Open terminal" → opens the folder in VS Code when `code` is on PATH. */
  openInVSCode: (path: string | null) => call<boolean>("open_in_vscode", { path }),

  /**
   * "Open terminal": the window the session runs in when Rust found it
   * (Windows; Linux on X11 and KDE Plasma), else the folder in VS Code.
   */
  openSession: (sessionId: string | null, path: string | null) =>
    call<boolean>("open_session", { sessionId, path }),

  /** The Claude desktop app, for the Claude Desktop pill (Windows only). */
  openClaudeDesktop: () => call<boolean>("open_claude_desktop"),

  /** The diff card's ↗: an existing file, in VS Code; never launched by its type. */
  openFileInVSCode: (path: string) => call<boolean>("open_file_in_vscode", { path }),

  quit: () => call<void>("quit_app"),

  openSettingsWindow: () => call<void>("open_settings_window"),

  /** Writes to %LOCALAPPDATA%\Coucou\coucou.log, next to the Rust lines. */
  log: (message: string) => call<void>("log_line", { message }),

  // ── Claude Code hooks ─────────────────────────────────────────────────────
  hooksStatus: () => call<HookStatus>("hooks_status"),
  /** Pill ID → whether that agent's hooks reach Coucou (read-only, Mac #183). */
  agentHooksStatus: () => call<Record<string, boolean>>("agent_hooks_status"),
  /** Diff to show before anything is written. `install: false` previews removal. */
  hooksPreview: (install: boolean) => callOrThrow<HookPreview>("hooks_preview", { install }),
  /**
   * Writes ~/.claude/settings.json — only ever after an explicit click, and only
   * when the file still matches the preview the user looked at.
   */
  hooksApply: (install: boolean, fingerprint: string) =>
    callOrThrow<string>("hooks_apply", { install, fingerprint }),

  // ── Other agents (Gemini CLI, Codex, Cursor…) ─────────────────────────────
  agentHooksList: () => call<AgentHookStatus[]>("agent_hooks_list"),
  /** Diff to show before anything is written. `install: false` previews removal. */
  agentHooksPreview: (agent: string, install: boolean) =>
    callOrThrow<AgentHookPlan>("agent_hooks_preview", { agent, install }),
  /**
   * Writes the agent's config — only ever after an explicit click, and only when
   * it still matches the preview the user looked at. Returns the backups taken.
   */
  agentHooksApply: (agent: string, install: boolean, fingerprint: string) =>
    callOrThrow<string>("agent_hooks_apply", { agent, install, fingerprint }),
  // ── Plan usage: the status line relay, installed apart from the hooks ──────
  /** Diff of the status line change. `install: false` previews taking the relay out. */
  statusLinePreview: (install: boolean) => callOrThrow<HookPreview>("status_line_preview", { install }),
  /** Same rules as hooksApply: an explicit click, and only for the diff that was shown. */
  statusLineApply: (install: boolean, fingerprint: string) =>
    callOrThrow<string>("status_line_apply", { install, fingerprint }),
  /**
   * Asks the Codex CLI (`codex app-server`) for its plan limits, as Codex's
   * /status does. The raw `account/rateLimits/read` result, or null when Codex
   * is missing, not signed in or slow (15 s).
   */
  codexPlanUsage: () => call<unknown>("codex_plan_usage"),
  /**
   * Claude plan limits asked of the Claude Code CLI (`{ rate_limits }`, as the
   * status line gives them), or null when it is missing, not on a plan or slow.
   * A real, very small request: only for numbers that are old.
   */
  claudePlanUsage: () => call<{ rate_limits?: unknown }>("claude_plan_usage"),

  // ── Task mode (src-tauri/src/task_runner.rs) ──────────────────────────────
  /**
   * Hands a task to Claude Code (`claude -p`) run in `dir`; resolves to the
   * task id. `resume`: an earlier task's session id — the follow-up then
   * continues that conversation instead of opening a new one.
   */
  taskSpawn: (prompt: string, dir: string, resume: string | null) =>
    callOrThrow<number>("task_spawn", { prompt, dir, resume }),
  /** Ends a running task; its bubble gets a "Cancelled." result. */
  taskCancel: (taskId: number) => call<void>("task_cancel", { taskId }),
  /** The folders Task mode offers: the projects root, then its subfolders. */
  taskProjects: () => call<string[]>("task_projects"),
  /** The bubble's folder button: the project's reports/ if any, else the project. */
  taskReveal: (dir: string) => call<void>("task_reveal", { dir }),

  // ── Settings → Skills: Claude Code's skills, the user's and each project's ──
  skillsList: () => call<SkillGroup[]>("skills_list"),
  /** Renames the skill's SKILL.md out of Claude Code's sight, or back. Throws when it could not. */
  skillSetEnabled: (path: string, enabled: boolean) => callOrThrow<void>("skill_set_enabled", { path, enabled }),
  skillReveal: (path: string) => call<void>("skill_reveal", { path }),
  /** Skills matching `query` on skills.sh (skill_store.rs). Throws when the search could not be made. */
  skillsSearch: (query: string, verifiedOnly: boolean) =>
    callOrThrow<FoundSkill[]>("skills_search", { query, verifiedOnly }),
  /**
   * A plan for the skills of `dest` ("" the user's own, else a project's
   * folder) that serves `request`, proposed by Claude Code (skill_advisor.rs).
   * Changes nothing; throws with the reason.
   */
  skillsAdvise: (request: string, dest: string, verifiedOnly: boolean) =>
    callOrThrow<SkillAdvice>("skills_advise", { request, dest, verifiedOnly }),
  /** The system's "choose a folder" window: the folder picked, or null when it was closed. */
  skillsPickFolder: () => call<string>("skills_pick_folder"),
  /** The projects a skill can be added to: the folders Claude Code has worked in, and those named in the settings. */
  skillsProjects: () => call<string[]>("skills_projects"),
  /** Adds a found skill to the user's skills (`dest` "") or a project's. Throws with the reason. */
  skillInstall: (source: string, skillId: string, dest: string) =>
    callOrThrow<string>("skill_install", { source, skillId, dest }),
  /** Copies an installed skill to the user's skills ("") or a project's. */
  skillCopy: (path: string, dest: string) => callOrThrow<string>("skill_copy", { path, dest }),
  /** Sends an installed skill's folder to the system's bin. */
  skillRemove: (path: string) => callOrThrow<void>("skill_remove", { path }),

  // ── The launcher tab (src-tauri/src/launcher.rs) ──────────────────────────
  /** Opens entry `index` of the saved list: a website, an app, a folder. */
  // ── Valorant match reviews, kept locally (src-tauri/src/valorant.rs) ──────
  valorantReviews: () => call<ValorantReviewList>("valorant_reviews"),
  /** What an analysis would send and to whom; nothing is sent. Throws with the reason when the events are not usable. */
  valorantAnalysisPlan: (events: ValorantEvents) => callOrThrow<ValorantPlan>("valorant_analysis_plan", { events }),
  /** Sends the events to the chat provider picked in Settings, after the user confirmed the plan. */
  valorantAnalyse: (events: ValorantEvents, confirmed: boolean) =>
    callOrThrow<ValorantReview>("valorant_analyse", { events, confirmed }),
  valorantNotes: () => call<string>("valorant_notes"),
  valorantNotesSet: (text: string) => callOrThrow<void>("valorant_notes_set", { text }),
  valorantRecorderStatus: () => call<ValorantRecorderStatus>("valorant_recorder_status"),
  valorantRecordings: () => call<ValorantRecording[]>("valorant_recordings"),
  /** One recording by name, or all of them (`null`). */
  valorantRecordingsDelete: (name: string | null) => callOrThrow<number>("valorant_recordings_delete", { name }),
  valorantRecordingsReveal: () => call<void>("valorant_recordings_reveal"),
  valorantReviewNote: (id: string, note: string) => callOrThrow<void>("valorant_review_note", { id, note }),
  valorantReviewDelete: (id: string) => callOrThrow<number>("valorant_review_delete", { id }),
  valorantReviewsDeleteAll: () => callOrThrow<number>("valorant_reviews_delete_all"),
  /** For each saved entry: can it be opened now (a path still there, an app still installed)? */
  launcherStatus: () => call<boolean[]>("launcher_status"),
  launcherOpen: (index: number) => call<void>("launcher_open", { index }),
  /** The entry's icon as RGBA pixels (base64), for a file the system has one for. */
  launcherIcon: (index: number) =>
    call<{ width: number; height: number; rgba: string }>("launcher_icon", { index }),
  /** A website entry's own icon as a data URL, fetched from that website; null when it has none. */
  launcherFavicon: (index: number) => call<string | null>("launcher_favicon", { index }),
  /** The picture the user chose for the entry (an image file of their own) as a data URL, or null. */
  launcherImage: (index: number) => call<string | null>("launcher_image", { index }),
  /** The image file at `path` as a data URL, for the "add" window's preview; null when it is not one. */
  launcherImageAt: (path: string) => call<string | null>("launcher_image_at", { path }),
  /** The apps installed on this PC (the Start menu's list), for the "add" window's search. */
  launcherApps: () => call<{ name: string; target: string }[]>("launcher_apps"),
  /** An installed app's icon as RGBA pixels (base64), for that list. */
  launcherAppIcon: (target: string) =>
    call<{ width: number; height: number; rgba: string }>("launcher_app_icon", { target }),
  /** Keeps a picked picture (a data URL) in the app's own folder and returns where. */
  launcherStoreImage: (data: string) => call<string>("launcher_store_image", { data }),
  /** The launcher's "add" window (settings/add-launcher.ts), shown with an empty form, and put away. */
  openLauncherAdd: () => call<void>("open_launcher_add"),
  closeLauncherAdd: () => call<void>("close_launcher_add"),

  approvalDecision: (requestId: string, decision: "allow" | "deny") =>
    call<void>("approval_decision", { requestId, decision }),
  /** "The card is up" — until this lands the relay only waits a moment. */
  approvalAck: (requestId: string) => call<void>("approval_ack", { requestId }),
  /** Answers a question Claude Code asked: question text → chosen label. */
  approvalAnswer: (requestId: string, answers: Record<string, string | string[]>) =>
    call<void>("approval_answer", { requestId, answers }),

  /** "Nobody can act on this" — Claude Code asks in the terminal right away. */
  approvalDecline: (requestId: string) => call<void>("approval_decline", { requestId }),

  // ── Chat, files, secrets ──────────────────────────────────────────────────
  /** One chat turn. The API key and any file bytes never leave Rust. */
  chatSend: (query: string, context: ChatContext | null) =>
    callOrThrow<{ text: string }>("chat_send", { query, context }),
  chatReset: () => call<void>("chat_reset"),
  /** Where the Claude Code CLI is, for Settings → Chat; null when it is not installed. */
  chatCliPath: () => call<string>("chat_cli_path"),

  // ── Weather ───────────────────────────────────────────────────────────────
  /** Settings → General → Weather: the places called what was typed. */
  weatherSearch: (query: string, language: string) =>
    callOrThrow<FoundPlace[]>("weather_search", { query, language }),
  /** The weather at the picked place; null while none is picked, or when it could not be asked. */
  weatherNow: () => call<WeatherNow>("weather_now"),
  /**
   * The models a provider offers, for the picker in the chat view. Rust asks
   * the provider only when it has a key (or a server address).
   */
  chatModels: (provider: string) => callOrThrow<ModelInfo[]>("chat_models", { provider }),
  /** Settings → Local models → Connect: does the server answer, and with which models? */
  /** The custom server's key, bound to the address it is entered for. */
  localSetKey: (url: string, key: string) => call<void>("local_set_key", { url, key }),

  localConnect: (provider: "ollama" | "lmstudio" | "custom", url: string) =>
    callOrThrow<LocalServer>("local_connect", { provider, url }),
  /** Copies a dropped file into the inbox. */
  ingestFile: (path: string) => callOrThrow<DroppedFile>("ingest_file", { path }),
  /** Only ever tells you whether a key exists — never its value. */
  secretPresent: (key: string) => call<boolean>("secret_present", { key }),
  secretSet: (key: string, value: string) => callOrThrow<void>("secret_set", { key, value }),
  secretClear: (key: string) => callOrThrow<void>("secret_clear", { key }),

  // ── Integrations ──────────────────────────────────────────────────────────
  refreshIntegration: (id: string) => call<void>("refresh_integration", { id }),
  /** The GitHub card is on screen: refetch that part if it is stale. */
  githubRefresh: (section: "pulse" | "activity") => call<void>("github_refresh", { section }),
  /** Opens the configured n8n instance in the browser. */
  openN8n: () => call<void>("open_n8n"),

  /** Tray → Pause. Stops the integration pollers, not just the island. */
  setPaused: (paused: boolean) => call<void>("set_paused", { paused }),

  // ── Global shortcuts ──────────────────────────────────────────────────────
  /** How each global shortcut went when Rust last registered them. */
  shortcutsStatus: () => call<ShortcutsReport>("shortcuts_status"),
  /** Lets go of every global shortcut while Settings records a new one. */
  shortcutsSuspend: (suspended: boolean) => call<void>("shortcuts_suspend", { suspended }),

  // ── Weekly recap ──────────────────────────────────────────────────────────
  /** Turns and decisions from `since` (Unix seconds) on, plus the recap prefs. */
  recapHistory: (since: number) => call<RecapHistory>("recap_history", { since: Math.floor(since) }),
  recapPrefs: () => call<RecapPrefs>("recap_prefs"),
  recapSetEnabled: (enabled: boolean) => call<void>("recap_set_enabled", { enabled }),
  recapSetHideProjects: (hide: boolean) => call<void>("recap_set_hide_projects", { hide }),
  /** `week` is the Monday (YYYY-MM-DD) the recap opened on its own for. */
  recapMarkShown: (week: string) => call<void>("recap_mark_shown", { week }),
  recapClear: () => call<void>("recap_clear"),
  /** Writes the PNG (a data URL) into Pictures or Downloads; returns its path. */
  recapSavePng: (data: string, week: string) => callOrThrow<string>("recap_save_png", { data, week }),
  /** Opens the folder of the image saved last. */
  recapRevealSaved: () => call<void>("recap_reveal_saved"),

  // ── Mochi on the desktop (src-tauri/src/desktop.rs) ───────────────────────
  desktopInfo: () => call<DesktopInfo>("desktop_mochi_info"),
  /** Dragged out of the island: (x, y) is the pointer in island-window coordinates. */
  desktopPickUp: (x: number, y: number) => call<boolean>("desktop_mochi_pick_up", { x, y }),
  /** Linux: the pointer moved during that drag (Windows carries him from Rust). */
  desktopCarry: (x: number, y: number) => call<void>("desktop_mochi_carry", { x, y }),
  desktopCarryEnd: (x: number, y: number) => call<void>("desktop_mochi_carry_end", { x, y }),
  /** A drag started on the desktop Mochi; resolves to his top-left corner. */
  desktopDragBegin: () => call<[number, number] | null>("desktop_mochi_drag_begin"),
  /** X11: top-left corner, physical pixels. */
  desktopDragMove: (x: number, y: number) => call<void>("desktop_mochi_drag_move", { x, y }),
  desktopDragEnd: (x: number, y: number) => call<void>("desktop_mochi_drag_end", { x, y }),
  /** From the island to his spot. False: no spot on any connected display.
   *  `anywhere`: the first-visit corner then, rather than staying home. */
  desktopFlyOut: (anywhere = false) => call<boolean>("desktop_mochi_fly_out", { anywhere }),
  /** To the island, then hidden. `forget`: he lives in the island again. */
  desktopFlyHome: (forget: boolean) => call<boolean>("desktop_mochi_fly_home", { forget }),
  /** Asleep, the cursor poll stops. */
  desktopSetAsleep: (asleep: boolean) => call<void>("desktop_mochi_set_asleep", { asleep }),

  // ── Spotify (src-tauri/src/spotify.rs, Linux) ─────────────────────────────
  /** Reads the player again (the card came on screen) and reports it. */
  spotifyRefresh: () => call<SpotifyState | null>("spotify_refresh"),
  /** True when Spotify took it. `value`: seconds for seek, 0/1 for shuffle and repeat, 0…100 for volume. */
  spotifyControl: (action: SpotifyAction, value?: number) =>
    call<boolean>("spotify_control", { action, value: value ?? null }),
  /** Brings Spotify forward or starts it; without it, its download page. */
  spotifyOpen: () => call<boolean>("spotify_open"),
  /** Whether there is a Spotify to launch (Settings). */
  spotifyInstalled: () => call<boolean>("spotify_installed"),
  /** Whether the song's beat can be heard on this system (Settings; beat.rs, Windows). */
  spotifyHears: () => call<boolean>("spotify_hears"),
  /** A Mochi dances to the song where he can be seen, or no longer does: Rust listens to it only then. */
  spotifyDancing: (on: boolean) => call<void>("spotify_dancing", { on }),
};

/** One of Claude Code's skills (src-tauri/src/skills.rs). */
export interface SkillInfo {
  name: string;
  description: string;
  /** The skill's folder. */
  path: string;
  enabled: boolean;
}

/** A skill found on skills.sh (src-tauri/src/skill_store.rs). */
export interface FoundSkill {
  /** `owner/repo` on GitHub. */
  source: string;
  skillId: string;
  name: string;
  installs: number;
  /** From one of the publishers skill_store.rs lists. */
  verified: boolean;
}

/** What Claude Code proposes for a folder's skills: to add, to remove, and a word on why. */
export interface SkillAdvice {
  /** `dest`: the folder a line is about, "" the user's own skills, else a project's. */
  add: (FoundSkill & { dest: string; reason: string })[];
  remove: { path: string; name: string; dest: string; reason: string }[];
  note: string;
}

/** One moment of a Valorant review: what was seen, what is inferred, how sure. */
export interface ValorantFinding {
  startMs: number;
  endMs: number;
  category: string;
  fact: string;
  inference: string;
  reasoning: string;
  alternative: string;
  uncertainty: string;
  drill: string;
  /** The guide section it is judged against (`POS-1`…), or `NOTES`. */
  guide: string;
}

export interface ValorantReview {
  id: string;
  createdAt: number;
  videoMs: number;
  didWell: string[];
  topIssues: string[];
  nextGoal: string;
  findings: ValorantFinding[];
  userNote: string;
}

/** What the video processing layer saw in a match, each with its time. */
export interface ValorantEvents {
  videoMs: number;
  events: { atMs: number; kind: string; detail: string }[];
}

export interface ValorantPlan {
  provider: string;
  model: string;
  /** The events leave this PC. */
  external: boolean;
  characters: number;
  estimatedTokens: number;
  tokenLimit: number;
}

/** The recorder's state (src-tauri/src/recorder.rs). */
export interface ValorantRecorderStatus {
  state: "off" | "waiting" | "recording" | "noFfmpeg" | "lowDisk" | "failed";
  file: string;
  detail: string;
}

export interface ValorantRecording {
  name: string;
  bytes: number;
  modified: number;
}

export interface ValorantReviewList {
  reviews: ValorantReview[];
  /** Files in the reviews folder that are not valid reviews: kept, not read. */
  skipped: number;
}

export interface SkillGroup {
  /** The project's folder; empty for the user's own skills. */
  project: string;
  /** The folder the skills are in. */
  root: string;
  skills: SkillInfo[];
  /** An installed Claude Code plugin's id (`name@marketplace`); absent for a skills folder. Its skills are read-only. */
  plugin?: string;
  /** Whether Claude Code has that plugin turned on. */
  pluginEnabled?: boolean;
  /** Why a plugin's skills could not be listed; absent when they could. */
  problem?: string;
}

export type SpotifyAction = "playPause" | "next" | "previous" | "seek" | "shuffle" | "repeat" | "volume";

export type ShortcutStatus =
  | "active" | "off" | "inUse" | "duplicate" | "invalid"
  | "typesCharacter" | "unsupported" | "notPorted"
  /** Wayland: handed to the desktop's portal, no answer yet / left out by it. */
  | "pending" | "refused";

export interface ShortcutsReport {
  /** `trigger`: on Wayland, the keys the desktop says run it, in its words. */
  actions: { id: string; status: ShortcutStatus; typed?: string; trigger?: string }[];
  /** "wayland" or "no-display" when no key grab can be made. */
  blocked: string | null;
  /** `<executable> --shortcut`: append an action id for a desktop shortcut. */
  command: string;
  /** Wayland: the shortcuts went to the desktop's GlobalShortcuts portal. */
  portal?: "pending" | "active" | null;
}

/** How the desktop Mochi's window works here (platform::DesktopMode). */
export type DesktopMode = "poll" | "window" | "layer" | "off";

export interface DesktopInfo {
  mode: DesktopMode;
  /** He was on the desktop when the app last quit. */
  onDesktop: boolean;
}

/** An event for one window only (island ⇄ desktop Mochi). Never throws. */
export async function emitToWindow(label: string, event: string, payload?: unknown) {
  if (!IS_TAURI) return;
  try {
    await emitTo(label, event, payload);
  } catch (err) {
    console.error(`[coucou] emit ${event} failed`, err);
  }
}

export interface IntegrationUpdate {
  id: string;
  data: Record<string, unknown>;
  error: string | null;
  event: { success: boolean; label: string; detail: string | null } | null;
}

export type ChatContext =
  | { kind: "file"; name: string; path: string }
  | { kind: "window"; appName: string; title: string; url?: string };

export interface ModelInfo {
  id: string;
  label: string;
}

/** `task-started`: the task found its Claude Code session (its island pill). */
export interface TaskStarted {
  taskId: number;
  sessionId: string;
}

/** `task-result`: a task's final answer, already Markdown. */
export interface TaskResult {
  taskId: number;
  ok: boolean;
  text: string;
}

export interface LocalServer {
  /** The address as it is stored. */
  url: string;
  models: string[];
  /** The address is this machine. */
  loopback: boolean;
}

export interface DroppedFile {
  name: string;
  path: string;
  size: number;
}

export interface HookStatus {
  installed: boolean;
  /** Coucou's status line relay (plan usage) is the status line in settings.json. */
  planRelayInstalled: boolean;
  settingsPath: string;
  hookPath: string;
  hookReady: boolean;
}

/** One agent other than Claude Code, as agents.rs reports it. */
export interface AgentHookStatus {
  /** The `--agent` name; its pill is `agent_<id>`. */
  id: string;
  name: string;
  installed: boolean;
  /** The file (or files, one per line) Coucou writes. */
  path: string;
  hookReady: boolean;
  /** The island can allow or deny this agent's permission requests. */
  approvals: boolean;
  /** What to do once it is written. */
  note: string;
}

export interface AgentHookPlan {
  diff: string;
  /** Where each existing file is copied first, one per line; "" when none. */
  backup: string;
  path: string;
  fingerprint: string;
}

export interface HookPreview {
  diff: string;
  backup: string;
  settingsPath: string;
  /** Hand back to hooksApply so only the reviewed diff is ever written. */
  fingerprint: string;
}

/** Same as `call`, but surfaces the error so the UI can show what went wrong. */
async function callOrThrow<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!IS_TAURI) throw new Error("not running inside Coucou");
  return invoke<T>(cmd, args);
}

export type BridgeEvent =
  | { name: "cursor"; payload: { x: number; y: number } }
  | { name: "tray"; payload: string }
  | { name: "hook"; payload: Record<string, unknown> }
  | { name: "screen-changed"; payload: null };

export interface DragDropPayload {
  type: "enter" | "over" | "drop" | "leave";
  paths?: string[];
}

interface WebView2Bridge {
  postMessageWithAdditionalObjects(message: unknown, objects: ArrayLike<unknown>): void;
}

/**
 * Files dragged onto the island. Only reaches us when the window takes the mouse.
 *
 * On Windows WebView2 takes the drop itself, as in Edge — Tauri's drop handling
 * never sees drags from the classic Explorer folder view (see
 * src-tauri/src/webview_drop.rs). Enter/over/leave come straight from the page;
 * the drop hands the File objects to Rust, which answers with their real paths
 * as a `file-drag` event. Elsewhere (Linux) Tauri's own drag events still do it.
 */
export async function onDragDrop(handler: (e: DragDropPayload) => void) {
  if (!IS_TAURI) return () => {};
  const webview = (window as unknown as { chrome?: { webview?: WebView2Bridge } }).chrome?.webview;
  if (!webview) {
    return getCurrentWebview().onDragDropEvent((event) => {
      handler(event.payload as DragDropPayload);
    });
  }
  const hasFiles = (e: DragEvent) => e.dataTransfer?.types.includes("Files") ?? false;
  // dragenter/dragleave fire for every element crossed; only the outermost pair counts.
  let depth = 0;

  const onEnter = (e: DragEvent) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    if (depth++ === 0) handler({ type: "enter" });
  };
  const onOver = (e: DragEvent) => {
    if (!hasFiles(e)) return;
    // Without this WebView2 refuses the drop — or navigates to the file.
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    handler({ type: "over" });
  };
  const onLeave = (e: DragEvent) => {
    if (!hasFiles(e) || depth === 0) return;
    if (--depth === 0) handler({ type: "leave" });
  };
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    depth = 0;
    const files = e.dataTransfer?.files;
    if (!files || files.length === 0) {
      handler({ type: "drop", paths: [] });
      return;
    }
    webview.postMessageWithAdditionalObjects("coucou-file-drop", files);
  };

  window.addEventListener("dragenter", onEnter);
  window.addEventListener("dragover", onOver);
  window.addEventListener("dragleave", onLeave);
  window.addEventListener("drop", onDrop);
  const unlisten = await listen<DragDropPayload>("file-drag", (e) => handler(e.payload));
  return () => {
    window.removeEventListener("dragenter", onEnter);
    window.removeEventListener("dragover", onOver);
    window.removeEventListener("dragleave", onLeave);
    window.removeEventListener("drop", onDrop);
    unlisten();
  };
}

export async function onEvent<T>(name: string, handler: (payload: T) => void) {
  if (!IS_TAURI) return () => {};
  return listen<T>(name, (e) => handler(e.payload));
}
