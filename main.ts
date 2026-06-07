import {
  Editor,
  ItemView,
  MarkdownView,
  Menu,
  Modal,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TAbstractFile,
  TFile,
  TFolder,
  Vault,
  WorkspaceLeaf,
  WorkspaceParent,
  WorkspaceSplit,
  FuzzySuggestModal,
  setIcon,
  App,
} from "obsidian";
import {
  DriveRevision,
  GoogleDriveClient,
  isDesktop,
  parseDriveFolderId,
} from "./gdrive";

const VIEW_TYPE_PROJECT_LIST = "recent-view-project-list";
const VIEW_TYPE_PROJECT_CONTENT = "recent-view-project-content";
const VIEW_TYPE_RECENT_EDITS = "recent-view-recent-edits";

interface OpenNote {
  path: string;
  // Ephemeral view state (scroll position, cursor) captured when the project
  // was last active, so reopening restores where the user left off.
  eState?: Record<string, unknown>;
  // Whether this was the focused tab when the project was last active.
  active?: boolean;
}

interface ProjectPane {
  id: string;
  name: string;
  lastOpenNotes: OpenNote[];
  lastClosedNotes?: OpenNote[];
  // A manually saved set of tabs that can be reopened on demand.
  defaultTabs?: OpenNote[];
}

interface Project {
  id: string;
  name: string;
  description: string;
  folders: string[];
  notes: string[];
  // Open tabs of the project's main (default) pane.
  lastOpenNotes: OpenNote[];
  // Recently closed notes of the project's main pane.
  lastClosedNotes?: OpenNote[];
  // Additional named panes; each keeps its own set of open tabs.
  panes: ProjectPane[];
  // Which pane is currently shown: null/undefined = the main pane.
  activePaneId?: string | null;
  // Note paths pinned to the top of the content pane, above the folders.
  pinned: string[];
  // Google Drive sync: source/target folder id and the mirrored vault folder.
  driveFolderId?: string;
  driveLocalFolder?: string;
  // A manually saved set of tabs that can be reopened on demand.
  defaultTabs?: OpenNote[];
}

interface RecentViewData {
  projects: Project[];
  activeProjectId: string | null;
}

type EditKind = "add" | "delete" | "modify";

// The character range of the added/modified text, so clicking an edit can select
// exactly what changed (even across multiple lines).
interface EditSel {
  fromLine: number;
  fromCh: number;
  toLine: number;
  toCh: number;
}

// A single recorded edit: where it happened (path + line/ch), the added/removed
// text snippet, what kind of change it was, and when, so the Recent edits pane
// can show it and jump back to the exact spot.
interface EditRecord {
  path: string;
  text: string;
  kind: EditKind;
  line: number; // region start line, used for navigation
  lastLine: number; // most recent line touched (for merging adjacent edits)
  ch: number;
  time: number;
  // Selection range of the added/modified text (absent for deletions).
  sel?: EditSel;
}

interface RecentViewSettings {
  // Vault-relative path of the note that stores this vault's project data.
  dataNotePath: string;
  // When true, other project pane groups are closed when switching projects
  // so the workspace always has a single flat tab group. When false, pane
  // groups are kept alive and hidden with CSS for faster repeat-switching.
  closePanesOnSwitch: boolean;
  // How many recently edited notes the Recent edits pane keeps.
  editHistorySize: number;
  // When true, whitespace-only changes are recorded in the Recent edits pane.
  trackWhitespaceEdits: boolean;
  // Google Drive OAuth credentials + token.
  gdriveClientId: string;
  gdriveClientSecret: string;
  gdriveRefreshToken: string;
}

const DEFAULT_DATA_NOTE = "ProjectView.md";
// Older releases stored data here; read from it if the new note is missing.
const LEGACY_DATA_NOTE = "RecentView.md";
const DEFAULT_EDIT_HISTORY = 50;

const DEFAULT_SETTINGS: RecentViewSettings = {
  dataNotePath: DEFAULT_DATA_NOTE,
  closePanesOnSwitch: true,
  editHistorySize: DEFAULT_EDIT_HISTORY,
  trackWhitespaceEdits: false,
  gdriveClientId: "",
  gdriveClientSecret: "",
  gdriveRefreshToken: "",
};

// Header written above the JSON block so the note is self-explanatory.
const DATA_NOTE_HEADER =
  "# ProjectView data\n\n" +
  "This note is managed by the **ProjectView** plugin and stores this " +
  "vault's projects. Avoid editing the JSON block below by hand.";

function genId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// Cap the merge LCS table at ~25M cells (~100 MB of Uint32Array) so a runaway
// merge of two huge files can't lock up the renderer.
const MERGE_MAX_CELLS = 25_000_000;

// YAML frontmatter keys stamped on a merge note so we can locate the source
// file when applying ticked changes back to it.
const MERGE_FM_SOURCE = "project-view-merge-source";
const MERGE_FM_CREATED = "project-view-merge-created";

// Sentinel that separates the user-facing instructions block from the actual
// merge content. applyMergeBody skips everything up to and including this
// line, so the instructions never leak into the applied output.
const MERGE_CONTENT_MARKER = "<!-- project-view-merge-content-start -->";

const MERGE_INSTRUCTIONS =
  "> [!info] How to use this merge note\n" +
  "> 1. Tick the boxes below to choose which changes to keep.\n" +
  "> 2. Open this file's menu in the right pane → **Apply ticks to original note**.\n" +
  ">\n" +
  "> Default ticks already preserve your existing local content; Drive additions and Drive-side modifications start unchecked, so a no-op apply is safe. Re-tick and re-apply as many times as you like — this note is left intact.";

/**
 * Line-level additive merge: keep every line from `local`, weave in lines that
 * exist only in `remote`, and on a conflicting block emit both sides (local
 * first, then remote). Never deletes content from local. Returns null if the
 * inputs are too large to merge in memory.
 *
 * Every change is wrapped in a Markdown blockquote whose header is a task
 * checkbox so the user can tick what they want applied back to the original
 * (via "Apply ticks to original note" on the merge file's menu). Categories:
 *   • "Added on Google Drive"            — lines only on Drive; default off
 *   • "Not on Google Drive"              — lines only on local; default on
 *   • "Modified — local version"         — local side of a conflict; default on
 *   • "Modified — Google Drive version"  — Drive side of a conflict; default off
 * Defaults preserve existing local content so a no-op apply is safe.
 */
function mergeAdditive(local: string, remote: string): string | null {
  const a = local.split("\n");
  const b = remote.split("\n");
  const n = a.length;
  const m = b.length;
  if ((n + 1) * (m + 1) > MERGE_MAX_CELLS) return null;
  // dp[i][j] = LCS length of a[i..] and b[j..]; tied diverges prefer local
  // first, so the additive walk naturally emits local-only blocks before
  // remote-only blocks rather than interleaving them line-by-line.
  const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    const cur = dp[i];
    const next = dp[i + 1];
    for (let j = m - 1; j >= 0; j--) {
      cur[j] = a[i] === b[j] ? next[j + 1] + 1 : Math.max(next[j], cur[j + 1]);
    }
  }

  type OpType = "common" | "local" | "drive";
  const ops: { type: OpType; line: string }[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ type: "common", line: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ type: "local", line: a[i++] });
    } else {
      ops.push({ type: "drive", line: b[j++] });
    }
  }
  while (i < n) ops.push({ type: "local", line: a[i++] });
  while (j < m) ops.push({ type: "drive", line: b[j++] });

  // Group consecutive same-type ops into runs so we can label whole blocks.
  const runs: { type: OpType; lines: string[] }[] = [];
  for (const op of ops) {
    const last = runs[runs.length - 1];
    if (last && last.type === op.type) last.lines.push(op.line);
    else runs.push({ type: op.type, lines: [op.line] });
  }

  const out: string[] = [];
  // Each block is a top-level task list item (so the checkbox is clickable in
  // Live Preview and Reading view) with the changed lines nested under it as
  // an indented blockquote. Default ticks preserve existing local content
  // (local-only and local-side of a modification start checked) while
  // Drive-introduced changes start unchecked, so a no-op apply doesn't lose
  // the user's data.
  const pushQuoted = (label: string, lines: string[], defaultTick: boolean) => {
    if (out.length && out[out.length - 1] !== "") out.push("");
    out.push(`- [${defaultTick ? "x" : " "}] **${label}**`);
    for (const line of lines) out.push(`  > ${line}`);
    out.push("");
  };

  let k = 0;
  while (k < runs.length) {
    const r = runs[k];
    if (r.type === "common") {
      for (const line of r.lines) out.push(line);
      k++;
      continue;
    }
    const next = runs[k + 1];
    if (r.type === "local" && next && next.type === "drive") {
      // Adjacent local + drive runs = modified block; keep both sides.
      pushQuoted("Modified — local version", r.lines, true);
      pushQuoted("Modified — Google Drive version", next.lines, false);
      k += 2;
    } else if (r.type === "drive" && next && next.type === "local") {
      pushQuoted("Modified — Google Drive version", r.lines, false);
      pushQuoted("Modified — local version", next.lines, true);
      k += 2;
    } else if (r.type === "drive") {
      pushQuoted("Added on Google Drive", r.lines, false);
      k++;
    } else {
      // Lines exist locally but not on Drive. A 2-way diff can't tell whether
      // Drive deleted them or local added them since last sync — describe the
      // observable fact rather than guess at intent.
      pushQuoted("Not on Google Drive", r.lines, true);
      k++;
    }
  }

  // Trim a single trailing blank we may have appended after a quoted block.
  if (out.length && out[out.length - 1] === "") out.pop();
  return out.join("\n");
}

/**
 * Parse a merge-note body and return the content to write back to the source:
 * frontmatter is stripped, each labelled blockquote is kept (with `> ` prefix
 * removed from its body) iff its task header is ticked, plain prose is kept
 * as-is. Returns counts so the caller can show a useful notice.
 */
function applyMergeBody(raw: string): {
  body: string;
  kept: number;
  dropped: number;
} {
  const lines = raw.split("\n");
  let i = 0;
  // Skip YAML frontmatter at top.
  if (lines[0] === "---") {
    let j = 1;
    while (j < lines.length && lines[j] !== "---") j++;
    if (j < lines.length) i = j + 1;
  }
  // Drop blank lines immediately after frontmatter.
  while (i < lines.length && lines[i] === "") i++;
  // If the instructions sentinel is present, jump past it (and the leading
  // instructions block) so we never apply the help text back to the source.
  // Look ahead within a small window so we don't accidentally hop over real
  // content if the marker is missing.
  const SCAN_LIMIT = 40;
  for (let s = i; s < Math.min(lines.length, i + SCAN_LIMIT); s++) {
    if (lines[s].trim() === MERGE_CONTENT_MARKER) {
      i = s + 1;
      while (i < lines.length && lines[i] === "") i++;
      break;
    }
  }

  // Header: top-level task list item with our label in bold.
  const HEADER = /^-\s*\[([ xX])\]\s*\*\*(.+?)\*\*\s*$/;
  // Body line: two-space indent + blockquote marker (continuation of the task
  // item). We accept both "  > " and a bare "  >" (empty body line).
  const BODY = /^ {2}> ?(.*)$/;
  const out: string[] = [];
  let kept = 0;
  let dropped = 0;
  let skipBlankAfterDrop = false;

  while (i < lines.length) {
    const line = lines[i];
    const m = HEADER.exec(line);
    if (m) {
      const checked = m[1].toLowerCase() === "x";
      i++;
      const body: string[] = [];
      while (i < lines.length) {
        const b = BODY.exec(lines[i]);
        if (!b) break;
        body.push(b[1]);
        i++;
      }
      if (checked) {
        kept++;
        if (out.length && out[out.length - 1] !== "") out.push("");
        for (const b of body) out.push(b);
        // Consume one trailing blank that the original pushQuoted emitted, so
        // we don't end up with two blank lines in a row.
        if (i < lines.length && lines[i] === "") i++;
      } else {
        dropped++;
        // If we dropped a block, also swallow the blank line that pushQuoted
        // added after it (and possibly the blank line before, by remembering
        // not to emit one before the next non-blank chunk).
        if (i < lines.length && lines[i] === "") i++;
        if (out.length && out[out.length - 1] === "") {
          // Trim back-to-back blanks once.
          skipBlankAfterDrop = true;
        }
      }
      continue;
    }
    if (skipBlankAfterDrop && line === "") {
      skipBlankAfterDrop = false;
      i++;
      continue;
    }
    skipBlankAfterDrop = false;
    out.push(line);
    i++;
  }

  // Collapse trailing blanks.
  while (out.length && out[out.length - 1] === "") out.pop();
  return { body: out.join("\n"), kept, dropped };
}

function sanitizeVaultName(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, "_").trim() || "Google Drive";
}

/**
 * Make a container's children (those carrying a `data-rv-id`) drag-reorderable
 * with live motion: the dragged item moves in the DOM as the cursor passes
 * other items. On drop, onReorder receives the final id order.
 */
function enableReorder(
  container: HTMLElement,
  onReorder: (orderedIds: string[]) => void
): void {
  const items = (): HTMLElement[] =>
    Array.from(container.children).filter(
      (el) => (el as HTMLElement).dataset.rvId != null
    ) as HTMLElement[];

  let dragging: HTMLElement | null = null;

  for (const item of items()) {
    item.draggable = true;
    item.addClass("rv-pin-draggable");
    item.addEventListener("dragstart", (e) => {
      dragging = item;
      item.addClass("rv-dragging");
      if (e.dataTransfer) {
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", item.dataset.rvId ?? "");
      }
    });
    item.addEventListener("dragend", () => {
      item.removeClass("rv-dragging");
      dragging = null;
      onReorder(items().map((i) => i.dataset.rvId ?? ""));
    });
  }

  container.addEventListener("dragover", (e) => {
    e.preventDefault();
    if (!dragging) return;
    if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
    const y = e.clientY;
    const siblings = items().filter((i) => i !== dragging);
    let before: HTMLElement | null = null;
    for (const sib of siblings) {
      const box = sib.getBoundingClientRect();
      if (y < box.top + box.height / 2) {
        before = sib;
        break;
      }
    }
    if (before) container.insertBefore(dragging, before);
    else container.appendChild(dragging);
  });
}

/** Reorder a list to match the given id order (items keep their objects). */
function applyOrder<T>(
  list: T[],
  idOf: (item: T) => string,
  orderedIds: string[]
): T[] {
  const byId = new Map(list.map((item) => [idOf(item), item]));
  const result: T[] = [];
  for (const id of orderedIds) {
    const item = byId.get(id);
    if (item) {
      result.push(item);
      byId.delete(id);
    }
  }
  // Keep any items not represented in orderedIds (e.g. unknown ids) at the end.
  for (const item of byId.values()) result.push(item);
  return result;
}

function buildDataNote(data: RecentViewData): string {
  return `${DATA_NOTE_HEADER}\n\n\`\`\`json\n${JSON.stringify(
    data,
    null,
    2
  )}\n\`\`\`\n`;
}

function parseDataNote(content: string): RecentViewData | null {
  const match = content.match(/```json\s*([\s\S]*?)```/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[1]) as Partial<RecentViewData>;
    return {
      projects: parsed.projects ?? [],
      activeProjectId: parsed.activeProjectId ?? null,
    };
  } catch {
    return null;
  }
}

/**
 * Show a menu at the click position. Keeps the triggering button highlighted
 * while open, and makes the pane click-through (pointer-events: none) so that a
 * click anywhere in it only dismisses the menu — the click physically cannot
 * land on a note/folder underneath, and the menu (rendered on document.body)
 * still works. The menu's own outside-click handling then closes it.
 */
function showMenu(
  menu: Menu,
  event: MouseEvent,
  paneEl: HTMLElement,
  btn?: HTMLElement
): void {
  btn?.addClass("is-active");
  paneEl.addClass("rv-pointer-blocked");
  menu.onHide(() => {
    btn?.removeClass("is-active");
    paneEl.removeClass("rv-pointer-blocked");
  });
  menu.showAtMouseEvent(event);
}

export default class RecentViewPlugin extends Plugin {
  data: RecentViewData = { projects: [], activeProjectId: null };
  settings: RecentViewSettings = { ...DEFAULT_SETTINGS };
  // Recently edited notes, most recent first (one entry per note).
  editHistory: EditRecord[] = [];
  private editSaveTimer: number | null = null;
  // The path whose document we've snapshotted in lastEditDoc.
  private editBaselinePath: string | null = null;
  // The document as of the previous change, used as the baseline when a new edit
  // begins (a change on a non-adjacent line).
  private lastEditDoc = "";
  // Whether the top history row is the live edit currently being extended.
  private editRegionActive = false;
  // Each live edit's starting document, kept across tab switches so returning to
  // a note can continue the same edit on an adjacent line. Not persisted.
  private editBaselineByRecord: WeakMap<EditRecord, string> = new WeakMap();
  private isActivating = false;
  private noteWriteTimer: number | null = null;
  // Live tab group (pane) per project, kept alive so switching just shows/hides
  // panes instead of closing and reopening notes.
  private projectGroups: Map<string, WorkspaceParent> = new Map();
  // Stack of previously-active project ids, for the back button.
  private navHistory: string[] = [];
  // True while the app is quitting / plugin unloading (avoid wiping saved tabs
  // when the workspace tears down its leaves).
  private unloading = false;
  // True during the startup settling window (Obsidian may still be (re)building
  // the layout, so ignore layout-change events that would wipe restored tabs).
  private starting = true;
  // Leaves opened by settleStartupInner; used by cleanupStrayPanes to remove
  // any other leaf that Obsidian async-restored into the same group.
  private _startupOpenedLeaves: WorkspaceLeaf[] | null = null;
  // Serializes pane switches so rapid clicks run one at a time instead of
  // concurrently (which would create stray split panes).
  private _switchQueue: Promise<unknown> = Promise.resolve();
  // Number of pane switches queued or running; the isActivating guard is only
  // released once this drains to zero so a later switch isn't interrupted.
  private _pendingSwitches = 0;
  // Bumped the instant a new switch is requested. An in-flight pane build
  // checks this between tab opens and aborts as soon as it's superseded, so a
  // newer click never has to wait for the old project's tabs to finish opening.
  private _showPaneGen = 0;
  private _drive: GoogleDriveClient | null = null;

  get drive(): GoogleDriveClient {
    if (!this._drive) {
      this._drive = new GoogleDriveClient(
        this.app,
        () => this.settings,
        () => this.saveSettings()
      );
    }
    return this._drive;
  }

  async onload(): Promise<void> {
    await this.loadAll();

    this.addSettingTab(new RecentViewSettingTab(this.app, this));

    this.registerView(
      VIEW_TYPE_PROJECT_LIST,
      (leaf) => new ProjectListView(leaf, this)
    );
    this.registerView(
      VIEW_TYPE_PROJECT_CONTENT,
      (leaf) => new ProjectContentView(leaf, this)
    );
    this.registerView(
      VIEW_TYPE_RECENT_EDITS,
      (leaf) => new RecentEditsView(leaf, this)
    );

    this.addRibbonIcon("folder-kanban", "Recent View: projects", () =>
      this.activateListView()
    );
    this.addRibbonIcon("history", "Recent View: recent edits", () =>
      this.activateEditsView()
    );

    this.addCommand({
      id: "open-projects-pane",
      name: "Open projects pane",
      callback: () => this.activateListView(),
    });

    this.addCommand({
      id: "open-recent-edits-pane",
      name: "Open recent edits pane",
      callback: () => this.activateEditsView(),
    });

    // Record edits as the user types so the Recent edits pane can show what was
    // added/changed and jump back to that spot. Snapshot the doc on open so we
    // can diff out just the inserted text.
    this.registerEvent(
      this.app.workspace.on("file-open", (file) => this.setEditBaseline(file))
    );
    this.registerEvent(
      this.app.workspace.on("editor-change", (editor, info) => {
        const file = info.file;
        if (file instanceof TFile) this.onEditorChange(editor, file);
      })
    );

    this.addCommand({
      id: "new-project",
      name: "Create new project",
      callback: () => new ProjectEditModal(this.app, this, null).open(),
    });

    this.addCommand({
      id: "save-current-tabs",
      name: "Save current tabs to active project",
      callback: () => {
        const n = this.saveActiveProjectTabs(true);
        const p = this.getActiveProject();
        new Notice(
          p
            ? `RecentView: saved ${n} tab(s) to "${p.name}"`
            : "RecentView: no active project"
        );
      },
    });

    // Track the active project's open tabs as the layout changes (tabs being
    // opened, closed or moved all fire layout-change).
    this.registerEvent(
      this.app.workspace.on("layout-change", () => this.onLayoutChange())
    );
    // Update which note is highlighted as "open" when the active tab changes,
    // and refresh the edit baseline — active-leaf-change (unlike file-open) also
    // fires when switching back to an already-open tab.
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", () => {
        this.setEditBaseline(this.app.workspace.getActiveFile());
        this.refreshOpenHighlights();
      })
    );

    // Save the open tabs before the app quits (and stop teardown from wiping
    // them). Tasks.add lets Obsidian await the final data-note write.
    this.registerEvent(
      this.app.workspace.on("quit", (tasks) => {
        this.unloading = true;
        this.saveActiveProjectTabs(true);

        // Close every non-active project pane so Obsidian only saves the
        // active pane's tabs to its workspace state.  Without this, every
        // pane visited during the session would be restored on next startup,
        // flooding the workspace with stale tabs before the plugin can clean
        // them up.
        const activeProject = this.getActiveProject();
        const activeKey = activeProject
          ? this.paneKey(activeProject.id, activeProject.activePaneId ?? null)
          : null;
        for (const [key, group] of [...this.projectGroups]) {
          if (key === activeKey) continue;
          const toClose: WorkspaceLeaf[] = [];
          this.app.workspace.iterateRootLeaves((leaf) => {
            if (this.leafInGroup(leaf, group)) toClose.push(leaf);
          });
          for (const leaf of toClose) leaf.detach();
          this.projectGroups.delete(key);
        }

        tasks.add(async () => {
          await this.persistNow();
        });
      })
    );

    // Add project-aware items to the native file/folder context menu and to
    // the tab right-click menu (source === 'tab-header').
    this.registerEvent(
      this.app.workspace.on("file-menu", (menu, file, source, leaf) => {
        const project = this.getActiveProject();
        if (!project) return;

        if (file instanceof TFolder) {
          if (project.folders.includes(file.path)) return;
          menu.addItem((i) =>
            i
              .setTitle(`Add folder to project "${project.name}"`)
              .setIcon("folder-plus")
              .onClick(() => void this.addFolderToProject(project, file))
          );
        } else if (file instanceof TFile) {
          // --- Tab right-click additions ---
          if (source === "tab-header" || source === "more-options") {
            menu.addSeparator();

            // Pin / Unpin
            const pinned = (project.pinned ?? []).includes(file.path);
            menu.addItem((i) =>
              i
                .setTitle(pinned ? "Unpin from top" : "Pin to top")
                .setIcon(pinned ? "pin-off" : "pin")
                .onClick(() => void this.togglePin(project, file.path))
            );

            // Reveal in the right pane
            menu.addItem((i) =>
              i
                .setTitle("Reveal in project pane")
                .setIcon("locate")
                .onClick(() => this.scrollToFileInContentView(file.path))
            );

            // Move to pane (only when named panes exist)
            if (project.panes.length > 0) {
              const currentPaneId = project.activePaneId ?? null;
              const destinations: { id: string | null; name: string }[] = [];
              if (currentPaneId !== null) {
                destinations.push({ id: null, name: "Main" });
              }
              for (const pane of project.panes) {
                if (pane.id !== currentPaneId) {
                  destinations.push({ id: pane.id, name: pane.name });
                }
              }
              if (destinations.length > 0) {
                menu.addSeparator();
                for (const dest of destinations) {
                  menu.addItem((i) =>
                    i
                      .setTitle(`Move to pane: ${dest.name}`)
                      .setIcon("panel-right-open")
                      .onClick(() =>
                        void this.moveTabToPane(
                          project,
                          file,
                          leaf ?? null,
                          dest.id
                        )
                      )
                  );
                }
              }
            }

            menu.addSeparator();
          }

          // "Add to project" — only when not already a member
          const isInProject =
            project.notes.includes(file.path) ||
            project.folders.some(
              (fp) => file.path === fp || file.path.startsWith(fp + "/")
            );
          if (!isInProject) {
            menu.addItem((i) =>
              i
                .setTitle(`Add note to project "${project.name}"`)
                .setIcon("file-plus")
                .onClick(() => void this.addNoteToProject(project, file))
            );
          }
        }
      })
    );

    this.app.workspace.onLayoutReady(() => {
      this.arrangeLeftSidebar();

      // Adopt Obsidian's restored tabs as the active project's pane so the
      // open + active notes are preserved across restarts.
      this.restoreOnStartup();

      // Keep the content pane in sync when notes are added/removed/renamed in
      // the vault (e.g. a new note created inside a project folder). Registered
      // after layout is ready so the initial "create" burst is not handled.
      this.registerEvent(this.app.vault.on("create", () => this.refreshContentView()));
      this.registerEvent(
        this.app.vault.on("delete", (file) => {
          this.pruneEditHistory(file.path);
          this.refreshContentView();
        })
      );
      this.registerEvent(
        this.app.vault.on("rename", (file, oldPath) => {
          this.handlePathRename(oldPath, file.path);
          this.refreshContentView();
          this.refreshEditView();
        })
      );
    });
  }

  onunload(): void {
    // On plugin disable, capture current tabs. On app quit the "quit" handler
    // already saved them (and the workspace may be torn down by now), so skip
    // re-capturing to avoid wiping the saved tabs with an empty set.
    if (!this.unloading) this.saveActiveProjectTabs(true);
    if (this.editSaveTimer !== null) {
      window.clearTimeout(this.editSaveTimer);
      this.editSaveTimer = null;
    }
    if (this.noteWriteTimer !== null) {
      window.clearTimeout(this.noteWriteTimer);
      this.noteWriteTimer = null;
    }
    void this.saveSettings();
    void this.writeDataNote();
  }

  /**
   * Load settings (from the plugin's data.json) and project data (from the
   * note inside the vault). Falls back to migrating legacy project data that
   * older versions stored in data.json.
   */
  async loadAll(): Promise<void> {
    const stored = ((await this.loadData()) ?? {}) as Partial<
      RecentViewSettings & RecentViewData & { editHistory: EditRecord[] }
    >;
    this.settings = {
      dataNotePath: stored.dataNotePath || DEFAULT_SETTINGS.dataNotePath,
      closePanesOnSwitch: stored.closePanesOnSwitch ?? DEFAULT_SETTINGS.closePanesOnSwitch,
      editHistorySize:
        typeof stored.editHistorySize === "number" && stored.editHistorySize > 0
          ? Math.floor(stored.editHistorySize)
          : DEFAULT_EDIT_HISTORY,
      trackWhitespaceEdits:
        stored.trackWhitespaceEdits ?? DEFAULT_SETTINGS.trackWhitespaceEdits,
      gdriveClientId: stored.gdriveClientId ?? "",
      gdriveClientSecret: stored.gdriveClientSecret ?? "",
      gdriveRefreshToken: stored.gdriveRefreshToken ?? "",
    };
    this.editHistory = Array.isArray(stored.editHistory)
      ? stored.editHistory
          .filter(
            (r): r is EditRecord =>
              !!r && typeof r.path === "string" && typeof r.line === "number"
          )
          .map((r) => ({ ...r, kind: r.kind ?? "modify", lastLine: r.lastLine ?? r.line }))
      : [];
    if (this.editHistory.length > this.editHistoryLimit()) {
      this.editHistory.length = this.editHistoryLimit();
    }

    let fromNote = await this.readDataNote();
    let needsWrite = false;
    // Migrate from the old default note name if the current one is missing.
    if (
      !fromNote &&
      this.settings.dataNotePath !== LEGACY_DATA_NOTE &&
      (await this.app.vault.adapter.exists(LEGACY_DATA_NOTE))
    ) {
      try {
        fromNote = parseDataNote(
          await this.app.vault.adapter.read(LEGACY_DATA_NOTE)
        );
      } catch {
        fromNote = null;
      }
      if (fromNote) needsWrite = true;
    }
    if (fromNote) {
      this.data = fromNote;
      if (needsWrite) await this.writeDataNote();
    } else if (stored.projects) {
      // Migrate project data that used to live in data.json into the note.
      this.data = {
        projects: stored.projects,
        activeProjectId: stored.activeProjectId ?? null,
      };
      await this.writeDataNote();
    } else {
      this.data = { projects: [], activeProjectId: null };
    }

    // Migrate lastOpenNotes from the old string[] format to OpenNote[].
    const migrateNotes = (list: unknown): OpenNote[] =>
      ((list ?? []) as (string | OpenNote)[]).map((n) =>
        typeof n === "string" ? { path: n } : n
      );
    for (const project of this.data.projects) {
      project.lastOpenNotes = migrateNotes(project.lastOpenNotes);
      project.lastClosedNotes = migrateNotes(project.lastClosedNotes);
      if (project.defaultTabs) project.defaultTabs = migrateNotes(project.defaultTabs);
      project.pinned = project.pinned ?? [];
      project.panes = (project.panes ?? []).map((p) => ({
        ...p,
        lastOpenNotes: migrateNotes(p.lastOpenNotes),
        lastClosedNotes: migrateNotes(p.lastClosedNotes),
        defaultTabs: p.defaultTabs ? migrateNotes(p.defaultTabs) : undefined,
      }));
      if (project.activePaneId === undefined) project.activePaneId = null;
    }
  }

  async readDataNote(): Promise<RecentViewData | null> {
    const path = this.settings.dataNotePath;
    const adapter = this.app.vault.adapter;
    if (!path || !(await adapter.exists(path))) return null;
    try {
      return parseDataNote(await adapter.read(path));
    } catch {
      return null;
    }
  }

  async writeDataNote(): Promise<void> {
    const path = this.settings.dataNotePath;
    if (!path) return;
    const adapter = this.app.vault.adapter;
    // Ensure the parent folder exists for nested paths.
    const slash = path.lastIndexOf("/");
    if (slash > 0) {
      const dir = path.slice(0, slash);
      if (!(await adapter.exists(dir))) await adapter.mkdir(dir);
    }
    await adapter.write(path, buildDataNote(this.data));
  }

  async saveSettings(): Promise<void> {
    await this.saveData({ ...this.settings, editHistory: this.editHistory });
  }

  /**
   * Persist settings immediately and schedule a debounced write of the project
   * data note (avoids hammering the vault/sync on every layout change).
   */
  async persist(): Promise<void> {
    await this.saveSettings();
    if (this.noteWriteTimer !== null) window.clearTimeout(this.noteWriteTimer);
    this.noteWriteTimer = window.setTimeout(() => {
      this.noteWriteTimer = null;
      void this.writeDataNote();
    }, 600);
  }

  /** Persist immediately, used for infrequent but important edits. */
  async persistNow(): Promise<void> {
    if (this.noteWriteTimer !== null) {
      window.clearTimeout(this.noteWriteTimer);
      this.noteWriteTimer = null;
    }
    await this.saveSettings();
    await this.writeDataNote();
  }

  getActiveProject(): Project | null {
    return (
      this.data.projects.find((p) => p.id === this.data.activeProjectId) ?? null
    );
  }

  async togglePin(project: Project, path: string): Promise<void> {
    if (!project.pinned) project.pinned = [];
    const i = project.pinned.indexOf(path);
    if (i >= 0) project.pinned.splice(i, 1);
    else project.pinned.push(path);
    await this.persistNow();
    this.refreshContentView();
  }

  /** Remove a folder from the project (does not delete it from the vault). */
  async removeFolderFromProject(
    project: Project,
    folderPath: string
  ): Promise<void> {
    project.folders = project.folders.filter((f) => f !== folderPath);
    await this.persistNow();
    this.refreshContentView();
  }

  /** Create an untitled note inside a folder and open it ready for naming. */
  async createNoteInFolder(folder: TFolder, name = ""): Promise<void> {
    const base = (name.trim() || "Untitled").replace(/[\\/:*?"<>|]/g, "_");
    const dir = folder.path === "/" ? "" : folder.path;
    let path = dir ? `${dir}/${base}.md` : `${base}.md`;
    let i = 1;
    while (this.app.vault.getAbstractFileByPath(path)) {
      path = dir ? `${dir}/${base} ${i}.md` : `${base} ${i}.md`;
      i++;
    }
    try {
      const file = await this.app.vault.create(path, "");
      this.focusActiveGroup();
      const leaf = this.app.workspace.getLeaf("tab");
      await leaf.openFile(file);
      // Focus the inline title so the user can name the note immediately.
      window.setTimeout(() => {
        const titleEl = leaf.view.containerEl.querySelector<HTMLElement>(
          ".inline-title"
        );
        if (titleEl) {
          titleEl.focus();
          activeDocument.getSelection()?.selectAllChildren(titleEl);
        }
      }, 50);
    } catch (e) {
      new Notice(`Couldn't create note: ${(e as Error).message}`);
    }
  }

  /**
   * Create an untitled note in the given folder, open it, and — if the folder
   * isn't already covered by a project folder — add the note to project.notes
   * so it appears in the right pane. When paneId is provided the note is
   * opened in that pane instead of the currently active one.
   */
  async createNoteForProject(
    project: Project,
    folder: TFolder,
    paneId?: string | null
  ): Promise<void> {
    const base = "Untitled";
    const dir = folder.path === "/" ? "" : folder.path;
    let path = dir ? `${dir}/${base}.md` : `${base}.md`;
    let i = 1;
    while (this.app.vault.getAbstractFileByPath(path)) {
      path = dir ? `${dir}/${base} ${i}.md` : `${base} ${i}.md`;
      i++;
    }
    try {
      const file = await this.app.vault.create(path, "");
      const insideProjectFolder = project.folders.some(
        (fp) => file.path === fp || file.path.startsWith(fp + "/")
      );
      if (!insideProjectFolder && !project.notes.includes(file.path)) {
        project.notes.push(file.path);
        await this.persistNow();
        this.refreshContentView();
      }
      if (paneId !== undefined) {
        await this.showPane(project, paneId);
      }
      this.focusActiveGroup();
      const leaf = this.app.workspace.getLeaf("tab");
      await leaf.openFile(file);
      window.setTimeout(() => {
        const titleEl = leaf.view.containerEl.querySelector<HTMLElement>(
          ".inline-title"
        );
        if (titleEl) {
          titleEl.focus();
          activeDocument.getSelection()?.selectAllChildren(titleEl);
        }
      }, 50);
    } catch (e) {
      new Notice(`Couldn't create note: ${(e as Error).message}`);
    }
  }

  /** Create a new folder inside parentFolder with the given name.
   *  If a project is given and the new folder falls outside its existing
   *  folders, add it to project.folders so it appears in the right pane. */
  async createFolder(parentFolder: TFolder, name: string, project?: Project): Promise<void> {
    const sanitized = name.trim().replace(/[\\:*?"<>|]/g, "_");
    if (!sanitized) {
      new Notice("Folder name is required.");
      return;
    }
    const dir = parentFolder.path === "/" ? "" : parentFolder.path;
    const path = dir ? `${dir}/${sanitized}` : sanitized;
    if (this.app.vault.getAbstractFileByPath(path)) {
      new Notice(`Folder "${sanitized}" already exists.`);
      return;
    }
    try {
      await this.app.vault.createFolder(path);
      if (project) {
        const insideProjectFolder = project.folders.some(
          (fp) => path === fp || path.startsWith(fp + "/")
        );
        if (!insideProjectFolder && !project.folders.includes(path)) {
          project.folders.push(path);
          await this.persistNow();
          this.refreshContentView();
        }
      }
    } catch (e) {
      new Notice(`Couldn't create folder: ${(e as Error).message}`);
    }
  }

  async addFolderToProject(project: Project, folder: TFolder): Promise<void> {
    if (!project.folders.includes(folder.path)) {
      project.folders.push(folder.path);
      await this.persistNow();
      this.refreshContentView();
      return;
    }
    new Notice("Folder is already in this project.");
  }

  async addNoteToProject(project: Project, file: TFile): Promise<void> {
    if (!project.notes.includes(file.path)) {
      project.notes.push(file.path);
      await this.persistNow();
      this.refreshContentView();
      return;
    }
    new Notice("Note is already in this project.");
  }

  /** Update stored paths across all projects when a file/folder is renamed. */
  private handlePathRename(oldPath: string, newPath: string): void {
    const remap = (p: string): string => {
      if (p === oldPath) return newPath;
      if (p.startsWith(oldPath + "/")) return newPath + p.slice(oldPath.length);
      return p;
    };
    let changed = false;
    const track = (before: string, after: string) => {
      if (before !== after) changed = true;
      return after;
    };
    const remapNotes = (list: OpenNote[]): OpenNote[] =>
      list.map((n) => ({ ...n, path: track(n.path, remap(n.path)) }));
    for (const project of this.data.projects) {
      project.folders = project.folders.map((f) => track(f, remap(f)));
      project.notes = project.notes.map((n) => track(n, remap(n)));
      project.pinned = (project.pinned ?? []).map((p) => track(p, remap(p)));
      project.lastOpenNotes = remapNotes(project.lastOpenNotes);
      project.lastClosedNotes = remapNotes(project.lastClosedNotes ?? []);
      for (const pane of project.panes ?? []) {
        pane.lastOpenNotes = remapNotes(pane.lastOpenNotes);
        pane.lastClosedNotes = remapNotes(pane.lastClosedNotes ?? []);
      }
    }
    this.editHistory = this.editHistory.map((r) => ({
      ...r,
      path: track(r.path, remap(r.path)),
    }));
    if (changed) void this.persist();
  }

  /** Set the order of pinned notes. */
  async setPinnedOrder(project: Project, orderedPaths: string[]): Promise<void> {
    project.pinned = applyOrder(project.pinned ?? [], (p) => p, orderedPaths);
    await this.persistNow();
    this.refreshContentView();
  }

  /** Set the order of projects in the left pane. */
  async setProjectOrder(orderedIds: string[]): Promise<void> {
    this.data.projects = applyOrder(this.data.projects, (p) => p.id, orderedIds);
    await this.persistNow();
    this.refreshListView();
  }

  /** Set the order of a project's named panes. */
  async setPaneOrder(project: Project, orderedIds: string[]): Promise<void> {
    project.panes = applyOrder(project.panes, (p) => p.id, orderedIds);
    await this.persistNow();
    this.refreshContentView();
  }

  async activateListView(): Promise<void> {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(VIEW_TYPE_PROJECT_LIST)[0];
    if (!leaf) {
      // Place the Projects list directly above the native File Explorer so the
      // explorer sits at the bottom of the left sidebar.
      const fileExplorer = workspace.getLeavesOfType("file-explorer")[0];
      if (fileExplorer) {
        leaf = workspace.createLeafBySplit(fileExplorer, "horizontal", true);
      } else {
        const left = workspace.getLeftLeaf(false);
        if (!left) return;
        leaf = left;
      }
      await leaf.setViewState({ type: VIEW_TYPE_PROJECT_LIST, active: true });
    }
    await workspace.revealLeaf(leaf);
  }

  /**
   * Dock the Projects list above the native File Explorer in the left sidebar
   * (so the explorer is at the bottom). Re-creates the list leaf in the right
   * spot; the list view is rebuilt from data so nothing is lost.
   */
  arrangeLeftSidebar(): void {
    const { workspace } = this.app;
    const fileExplorer = workspace.getLeavesOfType("file-explorer")[0];
    if (!fileExplorer) {
      void this.activateListView();
      void this.activateEditsView();
      return;
    }
    for (const l of workspace.getLeavesOfType(VIEW_TYPE_PROJECT_LIST)) {
      l.detach();
    }
    for (const l of workspace.getLeavesOfType(VIEW_TYPE_RECENT_EDITS)) {
      l.detach();
    }
    // Projects list directly above the file explorer.
    const listLeaf = workspace.createLeafBySplit(fileExplorer, "horizontal", true);
    // Recent edits as a sibling tab in the SAME group as the Projects list.
    const parent = listLeaf.parent as unknown as WorkspaceSplit;
    const editsLeaf = workspace.createLeafInParent(parent, 1);
    void editsLeaf.setViewState({ type: VIEW_TYPE_RECENT_EDITS, active: false });
    // Show the Projects pane as the active tab at startup.
    void (async () => {
      await listLeaf.setViewState({
        type: VIEW_TYPE_PROJECT_LIST,
        active: true,
      });
      await workspace.revealLeaf(listLeaf);
    })();
  }

  async activateEditsView(): Promise<void> {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(VIEW_TYPE_RECENT_EDITS)[0];
    if (!leaf) {
      // Add it as a sibling tab in the Projects list's group when that exists,
      // otherwise just open a left-sidebar leaf.
      const listLeaf = workspace.getLeavesOfType(VIEW_TYPE_PROJECT_LIST)[0];
      if (listLeaf) {
        const parent = listLeaf.parent as unknown as WorkspaceSplit;
        leaf = workspace.createLeafInParent(parent, 1);
      } else {
        const left = workspace.getLeftLeaf(false);
        if (!left) return;
        leaf = left;
      }
      await leaf.setViewState({ type: VIEW_TYPE_RECENT_EDITS, active: true });
    }
    await workspace.revealLeaf(leaf);
  }

  refreshEditView(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_RECENT_EDITS)) {
      if (leaf.view instanceof RecentEditsView) leaf.view.render();
    }
  }

  private editHistoryLimit(): number {
    const n = Math.floor(this.settings.editHistorySize);
    return Number.isFinite(n) && n > 0 ? n : DEFAULT_EDIT_HISTORY;
  }

  private activeMarkdownEditor(): Editor | null {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    return view ? view.editor : null;
  }

  /** Snapshot the document on open; resume the live edit if it's this note's. */
  private setEditBaseline(file: TFile | null): void {
    if (!file || file.path === this.settings.dataNotePath) {
      this.editBaselinePath = null;
      this.lastEditDoc = "";
      this.editRegionActive = false;
      return;
    }
    const editor = this.activeMarkdownEditor();
    this.editBaselinePath = file.path;
    this.lastEditDoc = editor ? editor.getValue() : "";
    // Continue the same edit if the top row is this note's tracked live region
    // (e.g. after switching to another tab and back), so an adjacent edit merges.
    const top = this.editHistory[0];
    this.editRegionActive =
      !!top && top.path === file.path && this.editBaselineByRecord.has(top);
  }

  /**
   * Record an edit live. Line adjacency — not time — separates edits: changes on
   * a line within (or next to) the live edit's range extend it; a change on a
   * non-adjacent line starts a new edit.
   */
  private onEditorChange(editor: Editor, file: TFile): void {
    // Ignore edits to the plugin's own data note.
    if (file.path === this.settings.dataNotePath) return;
    const current = editor.getValue();
    const cursor = editor.getCursor();
    const line = cursor.line;
    const top = this.editHistory[0];
    const sameNote = !!top && top.path === file.path;
    const lo = top ? Math.min(top.line, top.lastLine) : 0;
    const hi = top ? Math.max(top.line, top.lastLine) : 0;
    const adjacent = sameNote && line >= lo - 1 && line <= hi + 1;

    // Switched to a different file than last tracked (e.g. a tab switch where no
    // event refreshed the baseline). Resume this note's live edit when the change
    // is adjacent; otherwise snapshot and wait (we lack the pre-change document).
    if (this.editBaselinePath !== file.path) {
      this.editBaselinePath = file.path;
      this.lastEditDoc = current;
      const canResume =
        !!top && sameNote && adjacent && this.editBaselineByRecord.has(top);
      this.editRegionActive = canResume;
      if (!canResume) return;
    }

    // Extend the live edit only while it's active and on an adjacent line.
    const extend = !!top && this.editRegionActive && sameNote && adjacent;

    // Baseline: an extended edit keeps its original starting document (so the
    // edit stays "the same" across tab switches); a new edit starts from the
    // document just before this change.
    const baseline =
      extend && top
        ? this.editBaselineByRecord.get(top) ?? this.lastEditDoc
        : this.lastEditDoc;

    // Categorize the single edit by its net change: where it started (its
    // baseline) vs the finished version (current).
    const { added, removed, start, endNew } = diffEdit(baseline, current);
    if (!added && !removed) {
      this.lastEditDoc = current;
      // The edit was undone back to its starting version (e.g. added a line then
      // deleted it): drop the now-cancelled live row.
      if (this.editRegionActive && this.editHistory.length > 0) {
        this.editHistory.shift();
        this.editRegionActive = false;
        this.refreshEditView();
        this.scheduleEditSave();
      }
      return;
    }
    // Whitespace-only changes are recorded only when the setting is enabled.
    const hasText = /\S/.test(added) || /\S/.test(removed);
    if (!hasText && !this.settings.trackWhitespaceEdits) {
      this.lastEditDoc = current;
      return;
    }
    let kind: EditKind;
    let raw: string;
    if (added && removed) {
      kind = "modify";
      raw = added;
    } else if (removed) {
      kind = "delete";
      raw = removed;
    } else {
      kind = "add";
      raw = added;
    }
    const text = editSnippet(raw);
    const now = Date.now();
    // Exact range of the added/modified text in the current document, so a click
    // can select all of it (across lines). Deletions have no remaining text.
    let sel: EditSel | undefined;
    if (kind !== "delete") {
      const fromPos = editor.offsetToPos(start);
      const toPos = editor.offsetToPos(endNew);
      sel = {
        fromLine: fromPos.line,
        fromCh: fromPos.ch,
        toLine: toPos.line,
        toCh: toPos.ch,
      };
    }

    if (extend && top) {
      // Update the live edit in place (delta recomputed from its baseline).
      top.text = text;
      top.kind = kind;
      top.line = Math.min(lo, line);
      top.lastLine = Math.max(hi, line);
      top.ch = cursor.ch;
      top.time = now;
      top.sel = sel;
    } else if (top && sameNote && top.text === text) {
      // Neighbouring edit with the same selected text: merge, moving the row to
      // this spot and making it the live edit again.
      top.line = line;
      top.lastLine = line;
      top.ch = cursor.ch;
      top.time = now;
      top.sel = sel;
      if (top.kind !== kind) top.kind = "modify";
      this.editRegionActive = true;
      this.editBaselineByRecord.set(top, baseline);
    } else {
      const record: EditRecord = {
        path: file.path,
        text,
        kind,
        line,
        lastLine: line,
        ch: cursor.ch,
        time: now,
        sel,
      };
      this.pushEdit(record);
      this.editRegionActive = true;
      this.editBaselineByRecord.set(record, baseline);
    }
    this.lastEditDoc = current;
    this.refreshEditView();
    this.scheduleEditSave();
  }

  /** Add an edit as its own row at the top (notes may appear multiple times). */
  private pushEdit(edit: EditRecord): void {
    this.editHistory.unshift(edit);
    const max = this.editHistoryLimit();
    if (this.editHistory.length > max) this.editHistory.length = max;
  }

  private scheduleEditSave(): void {
    if (this.editSaveTimer !== null) window.clearTimeout(this.editSaveTimer);
    this.editSaveTimer = window.setTimeout(() => {
      this.editSaveTimer = null;
      void this.saveSettings();
    }, 1500);
  }

  /** Drop history entries for a deleted file (and its descendants). */
  private pruneEditHistory(deletedPath: string): void {
    const before = this.editHistory.length;
    this.editHistory = this.editHistory.filter(
      (r) => r.path !== deletedPath && !r.path.startsWith(deletedPath + "/")
    );
    if (this.editHistory.length !== before) {
      this.refreshEditView();
      void this.saveSettings();
    }
  }

  async clearEditHistory(): Promise<void> {
    this.editHistory = [];
    this.editRegionActive = false;
    this.refreshEditView();
    await this.saveSettings();
  }

  /** Open the note for an edit and select + center the edited line. */
  async openEditRecord(record: EditRecord): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(record.path);
    if (!(file instanceof TFile)) {
      new Notice("That note no longer exists.");
      this.pruneEditHistory(record.path);
      return;
    }
    const { workspace } = this.app;
    const group = this.getActiveGroup();
    // Reuse an existing tab for this file in the active pane, else open one.
    let existing: WorkspaceLeaf | null = null;
    if (group) {
      workspace.iterateRootLeaves((l) => {
        if (
          !existing &&
          this.leafInGroup(l, group) &&
          l.getViewState().state?.file === file.path
        ) {
          existing = l;
        }
      });
    }
    let leaf: WorkspaceLeaf;
    if (existing) {
      leaf = existing;
      workspace.setActiveLeaf(leaf, { focus: true });
    } else {
      if (group) this.focusActiveGroup();
      leaf = workspace.getLeaf("tab");
      await leaf.openFile(file);
    }
    this.revealEditInLeaf(leaf, record);
  }

  /** Scroll to the edit, centered. Selects the whole added/modified text range;
   *  a deletion just places the cursor (its text is gone, nothing to select). */
  private revealEditInLeaf(leaf: WorkspaceLeaf, record: EditRecord): void {
    window.setTimeout(() => {
      const view = leaf.view;
      if (!(view instanceof MarkdownView)) return;
      const editor = view.editor;
      const lastLine = editor.lastLine();
      const clamp = (ln: number, ch: number) => {
        const l = Math.min(Math.max(ln, 0), lastLine);
        return { line: l, ch: Math.min(Math.max(ch, 0), editor.getLine(l).length) };
      };
      if (record.kind === "delete") {
        const pos = clamp(record.line, 0);
        editor.setCursor(pos);
        editor.scrollIntoView({ from: pos, to: pos }, true);
      } else {
        // Use the exact added/modified range when available, else the line.
        const from = record.sel
          ? clamp(record.sel.fromLine, record.sel.fromCh)
          : clamp(record.line, 0);
        const to = record.sel
          ? clamp(record.sel.toLine, record.sel.toCh)
          : clamp(record.line, editor.getLine(clamp(record.line, 0).line).length);
        editor.setSelection(from, to);
        editor.scrollIntoView({ from, to }, true);
      }
      editor.focus();
    }, 60);
  }

  async activateContentView(): Promise<void> {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(VIEW_TYPE_PROJECT_CONTENT)[0];
    if (!leaf) {
      const right = workspace.getRightLeaf(false);
      if (!right) return;
      leaf = right;
      await leaf.setViewState({
        type: VIEW_TYPE_PROJECT_CONTENT,
        active: true,
      });
    }
    await workspace.revealLeaf(leaf);
    this.refreshContentView();
  }

  refreshListView(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(
      VIEW_TYPE_PROJECT_LIST
    )) {
      if (leaf.view instanceof ProjectListView) leaf.view.render();
    }
  }

  refreshContentView(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(
      VIEW_TYPE_PROJECT_CONTENT
    )) {
      if (leaf.view instanceof ProjectContentView) leaf.view.render();
    }
  }

  /** Scroll the right pane to the item for `path` (no-op if not rendered). */
  scrollToFileInContentView(path: string): void {
    for (const leaf of this.app.workspace.getLeavesOfType(
      VIEW_TYPE_PROJECT_CONTENT
    )) {
      if (leaf.view instanceof ProjectContentView) {
        leaf.view.scrollToFile(path);
      }
    }
  }

  /** Update only the open-note highlights (no full re-render). */
  refreshOpenHighlights(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(
      VIEW_TYPE_PROJECT_CONTENT
    )) {
      if (leaf.view instanceof ProjectContentView) {
        leaf.view.updateOpenHighlights();
      }
    }
  }

  /**
   * Open a project: show its live pane (tab group), creating it from the saved
   * notes the first time. Other projects' panes are hidden, not closed, so
   * their tabs keep their full editor state.
   */
  async openProject(project: Project): Promise<void> {
    // Record the project we're leaving so the back button can return to it.
    const current = this.data.activeProjectId;
    if (current && current !== project.id) {
      this.navHistory.push(current);
      if (this.navHistory.length > 50) this.navHistory.shift();
    }
    await this.showPane(project, project.activePaneId ?? null);
  }

  /**
   * On startup, wait for Obsidian to finish restoring its layout, then adopt
   * the active project's existing main tab group WITHOUT detaching anything
   * (so restored tabs aren't lost). Only if the pane is genuinely empty do we
   * reopen the project's saved tabs.
   */
  private restoreOnStartup(): void {
    // Hide the main area immediately so the restored split panes never show
    // while we rebuild the active project's pane.
    const rootEl = (
      this.app.workspace.rootSplit as unknown as { containerEl?: HTMLElement }
    ).containerEl;
    if (rootEl) rootEl.addClass("rv-hidden");
    window.setTimeout(() => void this.settleStartup(rootEl), 300);
  }

  private async settleStartup(rootEl: HTMLElement | undefined): Promise<void> {
    try {
      await this.settleStartupInner();
      // Obsidian may keep restoring panes after onLayoutReady; wait, then drop
      // any stray panes that aren't part of the active project's pane.
      await new Promise((r) => window.setTimeout(r, 500));
      this.cleanupStrayPanes();
    } finally {
      // Keep ignoring layout-change until consolidation is fully done.
      this.starting = false;
      if (rootEl) rootEl.removeClass("rv-hidden");
    }
  }

  /** Detach any main-area leaf that isn't part of the active project's pane. */
  private cleanupStrayPanes(): void {
    const group = this.getActiveGroup();
    if (!group) return;
    const stray: WorkspaceLeaf[] = [];
    this.app.workspace.iterateRootLeaves((leaf) => {
      if (!this.leafInGroup(leaf, group)) stray.push(leaf);
    });
    for (const leaf of stray) leaf.detach();

    // Obsidian's async workspace restoration can inject leaves into the only
    // surviving group after we already rebuilt it, causing:
    //   (a) duplicate tabs  — same file opened twice, and
    //   (b) foreign tabs    — files from other projects/panes.
    // Both also corrupt tab order because the injected leaves can land between
    // the ones we opened. Fix by keeping ONLY the exact leaf objects we opened
    // (by identity), which preserves their original positions and order.
    const toKeep = this._startupOpenedLeaves
      ? new Set(this._startupOpenedLeaves)
      : null;
    this._startupOpenedLeaves = null;

    if (toKeep !== null) {
      const toRemove: WorkspaceLeaf[] = [];
      this.app.workspace.iterateRootLeaves((leaf) => {
        if (!this.leafInGroup(leaf, group)) return;
        if (!toKeep.has(leaf)) toRemove.push(leaf);
      });
      for (const leaf of toRemove) leaf.detach();
    } else {
      // Fallback (no startup tracking info): remove foreign paths and dupes.
      const project = this.getActiveProject();
      const paneId = project?.activePaneId ?? null;
      const expectedPaths = project
        ? new Set(this.resolveNotes(this.paneNotes(project, paneId)).map((n) => n.file.path))
        : null;
      const seenPaths = new Set<string>();
      const toRemove: WorkspaceLeaf[] = [];
      this.app.workspace.iterateRootLeaves((leaf) => {
        if (!this.leafInGroup(leaf, group)) return;
        const path = leaf.getViewState().state?.file;
        if (typeof path !== "string") return;
        if ((expectedPaths && !expectedPaths.has(path)) || seenPaths.has(path)) {
          toRemove.push(leaf);
        } else {
          seenPaths.add(path);
        }
      });
      for (const leaf of toRemove) leaf.detach();
    }
  }

  private async settleStartupInner(): Promise<void> {
    const active = this.getActiveProject();
    if (!active) return;
    const ws = this.app.workspace;
    const paneId = active.activePaneId ?? null;

    // Obsidian restores every pane from the last session (one per project
    // visited) as separate splits. Those tabs belong to different projects, so
    // instead of merging them, close them all and rebuild just the active
    // project's pane from its own saved tabs (others rebuild when opened).
    this.isActivating = true;
    const existing: WorkspaceLeaf[] = [];
    ws.iterateRootLeaves((leaf) => existing.push(leaf));
    const keep = existing[0] ?? ws.getLeaf(false);
    for (const leaf of existing) if (leaf !== keep) leaf.detach();
    this.projectGroups.set(this.paneKey(active.id, paneId), keep.parent as unknown as WorkspaceParent);

    const notes = this.resolveNotes(this.paneNotes(active, paneId));
    if (notes.length === 0) {
      await keep.setViewState({ type: "empty" });
      this._startupOpenedLeaves = [keep];
    } else {
      const opened: WorkspaceLeaf[] = [];
      let first = true;
      for (const note of notes) {
        let leaf: WorkspaceLeaf;
        if (first) {
          leaf = keep;
          first = false;
        } else {
          // Anchor off the previous leaf, not keep. Whether getLeaf("tab")
          // inserts after the active tab or at the end of the group, this
          // guarantees tabs appear in the saved order.
          ws.setActiveLeaf(opened[opened.length - 1], { focus: false });
          leaf = ws.getLeaf("tab");
        }
        await leaf.openFile(note.file, { eState: note.eState });
        opened.push(leaf);
      }
      const activeIdx = notes.findIndex((n) => n.active);
      ws.setActiveLeaf(opened[activeIdx >= 0 ? activeIdx : 0], { focus: true });
      this._startupOpenedLeaves = opened;
    }

    this.applyGroupVisibility(this.paneKey(active.id, paneId));
    this.refreshListView();
    void this.activateContentView();
    window.setTimeout(() => {
      this.isActivating = false;
    }, 150);
  }

  canGoBack(): boolean {
    return this.navHistory.length > 0;
  }

  /** Return to the most recently selected project. */
  async goBack(): Promise<void> {
    while (this.navHistory.length > 0) {
      const id = this.navHistory.pop();
      const project = this.data.projects.find((p) => p.id === id);
      if (project && project.id !== this.data.activeProjectId) {
        // showPane (not openProject) so we don't push history again.
        await this.showPane(project, project.activePaneId ?? null);
        return;
      }
    }
    new Notice("No previous project.");
  }

  /** Unique key for a project's pane (main pane uses just the project id). */
  private paneKey(projectId: string, paneId: string | null): string {
    return paneId ? `${projectId}::${paneId}` : projectId;
  }

  /** The open-tabs list for a given pane (main pane stored on the project). */
  private paneNotes(project: Project, paneId: string | null): OpenNote[] {
    if (!paneId) return project.lastOpenNotes;
    return project.panes.find((p) => p.id === paneId)?.lastOpenNotes ?? [];
  }

  /** Recently closed notes for a pane, newest first. */
  private paneClosedNotes(project: Project, paneId: string | null): OpenNote[] {
    if (!paneId) return project.lastClosedNotes ?? [];
    return project.panes.find((p) => p.id === paneId)?.lastClosedNotes ?? [];
  }

  lastClosedNote(project: Project, paneId: string | null): OpenNote | null {
    return this.paneClosedNotes(project, paneId)[0] ?? null;
  }

  private setPaneNotes(
    project: Project,
    paneId: string | null,
    notes: OpenNote[]
  ): void {
    if (!paneId) {
      project.lastOpenNotes = notes;
      return;
    }
    const pane = project.panes.find((p) => p.id === paneId);
    if (pane) pane.lastOpenNotes = notes;
  }

  private setPaneClosedNotes(
    project: Project,
    paneId: string | null,
    notes: OpenNote[]
  ): void {
    if (!paneId) {
      project.lastClosedNotes = notes;
      return;
    }
    const pane = project.panes.find((p) => p.id === paneId);
    if (pane) pane.lastClosedNotes = notes;
  }

  private recordClosedNotes(
    project: Project,
    paneId: string | null,
    closed: OpenNote[]
  ): void {
    if (closed.length === 0) return;
    const existing = this.paneClosedNotes(project, paneId);
    const next: OpenNote[] = [];
    for (const note of [...closed].reverse()) {
      if (!next.some((n) => n.path === note.path)) {
        next.push({ ...note, active: true });
      }
    }
    for (const note of existing) {
      if (!next.some((n) => n.path === note.path)) next.push(note);
    }
    this.setPaneClosedNotes(project, paneId, next.slice(0, 20));
  }

  /**
   * Show a specific pane of a project: hide every other pane, restore (or
   * create) this one's tab group.
   */
  async showPane(project: Project, paneId: string | null): Promise<void> {
    // Bump the generation NOW (synchronously) so any in-flight build sees it
    // and aborts at its next checkpoint instead of finishing the old project.
    const gen = ++this._showPaneGen;
    // Serialize switches: a rapid second click waits for the in-flight switch
    // to finish aborting rather than running concurrently. Concurrent runs
    // would each call createPaneGroup and leave two panes side by side.
    this._pendingSwitches++;
    const run = this._switchQueue
      .catch(() => {})
      .then(() => this.showPaneImpl(project, paneId, gen))
      .finally(() => {
        this._pendingSwitches--;
      });
    this._switchQueue = run;
    return run;
  }

  private async showPaneImpl(
    project: Project,
    paneId: string | null,
    gen: number
  ): Promise<void> {
    // Snapshot the currently visible pane before switching away.
    this.saveActiveProjectTabs();

    this.isActivating = true;
    this.data.activeProjectId = project.id;
    project.activePaneId = paneId;

    // Update the selection UI synchronously.
    this.refreshListView();
    void this.activateContentView();

    const key = this.paneKey(project.id, paneId);
    const rootEl = (
      this.app.workspace.rootSplit as unknown as { containerEl?: HTMLElement }
    ).containerEl;
    try {
      let group = this.getLiveGroup(key);
      if (!group) {
        // Hide the root while building so the new split never appears alongside
        // the current pane during the async openFile sequence.
        if (rootEl) rootEl.addClass("rv-hidden");
        group = await this.createPaneGroup(project, paneId, gen);
      }
      // A newer click arrived while we were building; createPaneGroup already
      // tore down its partial work. Stop here and let that switch take over
      // (leaving the root hidden so it can finish without a flash).
      if (gen !== this._showPaneGen) return;
      if (group) {
        this.projectGroups.set(key, group);
        this.focusGroup(group);
        if (this.settings.closePanesOnSwitch) {
          // Close all other pane groups now that the new group is established.
          // Closing AFTER createPaneGroup lets it anchor the split position
          // off existing groups, so the new group lands in the root split.
          for (const [k, otherGroup] of [...this.projectGroups]) {
            if (k === key) continue;
            const toClose: WorkspaceLeaf[] = [];
            this.app.workspace.iterateRootLeaves((leaf) => {
              if (this.leafInGroup(leaf, otherGroup)) toClose.push(leaf);
            });
            for (const leaf of toClose) leaf.detach();
            this.projectGroups.delete(k);
          }
        } else {
          // Keep panes alive: hide inactive groups with CSS for instant switching.
          this.applyGroupVisibility(key);
        }
      }
    } catch (e) {
      console.error("[RecentView] failed to open pane", e);
    } finally {
      // Only reveal the root if this switch is still the latest; a superseding
      // switch keeps it hidden and reveals it once it finishes.
      if (gen === this._showPaneGen && rootEl) rootEl.removeClass("rv-hidden");
    }

    await this.persist();

    // Release the guard after the layout settles, but only once no further
    // switch is queued — otherwise a stale timer would re-enable layout
    // handling in the middle of the next switch.
    window.setTimeout(() => {
      if (this._pendingSwitches === 0) this.isActivating = false;
    }, 150);
  }

  /** Build a new tab group for a pane from its saved notes. */
  private async createPaneGroup(
    project: Project,
    paneId: string | null,
    gen: number
  ): Promise<WorkspaceParent | null> {
    const notes = this.resolveNotes(this.paneNotes(project, paneId));
    const { workspace } = this.app;

    let firstLeaf: WorkspaceLeaf;
    if (!this.hasAnyLiveGroup()) {
      // No pane exists yet: adopt the current main area by keeping one leaf (so
      // a tab group survives) and closing the rest.
      const existing: WorkspaceLeaf[] = [];
      workspace.iterateRootLeaves((leaf) => {
        existing.push(leaf);
      });
      firstLeaf = existing[0] ?? workspace.getLeaf(false);
      for (const leaf of existing) if (leaf !== firstLeaf) leaf.detach();
    } else {
      // Another pane is visible: create a brand new tab group beside it. Make a
      // main-area leaf active first so the split lands in the root, not a side-
      // bar.
      const mru = workspace.getMostRecentLeaf(workspace.rootSplit);
      if (mru) workspace.setActiveLeaf(mru, { focus: false });
      firstLeaf = workspace.getLeaf("split");
    }

    if (notes.length === 0) {
      await firstLeaf.setViewState({ type: "empty" });
      return firstLeaf.parent;
    }

    const opened: WorkspaceLeaf[] = [firstLeaf];
    await firstLeaf.openFile(notes[0].file, { eState: notes[0].eState });
    for (let i = 1; i < notes.length; i++) {
      // A newer switch was requested: stop building, tear down what we opened
      // so no half-built pane lingers, and signal the caller to abort.
      if (gen !== this._showPaneGen) {
        for (const leaf of opened) leaf.detach();
        return null;
      }
      workspace.setActiveLeaf(opened[opened.length - 1], { focus: false });
      const leaf = workspace.getLeaf("tab");
      await leaf.openFile(notes[i].file, { eState: notes[i].eState });
      opened.push(leaf);
    }
    // One last check before we commit the finished group.
    if (gen !== this._showPaneGen) {
      for (const leaf of opened) leaf.detach();
      return null;
    }
    const activeIndex = notes.findIndex((n) => n.active);
    workspace.setActiveLeaf(opened[activeIndex >= 0 ? activeIndex : 0], {
      focus: true,
    });
    return firstLeaf.parent;
  }

  private resolveNotes(list: OpenNote[]): {
    file: TFile;
    eState: Record<string, unknown> | undefined;
    active: boolean;
  }[] {
    return list
      .map((n) => ({
        file: this.app.vault.getAbstractFileByPath(n.path),
        eState: n.eState,
        active: n.active === true,
      }))
      .filter(
        (n): n is {
          file: TFile;
          eState: Record<string, unknown> | undefined;
          active: boolean;
        } => n.file instanceof TFile
      );
  }

  /** Create a new empty pane for a project and switch to it. */
  async addPane(project: Project, name: string): Promise<void> {
    const pane: ProjectPane = {
      id: genId(),
      name: name.trim() || `Pane ${project.panes.length + 1}`,
      lastOpenNotes: [],
      lastClosedNotes: [],
    };
    project.panes.push(pane);
    await this.persistNow();
    await this.showPane(project, pane.id);
  }

  async renamePaneItem(
    project: Project,
    paneId: string,
    name: string
  ): Promise<void> {
    const pane = project.panes.find((p) => p.id === paneId);
    if (!pane) return;
    pane.name = name.trim() || pane.name;
    await this.persistNow();
    this.refreshContentView();
  }

  async deletePaneItem(project: Project, paneId: string): Promise<void> {
    const key = this.paneKey(project.id, paneId);
    const group = this.projectGroups.get(key);
    if (group) {
      const toClose: WorkspaceLeaf[] = [];
      this.app.workspace.iterateRootLeaves((leaf) => {
        if (this.leafInGroup(leaf, group)) toClose.push(leaf);
      });
      for (const leaf of toClose) leaf.detach();
      this.projectGroups.delete(key);
    }
    project.panes = project.panes.filter((p) => p.id !== paneId);
    await this.persistNow();
    // If the deleted pane was active, fall back to the main pane.
    if (project.activePaneId === paneId) {
      await this.showPane(project, null);
    } else {
      this.refreshContentView();
    }
  }

  /** Switch to a pane and open all markdown notes in a folder as tabs in it. */
  async openFolderInPane(
    project: Project,
    paneId: string | null,
    folder: TFolder
  ): Promise<void> {
    const files: TFile[] = [];
    Vault.recurseChildren(folder, (f) => {
      if (f instanceof TFile && f.extension === "md") files.push(f);
    });
    files.sort((a, b) => a.basename.localeCompare(b.basename));
    await this.showPane(project, paneId);
    await this.openFilesInActivePane(files);
  }

  /** Switch to a pane and open a single note in it. */
  async openNoteInPane(
    project: Project,
    paneId: string | null,
    file: TFile
  ): Promise<void> {
    await this.showPane(project, paneId);
    await this.openFilesInActivePane([file]);
  }

  /** Switch to a pane and reopen its most recently closed note. */
  async openLastClosedInPane(
    project: Project,
    paneId: string | null
  ): Promise<void> {
    const closed = [...this.paneClosedNotes(project, paneId)];
    while (closed.length > 0) {
      const note = closed.shift();
      if (!note) break;
      const file = this.app.vault.getAbstractFileByPath(note.path);
      if (!(file instanceof TFile)) continue;

      this.setPaneClosedNotes(project, paneId, closed);
      await this.showPane(project, paneId);
      await this.openNoteStateInActivePane(note, file);
      this.saveActiveProjectTabs(true);
      await this.persistNow();
      return;
    }

    this.setPaneClosedNotes(project, paneId, []);
    await this.persistNow();
    new Notice("No recently closed tab for this pane.");
  }

  private async openNoteStateInActivePane(
    note: OpenNote,
    file: TFile
  ): Promise<void> {
    const group = this.getActiveGroup();
    if (!group) return;
    this.focusActiveGroup();
    let existing: WorkspaceLeaf | null = null;
    this.app.workspace.iterateRootLeaves((leaf) => {
      if (
        !existing &&
        this.leafInGroup(leaf, group) &&
        leaf.getViewState().state?.file === file.path
      ) {
        existing = leaf;
      }
    });
    if (existing) {
      this.app.workspace.setActiveLeaf(existing, { focus: true });
      return;
    }
    await this.app.workspace
      .getLeaf("tab")
      .openFile(file, { eState: note.eState });
  }

  private async openFilesInActivePane(files: TFile[]): Promise<void> {
    const group = this.getActiveGroup();
    if (!group) return;
    this.focusActiveGroup();
    for (const file of files) {
      let existing: WorkspaceLeaf | null = null;
      this.app.workspace.iterateRootLeaves((leaf) => {
        if (
          !existing &&
          this.leafInGroup(leaf, group) &&
          leaf.getViewState().state?.file === file.path
        ) {
          existing = leaf;
        }
      });
      if (existing) continue;
      await this.app.workspace.getLeaf("tab").openFile(file);
    }
  }

  /** A project's folders and all of their subfolders. */
  projectFolders(project: Project): TFolder[] {
    const found = new Map<string, TFolder>();
    for (const fp of project.folders) {
      const folder = this.app.vault.getAbstractFileByPath(fp);
      if (folder instanceof TFolder) {
        found.set(folder.path, folder);
        Vault.recurseChildren(folder, (f) => {
          if (f instanceof TFolder) found.set(f.path, f);
        });
      }
    }
    return [...found.values()].sort((a, b) => a.path.localeCompare(b.path));
  }

  /** All markdown files belonging to a project (folder contents + loose notes). */
  projectFiles(project: Project): TFile[] {
    const found = new Map<string, TFile>();
    for (const fp of project.folders) {
      const folder = this.app.vault.getAbstractFileByPath(fp);
      if (folder instanceof TFolder) {
        Vault.recurseChildren(folder, (f) => {
          if (f instanceof TFile && f.extension === "md") found.set(f.path, f);
        });
      }
    }
    for (const np of project.notes) {
      const f = this.app.vault.getAbstractFileByPath(np);
      if (f instanceof TFile) found.set(f.path, f);
    }
    return [...found.values()].sort((a, b) =>
      a.basename.localeCompare(b.basename)
    );
  }

  /** The container element of a tab group, or null if it's gone. */
  private groupContainer(group: WorkspaceParent): HTMLElement | null {
    const el = (group as unknown as { containerEl?: HTMLElement }).containerEl;
    return el ?? null;
  }

  /** Return the pane's tab group if it still exists in the layout. */
  private getLiveGroup(key: string | null): WorkspaceParent | null {
    if (!key) return null;
    const group = this.projectGroups.get(key);
    if (!group) return null;
    const el = this.groupContainer(group);
    if (!el || !el.isConnected) {
      this.projectGroups.delete(key);
      return null;
    }
    return group;
  }

  getActiveGroup(): WorkspaceParent | null {
    const project = this.getActiveProject();
    if (!project) return null;
    return this.getLiveGroup(
      this.paneKey(project.id, project.activePaneId ?? null)
    );
  }

  private hasAnyLiveGroup(): boolean {
    for (const [key] of this.projectGroups) {
      if (this.getLiveGroup(key)) return true;
    }
    return false;
  }

  leafInGroup(leaf: WorkspaceLeaf, group: WorkspaceParent): boolean {
    let node: { parent?: WorkspaceParent } | null = leaf;
    while (node) {
      if ((node as unknown as WorkspaceParent) === group) return true;
      node = node.parent ?? null;
    }
    return false;
  }

  /** Show the active project's pane, hide all others. */
  private applyGroupVisibility(activeId: string): void {
    for (const [projectId, group] of [...this.projectGroups]) {
      const el = this.groupContainer(group);
      if (!el || !el.isConnected) {
        this.projectGroups.delete(projectId);
        continue;
      }
      // Fill the root split, but allow shrinking below the tab-header content
      // width (min-width:auto would otherwise stop the main area from getting
      // narrower as more tabs open, limiting how far the sidebar can grow).
      if (projectId === activeId) {
        el.removeClass("rv-pane-inactive");
        el.addClass("rv-pane-active");
      } else {
        el.removeClass("rv-pane-active");
        el.addClass("rv-pane-inactive");
      }
    }
  }

  /** Focus the most recently active leaf inside a group so its tab is shown
   *  (preserves which tab was active within that pane). */
  private focusGroup(group: WorkspaceParent): void {
    const leaf = this.app.workspace.getMostRecentLeaf(group);
    if (leaf) this.app.workspace.setActiveLeaf(leaf, { focus: true });
  }

  /**
   * React to layout changes: snapshot the active pane's tabs, or — if the active
   * pane was removed because its last tab was closed — recreate it as an empty
   * new tab so the project always has a visible pane.
   */
  private onLayoutChange(): void {
    if (this.isActivating || this.unloading || this.starting) return;
    const project = this.getActiveProject();
    if (!project) return;
    const paneId = project.activePaneId ?? null;
    const key = this.paneKey(project.id, paneId);
    if (this.getLiveGroup(key)) {
      this.saveActiveProjectTabs();
      this.refreshOpenHighlights();
    } else {
      // All tabs closed: reopen the active pane as an empty new tab.
      this.recordClosedNotes(project, paneId, this.paneNotes(project, paneId));
      this.setPaneNotes(project, paneId, []);
      void this.showPane(project, paneId);
    }
  }

  /** Focus the active project's pane (used before opening a note into it). */
  focusActiveGroup(): void {
    const group = this.getActiveGroup();
    if (group) this.focusGroup(group);
  }

  saveActiveProjectTabs(force = false): number {
    if ((this.isActivating || this.unloading) && !force) return -1;
    const project = this.getActiveProject();
    if (!project) return -1;
    const paneId = project.activePaneId ?? null;
    const group = this.getLiveGroup(this.paneKey(project.id, paneId));
    if (!group) return -1; // No live pane yet (e.g. startup): nothing to save.

    const activeLeaf = this.app.workspace.getMostRecentLeaf(
      this.app.workspace.rootSplit
    );
    const activePath = activeLeaf?.getViewState().state?.file;

    const open: OpenNote[] = [];
    this.app.workspace.iterateRootLeaves((leaf) => {
      // Only capture tabs that belong to this pane.
      if (!this.leafInGroup(leaf, group)) return;
      // Read the file path from the view state rather than leaf.view.file:
      // background tabs are deferred in Obsidian 1.7+, so their view has no
      // .file until activated, but getViewState().state.file is always set.
      const filePath = leaf.getViewState().state?.file;
      if (typeof filePath === "string" && !open.some((o) => o.path === filePath)) {
        open.push({
          path: filePath,
          eState: leaf.getEphemeralState() as Record<string, unknown>,
          active: filePath === activePath,
        });
      }
    });
    const removed = this.paneNotes(project, paneId).filter(
      (note) => !open.some((o) => o.path === note.path)
    );
    this.recordClosedNotes(project, paneId, removed);
    this.setPaneNotes(project, paneId, open);
    void this.persist();
    return open.length;
  }

  /** Snapshot the open tabs belonging to a pane's tab group. */
  private captureGroupTabs(group: WorkspaceParent): OpenNote[] {
    const activeLeaf = this.app.workspace.getMostRecentLeaf(
      this.app.workspace.rootSplit
    );
    const activePath = activeLeaf?.getViewState().state?.file;
    const open: OpenNote[] = [];
    this.app.workspace.iterateRootLeaves((leaf) => {
      if (!this.leafInGroup(leaf, group)) return;
      const filePath = leaf.getViewState().state?.file;
      if (typeof filePath === "string" && !open.some((o) => o.path === filePath)) {
        open.push({
          path: filePath,
          eState: leaf.getEphemeralState() as Record<string, unknown>,
          active: filePath === activePath,
        });
      }
    });
    return open;
  }

  /** A pane's saved default tab set (main pane uses project.defaultTabs). */
  private paneDefaultTabs(project: Project, paneId: string | null): OpenNote[] {
    if (!paneId) return project.defaultTabs ?? [];
    return project.panes.find((p) => p.id === paneId)?.defaultTabs ?? [];
  }

  paneHasDefaultTabs(project: Project, paneId: string | null): boolean {
    return this.paneDefaultTabs(project, paneId).length > 0;
  }

  private setPaneDefaultTabs(
    project: Project,
    paneId: string | null,
    tabs: OpenNote[]
  ): void {
    if (!paneId) {
      project.defaultTabs = tabs;
      return;
    }
    const pane = project.panes.find((p) => p.id === paneId);
    if (pane) pane.defaultTabs = tabs;
  }

  /** Save a pane's tabs as its default tab set. */
  saveDefaultTabs(project: Project, paneId: string | null): void {
    const group = this.getLiveGroup(this.paneKey(project.id, paneId));
    // Use the live tabs if the pane is currently shown, else its stored tabs.
    const tabs = group
      ? this.captureGroupTabs(group)
      : this.paneNotes(project, paneId).map((n) => ({ ...n }));
    this.setPaneDefaultTabs(project, paneId, tabs);
    void this.persistNow();
    this.refreshContentView();
    new Notice(`Saved ${tabs.length} default tab(s) for this pane.`);
  }

  /** Open a pane's saved default tabs as tabs in that pane. */
  async openDefaultTabs(project: Project, paneId: string | null): Promise<void> {
    const defaults = this.paneDefaultTabs(project, paneId);
    if (defaults.length === 0) {
      new Notice("No default tabs saved for this pane.");
      return;
    }
    await this.showPane(project, paneId);
    for (const note of defaults) {
      const file = this.app.vault.getAbstractFileByPath(note.path);
      if (file instanceof TFile) await this.openNoteStateInActivePane(note, file);
    }
  }

  paneHasOpenTabs(project: Project, paneId: string | null): boolean {
    const group = this.getLiveGroup(this.paneKey(project.id, paneId));
    if (group) {
      let has = false;
      this.app.workspace.iterateRootLeaves((leaf) => {
        if (
          !has &&
          this.leafInGroup(leaf, group) &&
          typeof leaf.getViewState().state?.file === "string"
        ) {
          has = true;
        }
      });
      if (has) return true;
    }
    return this.paneNotes(project, paneId).length > 0;
  }

  /** Close every tab in a pane, leaving it on a single empty new tab. */
  async closeAllInPane(project: Project, paneId: string | null): Promise<void> {
    await this.showPane(project, paneId);
    const group = this.getLiveGroup(this.paneKey(project.id, paneId));
    if (!group) return;

    this.isActivating = true;
    const leaves: WorkspaceLeaf[] = [];
    this.app.workspace.iterateRootLeaves((leaf) => {
      if (this.leafInGroup(leaf, group)) leaves.push(leaf);
    });
    this.recordClosedNotes(project, paneId, this.paneNotes(project, paneId));
    // Keep one leaf alive (so the pane survives), empty it, close the rest.
    const keep = leaves[0];
    for (let i = 1; i < leaves.length; i++) leaves[i].detach();
    if (keep) await keep.setViewState({ type: "empty" });
    this.setPaneNotes(project, paneId, []);
    this.refreshOpenHighlights();
    window.setTimeout(() => {
      this.isActivating = false;
    }, 150);
  }

  async deleteProject(project: Project): Promise<void> {
    // Close every live pane belonging to this project.
    for (const [key, group] of [...this.projectGroups]) {
      if (key !== project.id && !key.startsWith(project.id + "::")) continue;
      const toClose: WorkspaceLeaf[] = [];
      this.app.workspace.iterateRootLeaves((leaf) => {
        if (this.leafInGroup(leaf, group)) toClose.push(leaf);
      });
      for (const leaf of toClose) leaf.detach();
      this.projectGroups.delete(key);
    }

    this.data.projects = this.data.projects.filter((p) => p.id !== project.id);
    if (this.data.activeProjectId === project.id) {
      this.data.activeProjectId = null;
    }
    await this.persistNow();
    this.refreshListView();
    this.refreshContentView();
  }

  // ---- Google Drive integration ----

  /** A vault folder path not currently in use (appends a number if taken). */
  uniqueVaultFolder(base: string): string {
    let name = base;
    let i = 2;
    while (this.app.vault.getAbstractFileByPath(name)) name = `${base} ${i++}`;
    return name;
  }

  /** Download a Drive folder into vaultDir, then create + open a linked project. */
  async createProjectFromDrive(opts: {
    name: string;
    description: string;
    folders: string[];
    notes: string[];
    folderId: string;
    target: string;
  }): Promise<void> {
    new Notice("Downloading from Google Drive…");
    let count = 0;
    try {
      count = await this.drive.downloadFolder(opts.folderId, opts.target);
    } catch (e) {
      new Notice(`Google Drive download failed: ${(e as Error).message}`);
      return;
    }
    const project: Project = {
      id: genId(),
      name: opts.name,
      description: opts.description,
      folders: Array.from(new Set([...opts.folders, opts.target])),
      notes: opts.notes,
      lastOpenNotes: [],
      lastClosedNotes: [],
      panes: [],
      activePaneId: null,
      pinned: [],
      driveFolderId: opts.folderId,
      driveLocalFolder: opts.target,
    };
    this.data.projects.push(project);
    await this.persistNow();
    this.refreshListView();
    new Notice(`Imported ${count} file(s) into "${opts.target}".`);
    await this.openProject(project);
  }

  async uploadProjectToDrive(project: Project): Promise<void> {
    if (!isDesktop()) {
      new Notice("Google Drive is desktop-only.");
      return;
    }
    if (!this.drive.isConnected()) {
      new Notice("Connect Google Drive in the plugin settings first.");
      return;
    }
    if (!project.driveFolderId || !project.driveLocalFolder) {
      new Notice("This project isn't linked to a Google Drive folder.");
      return;
    }
    new Notice(`Uploading "${project.name}" to Google Drive…`);
    try {
      const n = await this.drive.uploadFolder(
        project.driveLocalFolder,
        project.driveFolderId
      );
      new Notice(`Uploaded ${n} file(s) to Google Drive.`);
    } catch (e) {
      new Notice(`Google Drive upload failed: ${(e as Error).message}`);
    }
  }

  /** Upload project files to a brand-new Drive folder, then link the project to it. */
  async uploadProjectToDriveAsNewFolder(
    project: Project,
    parentFolderId: string
  ): Promise<void> {
    if (!isDesktop()) {
      new Notice("Google Drive is desktop-only.");
      return;
    }
    if (!this.drive.isConnected()) {
      new Notice("Connect Google Drive in the plugin settings first.");
      return;
    }
    const localFolder = project.driveLocalFolder ?? project.folders[0] ?? "";
    if (!localFolder) {
      new Notice("This project has no folder to upload.");
      return;
    }
    const folderName = sanitizeVaultName(project.name);
    new Notice(`Creating "${folderName}" on Google Drive and uploading…`);
    try {
      const { folderId, count } = await this.drive.uploadFolderAsNew(
        folderName,
        parentFolderId,
        localFolder
      );
      project.driveFolderId = folderId;
      project.driveLocalFolder = localFolder;
      await this.persistNow();
      this.refreshContentView();
      new Notice(`Uploaded ${count} file(s) to new Drive folder "${folderName}".`);
    } catch (e) {
      new Notice(`Google Drive upload failed: ${(e as Error).message}`);
    }
  }

  /** Re-download the project's linked Drive folder into its local folder. */
  async downloadProjectFromDrive(project: Project): Promise<void> {
    if (!isDesktop()) {
      new Notice("Google Drive is desktop-only.");
      return;
    }
    if (!this.drive.isConnected()) {
      new Notice("Connect Google Drive in the plugin settings first.");
      return;
    }
    if (!project.driveFolderId || !project.driveLocalFolder) {
      new Notice("This project isn't linked to a Google Drive folder.");
      return;
    }
    new Notice(`Downloading "${project.name}" from Google Drive…`);
    try {
      const n = await this.drive.downloadFolder(
        project.driveFolderId,
        project.driveLocalFolder
      );
      new Notice(`Downloaded ${n} file(s) from Google Drive.`);
      this.refreshContentView();
    } catch (e) {
      new Notice(`Google Drive download failed: ${(e as Error).message}`);
    }
  }

  /**
   * Close a tab showing `file` in the currently active pane and reopen it in
   * `targetPaneId`. If `sourceLeaf` is provided (from the tab right-click
   * event) that exact leaf is detached; otherwise every leaf for that file in
   * the current pane is closed.
   */
  async moveTabToPane(
    project: Project,
    file: TFile,
    sourceLeaf: WorkspaceLeaf | null,
    targetPaneId: string | null
  ): Promise<void> {
    const sourcePaneId = project.activePaneId ?? null;
    if (sourcePaneId === targetPaneId) return;

    // Detach the leaf while blocking onLayoutChange so removing the tab
    // doesn't trigger a full pane rebuild.
    this.isActivating = true;
    try {
      if (sourceLeaf) {
        sourceLeaf.detach();
      } else {
        const group = this.getLiveGroup(this.paneKey(project.id, sourcePaneId));
        if (group) {
          const toClose: WorkspaceLeaf[] = [];
          this.app.workspace.iterateRootLeaves((leaf) => {
            if (
              this.leafInGroup(leaf, group) &&
              leaf.getViewState().state?.file === file.path
            ) {
              toClose.push(leaf);
            }
          });
          for (const leaf of toClose) leaf.detach();
        }
      }
    } finally {
      this.isActivating = false;
    }

    // Switch to the target pane and open the file there.  saveActiveProjectTabs
    // runs inside showPane before the switch, at which point the detached leaf
    // is already gone — so the source pane's saved tab list is clean.
    await this.openNoteInPane(project, targetPaneId, file);
  }

  /**
   * Upload a single file to its matching place in the project's Drive folder,
   * along with any media/notes the file directly embeds (images, PDFs, etc).
   */
  async uploadFileToDrive(project: Project, file: TFile): Promise<void> {
    if (!isDesktop()) {
      new Notice("Google Drive is desktop-only.");
      return;
    }
    if (!this.drive.isConnected()) {
      new Notice("Connect Google Drive in the plugin settings first.");
      return;
    }
    if (!project.driveFolderId) {
      new Notice("This project isn't linked to a Google Drive folder.");
      return;
    }
    const local = project.driveLocalFolder ?? "";
    const mainParts = this.relDirPartsUnder(file.path, local);
    new Notice(`Uploading "${file.name}" to Google Drive…`);
    const queue: { f: TFile; parts: string[] }[] = [{ f: file, parts: mainParts }];
    for (const att of await this.collectEmbeddedFiles(file)) {
      if (!local) continue;
      if (att.path !== `${local}/${att.name}` && !att.path.startsWith(`${local}/`)) continue;
      queue.push({ f: att, parts: this.relDirPartsUnder(att.path, local) });
    }
    let written = 0;
    let unchanged = 0;
    try {
      for (const { f, parts } of queue) {
        const u = await this.drive.uploadSingleFile(project.driveFolderId, f, parts);
        if (u) written++;
        else unchanged++;
      }
      new Notice(this.formatTransferNotice("Uploaded", file.name, queue.length, written, unchanged));
    } catch (e) {
      new Notice(`Google Drive upload failed: ${(e as Error).message}`);
    }
  }

  /**
   * Download a single file from the project's Drive folder, refreshing any
   * media/notes the file directly embeds at the same time.
   */
  async downloadFileFromDrive(project: Project, file: TFile): Promise<void> {
    if (!isDesktop()) {
      new Notice("Google Drive is desktop-only.");
      return;
    }
    if (!this.drive.isConnected()) {
      new Notice("Connect Google Drive in the plugin settings first.");
      return;
    }
    if (!project.driveFolderId) {
      new Notice("This project isn't linked to a Google Drive folder.");
      return;
    }
    const local = project.driveLocalFolder;
    if (!local) {
      new Notice("This project isn't linked to a Google Drive folder.");
      return;
    }
    if (file.path !== `${local}/${file.name}` && !file.path.startsWith(`${local}/`)) {
      new Notice(`"${file.name}" isn't under the linked local folder.`);
      return;
    }
    const mainParts = file.path.slice(local.length + 1).split("/");
    new Notice(`Downloading "${file.name}" from Google Drive…`);
    let written = 0;
    let unchanged = 0;
    let processed = 0;
    let missing = 0;
    try {
      const mainResult = await this.downloadDrivePath(project, mainParts);
      if (mainResult === "missing") {
        new Notice(`"${file.name}" not found on Google Drive.`);
        return;
      }
      processed++;
      if (mainResult === "written") written++;
      else unchanged++;

      const fresh = this.app.vault.getAbstractFileByPath(file.path);
      const attachments =
        fresh instanceof TFile ? await this.collectEmbeddedFiles(fresh) : [];
      const attachmentPathParts: string[][] = [];
      for (const att of attachments) {
        if (att.path !== `${local}/${att.name}` && !att.path.startsWith(`${local}/`)) continue;
        attachmentPathParts.push(att.path.slice(local.length + 1).split("/"));
      }
      // Also try paths derived directly from linkpaths, for embeds whose
      // attachment doesn't yet exist locally (first-time download).
      const sourceContent = await this.readVaultBinaryAsText(file.path);
      if (sourceContent !== null) {
        for (const parts of this.driveLinkpathsToParts(sourceContent, file.path, local)) {
          if (!attachmentPathParts.some((p) => p.join("/") === parts.join("/"))) {
            attachmentPathParts.push(parts);
          }
        }
      }
      for (const parts of attachmentPathParts) {
        if (parts.join("/") === mainParts.join("/")) continue;
        const r = await this.downloadDrivePath(project, parts);
        if (r === "missing") {
          missing++;
          continue;
        }
        processed++;
        if (r === "written") written++;
        else unchanged++;
      }

      let msg = this.formatTransferNotice("Downloaded", file.name, processed, written, unchanged);
      if (missing > 0) msg += ` (${missing} embed${missing > 1 ? "s" : ""} not found on Drive)`;
      new Notice(msg);
      this.refreshContentView();
    } catch (e) {
      new Notice(`Google Drive download failed: ${(e as Error).message}`);
    }
  }

  /**
   * Pull the Drive copy of a single file and additively merge it with the
   * local file. The merge is written to a NEW note next to the original
   * (named "<basename> merge YYYY-MM-DD HH-MM-SS.<ext>") so the local file is
   * never touched and the user can review/discard freely. Categories of change
   * are labelled inline by mergeAdditive.
   */
  async mergeFileFromDrive(project: Project, file: TFile): Promise<void> {
    if (!isDesktop()) {
      new Notice("Google Drive is desktop-only.");
      return;
    }
    if (!this.drive.isConnected()) {
      new Notice("Connect Google Drive in the plugin settings first.");
      return;
    }
    if (!project.driveFolderId) {
      new Notice("This project isn't linked to a Google Drive folder.");
      return;
    }
    const local = project.driveLocalFolder;
    if (!local) {
      new Notice("This project isn't linked to a Google Drive folder.");
      return;
    }
    if (file.path !== `${local}/${file.name}` && !file.path.startsWith(`${local}/`)) {
      new Notice(`"${file.name}" isn't under the linked local folder.`);
      return;
    }
    const parts = file.path.slice(local.length + 1).split("/");
    new Notice(`Merging "${file.name}" with Google Drive…`);
    try {
      const child = await this.drive.findChildByPath(project.driveFolderId, parts);
      if (!child) {
        new Notice(`"${file.name}" not found on Google Drive.`);
        return;
      }
      const dl = await this.drive.downloadChildBytes(child);
      if (!dl) {
        new Notice(`"${file.name}" isn't a mergeable Drive file.`);
        return;
      }
      let remoteText: string;
      try {
        remoteText = new TextDecoder("utf-8", { fatal: true }).decode(dl.data);
      } catch {
        new Notice(`"${file.name}" isn't a text file — cannot merge.`);
        return;
      }
      const localText = await this.app.vault.read(file);
      if (localText === remoteText) {
        new Notice(`"${file.name}" already matches Google Drive.`);
        return;
      }
      const merged = mergeAdditive(localText, remoteText);
      if (merged === null) {
        new Notice(`"${file.name}" is too large to merge in memory.`);
        return;
      }
      if (merged === localText) {
        new Notice(`"${file.name}" already contains the Google Drive version.`);
        return;
      }
      const parent = file.parent;
      const dir = parent && parent.path !== "/" ? parent.path : "";
      const ext = file.extension ? `.${file.extension}` : "";
      const stamp = formatFilenameTimestamp(new Date().toISOString());
      const baseName = `${file.basename} merge ${stamp}`;
      let candidate = baseName;
      let n = 1;
      while (
        this.app.vault.getAbstractFileByPath(
          (dir ? `${dir}/` : "") + candidate + ext
        )
      ) {
        n++;
        candidate = `${baseName} ${n}`;
      }
      const targetPath = (dir ? `${dir}/` : "") + candidate + ext;
      // Frontmatter lets the "Apply ticks to original" action find the source
      // file even if the merge note is later renamed or moved. Instructions
      // sit between frontmatter and the sentinel; the apply parser skips
      // them, so they never leak into the source file when applied.
      const frontmatter =
        "---\n" +
        `${MERGE_FM_SOURCE}: ${JSON.stringify(file.path)}\n` +
        `${MERGE_FM_CREATED}: ${new Date().toISOString()}\n` +
        "---\n\n";
      const header =
        frontmatter +
        MERGE_INSTRUCTIONS +
        "\n\n" +
        MERGE_CONTENT_MARKER +
        "\n\n";
      const created = await this.app.vault.create(targetPath, header + merged);
      await this.app.workspace.getLeaf("tab").openFile(created);
      new Notice(`Merged "${file.name}" → "${created.name}".`);
      this.refreshContentView();
    } catch (e) {
      new Notice(`Google Drive merge failed: ${(e as Error).message}`);
    }
  }

  /**
   * True if `file` is a merge note produced by mergeFileFromDrive (carries our
   * frontmatter source key). Reads cached metadata so it's cheap to call from
   * a menu handler.
   */
  isMergeNote(file: TFile): boolean {
    const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
    return !!(fm && typeof fm[MERGE_FM_SOURCE] === "string");
  }

  /**
   * Apply the ticked changes in a merge note back to its original source file.
   * Each labelled blockquote is kept iff its task header is `[x]`; everything
   * else (plain prose) is kept as-is. The merge note itself is left untouched
   * so the user can refine selections and re-apply.
   */
  async applyMergeNoteToOriginal(mergeFile: TFile): Promise<void> {
    const fm = this.app.metadataCache.getFileCache(mergeFile)?.frontmatter;
    const sourcePath = fm?.[MERGE_FM_SOURCE];
    if (typeof sourcePath !== "string" || !sourcePath) {
      new Notice(`"${mergeFile.name}" isn't a merge note.`);
      return;
    }
    const source = this.app.vault.getAbstractFileByPath(sourcePath);
    if (!(source instanceof TFile)) {
      new Notice(`Original note "${sourcePath}" no longer exists.`);
      return;
    }
    try {
      const mergeText = await this.app.vault.read(mergeFile);
      const result = applyMergeBody(mergeText);
      if (result.kept === 0 && result.dropped === 0) {
        new Notice(`"${mergeFile.name}" has no merge blocks to apply.`);
        return;
      }
      await this.app.vault.modify(source, result.body);
      await this.app.workspace.getLeaf("tab").openFile(source);
      const parts = [`${result.kept} kept`];
      if (result.dropped > 0) parts.push(`${result.dropped} dropped`);
      new Notice(`Applied to "${source.name}" — ${parts.join(", ")}.`);
      this.refreshContentView();
    } catch (e) {
      new Notice(`Apply merge failed: ${(e as Error).message}`);
    }
  }

  /** List recent Drive revisions for a vault file living under the linked folder. */
  async listDriveRevisionsForFile(
    project: Project,
    file: TFile,
    limit = 10
  ): Promise<{ revisions: DriveRevision[]; driveFileId: string }> {
    if (!isDesktop()) throw new Error("Google Drive is desktop-only.");
    if (!this.drive.isConnected()) {
      throw new Error("Connect Google Drive in the plugin settings first.");
    }
    if (!project.driveFolderId || !project.driveLocalFolder) {
      throw new Error("This project isn't linked to a Google Drive folder.");
    }
    const local = project.driveLocalFolder;
    if (file.path !== `${local}/${file.name}` && !file.path.startsWith(`${local}/`)) {
      throw new Error(`"${file.name}" isn't under the linked local folder.`);
    }
    const parts = file.path.slice(local.length + 1).split("/");
    const child = await this.drive.findChildByPath(project.driveFolderId, parts);
    if (!child) throw new Error(`"${file.name}" not found on Google Drive.`);
    const revisions = await this.drive.listRevisions(child.id, limit);
    return { revisions, driveFileId: child.id };
  }

  /**
   * Download a specific Drive revision for `file` and save it as a new vault
   * note in the same folder. `versionLabel` is appended to the basename
   * (e.g. "v2"), producing "<basename> (v2).<ext>". Opens the new note.
   */
  async openDriveVersionAsNewNote(
    file: TFile,
    driveFileId: string,
    revisionId: string,
    versionLabel: string
  ): Promise<void> {
    try {
      const data = await this.drive.downloadRevisionBytes(driveFileId, revisionId);
      const parent = file.parent;
      const dir = parent && parent.path !== "/" ? parent.path : "";
      const ext = file.extension ? `.${file.extension}` : "";
      const safeLabel = versionLabel.replace(/[\\/:*?"<>|]/g, "_");
      const baseName = `${file.basename} (${safeLabel})`;
      let candidate = baseName;
      let n = 1;
      while (this.app.vault.getAbstractFileByPath(
        (dir ? `${dir}/` : "") + candidate + ext
      )) {
        n++;
        candidate = `${baseName} ${n}`;
      }
      const targetPath = (dir ? `${dir}/` : "") + candidate + ext;
      const created = await this.app.vault.createBinary(targetPath, data);
      await this.app.workspace.getLeaf("tab").openFile(created);
      new Notice(`Opened ${versionLabel} of "${file.name}".`);
    } catch (e) {
      new Notice(`Couldn't open Drive version: ${(e as Error).message}`);
    }
  }

  /** Download one Drive path under the project's linked folder, returning the outcome. */
  private async downloadDrivePath(
    project: Project,
    parts: string[]
  ): Promise<"written" | "unchanged" | "missing"> {
    if (!project.driveFolderId || !project.driveLocalFolder) return "missing";
    const child = await this.drive.findChildByPath(project.driveFolderId, parts);
    if (!child) return "missing";
    const vaultDir = [project.driveLocalFolder, ...parts.slice(0, -1)]
      .filter(Boolean)
      .join("/");
    const r = await this.drive.downloadChildTo(child, vaultDir);
    if (!r) return "missing";
    return r.written ? "written" : "unchanged";
  }

  /** Return `<path>` split on `/` after stripping `localFolder/`. Empty if outside. */
  private relDirPartsUnder(filePath: string, localFolder: string): string[] {
    if (!localFolder) return [];
    if (!filePath.startsWith(`${localFolder}/`)) return [];
    const parts = filePath.slice(localFolder.length + 1).split("/");
    parts.pop();
    return parts;
  }

  /** Collect direct embed targets (images, PDFs, media, embedded notes). */
  private async collectEmbeddedFiles(file: TFile): Promise<TFile[]> {
    if (file.extension !== "md") return [];
    let text: string;
    try {
      text = await this.app.vault.read(file);
    } catch {
      return [];
    }
    const sourceDir = file.path.includes("/")
      ? file.path.slice(0, file.path.lastIndexOf("/"))
      : "";
    const seen = new Set<string>();
    const out: TFile[] = [];
    for (const lp of this.parseEmbedLinkpaths(text)) {
      const dest =
        this.app.metadataCache.getFirstLinkpathDest(lp, file.path) ??
        this.lookupVaultFile(lp, sourceDir);
      if (!dest || dest.path === file.path || seen.has(dest.path)) continue;
      seen.add(dest.path);
      out.push(dest);
    }
    return out;
  }

  /** Extract embed linkpaths from markdown — wiki-style and standard-md image syntax. */
  private parseEmbedLinkpaths(content: string): string[] {
    const out: string[] = [];
    for (const m of content.matchAll(/!\[\[([^\]\n]+?)(?:\|[^\]\n]*)?\]\]/g)) {
      const p = m[1].split(/[#^]/)[0].trim();
      if (p) out.push(p);
    }
    for (const m of content.matchAll(/!\[[^\]\n]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
      const u = m[1];
      if (/^[a-z][a-z0-9+.-]*:/i.test(u)) continue;
      out.push(decodeURIComponent(u.split("#")[0]));
    }
    return out;
  }

  /** Try linkpath as a literal vault path: from source's folder first, then root. */
  private lookupVaultFile(linkpath: string, sourceDir: string): TFile | null {
    const candidates = [
      sourceDir ? `${sourceDir}/${linkpath}` : linkpath,
      linkpath,
    ];
    for (const p of candidates) {
      const af = this.app.vault.getAbstractFileByPath(p);
      if (af instanceof TFile) return af;
    }
    return null;
  }

  /**
   * Convert markdown embed linkpaths into Drive-relative path parts under
   * `localFolder`, for embeds whose attachment doesn't exist locally yet.
   * Skips linkpaths with no `/` (those need vault-aware short-name resolution).
   */
  private driveLinkpathsToParts(
    content: string,
    sourcePath: string,
    localFolder: string
  ): string[][] {
    const sourceDir = sourcePath.includes("/")
      ? sourcePath.slice(0, sourcePath.lastIndexOf("/"))
      : "";
    const out: string[][] = [];
    for (const lp of this.parseEmbedLinkpaths(content)) {
      if (!lp.includes("/")) continue;
      const candidates = [
        sourceDir ? `${sourceDir}/${lp}` : lp,
        lp,
      ];
      for (const c of candidates) {
        if (c !== localFolder && !c.startsWith(`${localFolder}/`)) continue;
        out.push(c.slice(localFolder.length + 1).split("/"));
        break;
      }
    }
    return out;
  }

  /** Read a vault file as UTF-8 text; null if missing or unreadable. */
  private async readVaultBinaryAsText(path: string): Promise<string | null> {
    try {
      const buf = await this.app.vault.adapter.readBinary(path);
      return new TextDecoder().decode(buf);
    } catch {
      return null;
    }
  }

  /** "Uploaded foo.md" / "Uploaded 5 file(s) with foo.md (1 unchanged)" etc. */
  private formatTransferNotice(
    verb: string,
    primaryName: string,
    processed: number,
    written: number,
    unchanged: number
  ): string {
    if (processed === 1) {
      return written
        ? `${verb} "${primaryName}".`
        : `"${primaryName}" is already up to date.`;
    }
    const bits = [`${verb.toLowerCase()} ${written}`];
    if (unchanged > 0) bits.push(`${unchanged} unchanged`);
    return `"${primaryName}" + embeds: ${bits.join(", ")} of ${processed} file(s).`;
  }

  /** Link a project to an existing Drive folder (no upload/download performed). */
  async linkProjectToDrive(
    project: Project,
    folderId: string,
    localFolder: string
  ): Promise<void> {
    project.driveFolderId = folderId;
    project.driveLocalFolder = localFolder;
    await this.persistNow();
    this.refreshListView();
    this.refreshContentView();
    new Notice(`"${project.name}" linked to Google Drive.`);
  }

  /** Remove the Drive link from a project without touching local or remote files. */
  async unlinkProjectFromDrive(project: Project): Promise<void> {
    delete project.driveFolderId;
    delete project.driveLocalFolder;
    await this.persistNow();
    this.refreshListView();
    this.refreshContentView();
    new Notice(`"${project.name}" unlinked from Google Drive.`);
  }
}

class ProjectListView extends ItemView {
  plugin: RecentViewPlugin;
  private reordering = false;

  constructor(leaf: WorkspaceLeaf, plugin: RecentViewPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return VIEW_TYPE_PROJECT_LIST;
  }

  getDisplayText(): string {
    return "Projects";
  }

  getIcon(): string {
    return "folder-kanban";
  }

  async onOpen(): Promise<void> {
    this.render();
  }

  render(): void {
    const c = this.contentEl;
    c.empty();
    c.addClass("recent-view-list");

    const header = c.createDiv({ cls: "rv-header" });
    const titleWrap = header.createDiv({ cls: "rv-header-title-wrap" });
    titleWrap.createEl("span", { cls: "rv-header-title", text: "Projects" });

    const menuBtn = titleWrap.createEl("button", {
      cls: "rv-icon-btn rv-header-menu",
    });
    if (this.reordering) menuBtn.addClass("is-active");
    setIcon(menuBtn, "more-vertical");
    menuBtn.setAttribute("aria-label", "Projects options");
    menuBtn.onclick = (e) => {
      e.stopPropagation();
      const menu = new Menu();
      menu.addItem((i) =>
        i
          .setTitle("Back to last project")
          .setIcon("arrow-left")
          .setDisabled(!this.plugin.canGoBack())
          .onClick(() => void this.plugin.goBack())
      );
      menu.addItem((i) =>
        i
          .setTitle(this.reordering ? "Done reordering" : "Reorder projects")
          .setIcon(this.reordering ? "check" : "arrow-up-down")
          .setDisabled(this.plugin.data.projects.length < 2)
          .onClick(() => {
            this.reordering = !this.reordering;
            this.render();
          })
      );
      showMenu(menu, e, this.contentEl, menuBtn);
    };

    const addBtn = header.createEl("button", {
      cls: "rv-new-btn",
      text: "+ New",
    });
    addBtn.onclick = () =>
      new ProjectEditModal(this.plugin.app, this.plugin, null).open();

    const list = c.createDiv({ cls: "rv-project-list" });
    if (this.reordering) list.addClass("rv-reordering");

    if (this.plugin.data.projects.length === 0) {
      this.reordering = false;
      list.createDiv({
        cls: "rv-empty",
        text: 'No projects yet. Click "+ New" to create one.',
      });
      return;
    }

    for (const project of this.plugin.data.projects) {
      const box = list.createDiv({ cls: "rv-project-box" });
      if (project.id === this.plugin.data.activeProjectId) {
        box.addClass("is-active");
      }
      if (this.reordering) box.dataset.rvId = project.id;

      const info = box.createDiv({ cls: "rv-project-info" });
      info.createDiv({ cls: "rv-project-name", text: project.name });
      if (project.description) {
        info.createDiv({ cls: "rv-project-desc", text: project.description });
      }

      const actions = box.createDiv({ cls: "rv-project-actions" });
      const menuBtn = actions.createEl("button", { cls: "rv-icon-btn" });
      setIcon(menuBtn, "more-vertical");
      menuBtn.setAttribute("aria-label", "Project options");
      menuBtn.onclick = (e) => {
        e.stopPropagation();
        const menu = new Menu();
        menu.addItem((item) =>
          item
            .setTitle("Edit project")
            .setIcon("pencil")
            .onClick(() =>
              new ProjectEditModal(this.plugin.app, this.plugin, project).open()
            )
        );
        menu.addItem((item) =>
          item
            .setTitle("Add folder to project…")
            .setIcon("folder-plus")
            .onClick(() =>
              VaultTreeModal.pickFolder(this.plugin.app, (folder) =>
                void this.plugin.addFolderToProject(project, folder)
              ).open()
            )
        );
        menu.addItem((item) =>
          item
            .setTitle("Add note to project…")
            .setIcon("file-plus")
            .onClick(() =>
              VaultTreeModal.pickNote(
                this.plugin.app,
                (file) => void this.plugin.addNoteToProject(project, file),
                {
                  excludePaths: new Set(
                    this.plugin.projectFiles(project).map((f) => f.path)
                  ),
                }
              ).open()
            )
        );
        if (!project.driveFolderId) {
          // Linking only stores a folder id + local-folder mapping, so it needs
          // credentials configured but not an active connection (you can link
          // now and sign in later before the first upload/download).
          if (this.plugin.drive.isConfigured()) {
            menu.addItem((item) =>
              item
                .setTitle("Link to Google Drive folder")
                .setIcon("link")
                .onClick(() =>
                  new DriveLinkModal(
                    this.plugin.app,
                    this.plugin,
                    project
                  ).open()
                )
            );
          }
          // Uploading as a new folder transfers files immediately, so it needs
          // an active connection.
          if (this.plugin.drive.isConnected()) {
            menu.addItem((item) =>
              item
                .setTitle("Upload to Google Drive as new folder")
                .setIcon("folder-up")
                .onClick(() =>
                  new DriveUploadAsNewModal(
                    this.plugin.app,
                    this.plugin,
                    project
                  ).open()
                )
            );
          }
        }
        if (project.driveFolderId) {
          menu.addItem((item) =>
            item
              .setTitle("Download from Google Drive")
              .setIcon("cloud-download")
              .onClick(() => void this.plugin.downloadProjectFromDrive(project))
          );
          menu.addItem((item) =>
            item
              .setTitle("Upload to Google Drive")
              .setIcon("cloud-upload")
              .onClick(() => void this.plugin.uploadProjectToDrive(project))
          );
          menu.addItem((item) =>
            item
              .setTitle("Unlink from Google Drive")
              .setIcon("unlink")
              .onClick(() =>
                new ConfirmModal(
                  this.plugin.app,
                  `Unlink "${project.name}" from Google Drive? Local and Drive files are not deleted.`,
                  () => void this.plugin.unlinkProjectFromDrive(project)
                ).open()
              )
          );
        }
        menu.addItem((item) =>
          item
            .setTitle("Delete project")
            .setIcon("trash-2")
            .onClick(() =>
              new ConfirmModal(
                this.plugin.app,
                `Delete project "${project.name}"?`,
                () => void this.plugin.deleteProject(project)
              ).open()
            )
        );
        showMenu(menu, e, this.contentEl, menuBtn);
      };

      box.onclick = () => {
        if (this.reordering) return;
        void this.plugin.openProject(project);
      };
    }

    if (this.reordering) {
      enableReorder(list, (ids) => void this.plugin.setProjectOrder(ids));
    }
  }
}

/**
 * Diff `oldStr` -> `newStr` by trimming the shared prefix and suffix, returning
 * the inserted text (`added`) and the removed text (`removed`).
 */
function diffEdit(
  oldStr: string,
  newStr: string
): { added: string; removed: string; start: number; endOld: number; endNew: number } {
  let start = 0;
  const minLen = Math.min(oldStr.length, newStr.length);
  while (start < minLen && oldStr[start] === newStr[start]) start++;
  let endOld = oldStr.length;
  let endNew = newStr.length;
  while (
    endOld > start &&
    endNew > start &&
    oldStr[endOld - 1] === newStr[endNew - 1]
  ) {
    endOld--;
    endNew--;
  }
  return {
    added: newStr.slice(start, endNew),
    removed: oldStr.slice(start, endOld),
    start,
    endOld,
    endNew,
  };
}

const EDIT_KIND_LABEL: Record<EditKind, string> = {
  add: "Added",
  delete: "Deleted",
  modify: "Modified",
};

/** A short display snippet for an edit, describing whitespace-only changes. */
function editSnippet(raw: string): string {
  const collapsed = raw.replace(/\s+/g, " ").trim();
  if (collapsed) return collapsed.slice(0, 200);
  if (/\n/.test(raw)) return raw.replace(/[^\n]/g, "").length > 1 ? "(blank lines)" : "(new line)";
  if (raw.length) return "(whitespace)";
  return "(empty)";
}

/** Compact "time ago" label (with the absolute time available as a tooltip). */
function formatFilenameTimestamp(iso: string | undefined): string {
  const d = iso ? new Date(iso) : new Date();
  if (Number.isNaN(d.getTime())) return "unknown";
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`
  );
}

function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "";
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 10 ? 0 : 1)} ${units[i]}`;
}

function formatRelativeTime(time: number): string {
  const diff = Date.now() - time;
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return "just now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d ago`;
  return new Date(time).toLocaleDateString();
}

class RecentEditsView extends ItemView {
  plugin: RecentViewPlugin;

  constructor(leaf: WorkspaceLeaf, plugin: RecentViewPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return VIEW_TYPE_RECENT_EDITS;
  }

  getDisplayText(): string {
    return "Recent edits";
  }

  getIcon(): string {
    return "history";
  }

  async onOpen(): Promise<void> {
    this.render();
  }

  render(): void {
    const c = this.contentEl;
    c.empty();
    c.addClass("recent-view-edits");

    const header = c.createDiv({ cls: "rv-header" });
    const titleWrap = header.createDiv({ cls: "rv-header-title-wrap" });
    titleWrap.createEl("span", { cls: "rv-header-title", text: "Recent edits" });

    const menuBtn = titleWrap.createEl("button", {
      cls: "rv-icon-btn rv-header-menu",
    });
    setIcon(menuBtn, "more-vertical");
    menuBtn.setAttribute("aria-label", "Recent edits options");
    menuBtn.onclick = (e) => {
      e.stopPropagation();
      const menu = new Menu();
      menu.addItem((i) =>
        i
          .setTitle("Refresh")
          .setIcon("refresh-cw")
          .onClick(() => this.render())
      );
      menu.addItem((i) =>
        i
          .setTitle("Clear history")
          .setIcon("trash-2")
          .setDisabled(this.plugin.editHistory.length === 0)
          .onClick(() => void this.plugin.clearEditHistory())
      );
      showMenu(menu, e, this.contentEl, menuBtn);
    };

    const list = c.createDiv({ cls: "rv-edit-list" });
    if (this.plugin.editHistory.length === 0) {
      list.createDiv({
        cls: "rv-empty",
        text: "No recent edits yet. Notes you edit will appear here.",
      });
      return;
    }
    for (const record of this.plugin.editHistory) {
      this.renderEditBox(list, record);
    }
  }

  private renderEditBox(container: HTMLElement, record: EditRecord): void {
    const file = this.plugin.app.vault.getAbstractFileByPath(record.path);
    const box = container.createDiv({ cls: "rv-edit-box" });
    box.setAttribute("aria-label", "Open at this edit");
    if (!(file instanceof TFile)) box.addClass("rv-edit-missing");

    const name =
      file instanceof TFile
        ? file.basename
        : (record.path.split("/").pop() ?? record.path).replace(/\.md$/, "");
    const folder =
      file instanceof TFile
        ? file.parent && file.parent.path !== "/"
          ? file.parent.path
          : "/"
        : record.path.split("/").slice(0, -1).join("/") || "/";

    const textRow = box.createDiv({ cls: "rv-edit-text-row" });
    textRow.createSpan({
      cls: `rv-edit-kind rv-edit-kind-${record.kind}`,
      text: EDIT_KIND_LABEL[record.kind] ?? "Edited",
    });
    const textEl = textRow.createSpan({
      cls: "rv-edit-text",
      text: record.text || "(empty)",
    });
    if (record.kind === "delete") textEl.addClass("rv-edit-deleted");

    const nameRow = box.createDiv({ cls: "rv-edit-name-row" });
    setIcon(nameRow.createSpan({ cls: "rv-edit-icon" }), "file-text");
    nameRow.createSpan({ cls: "rv-edit-name", text: name });

    const meta = box.createDiv({ cls: "rv-edit-meta" });
    meta.createSpan({ cls: "rv-edit-folder", text: folder });
    const time = meta.createSpan({
      cls: "rv-edit-time",
      text: formatRelativeTime(record.time),
    });
    time.setAttribute("title", new Date(record.time).toLocaleString());

    box.onclick = () => void this.plugin.openEditRecord(record);
  }
}

class ProjectContentView extends ItemView {
  plugin: RecentViewPlugin;
  private reordering = false;
  private panesReordering = false;

  constructor(leaf: WorkspaceLeaf, plugin: RecentViewPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return VIEW_TYPE_PROJECT_CONTENT;
  }

  getDisplayText(): string {
    return "Project contents";
  }

  getIcon(): string {
    return "list-tree";
  }

  async onOpen(): Promise<void> {
    this.render();
  }

  render(): void {
    const c = this.contentEl;
    c.empty();
    c.addClass("recent-view-content");

    const header = c.createDiv({ cls: "rv-content-header" });
    const info = header.createDiv({ cls: "rv-content-headinfo" });
    const project = this.plugin.getActiveProject();
    info.createEl("h4", {
      cls: "rv-content-title",
      text: project ? project.name : "Project contents",
    });
    const menuBtn = header.createEl("button", {
      cls: "rv-icon-btn rv-content-menu",
    });
    setIcon(menuBtn, "more-vertical");
    menuBtn.setAttribute("aria-label", "More options");
    menuBtn.onclick = (e) => {
      const menu = new Menu();
      if (project) {
        menu.addItem((item) =>
          item
            .setTitle("New note…")
            .setIcon("file-plus")
            .onClick(() => {
              const root = this.plugin.app.vault.getRoot();
              const projectFolders = this.plugin.projectFolders(project);
              new FolderSuggestModal(
                this.plugin.app,
                (folder) => void this.plugin.createNoteForProject(project, folder),
                [root, ...projectFolders]
              ).open();
            })
        );
        menu.addItem((item) =>
          item
            .setTitle("New folder…")
            .setIcon("folder-plus")
            .onClick(() => {
              const root = this.plugin.app.vault.getRoot();
              const projectFolders = this.plugin.projectFolders(project);
              new FolderSuggestModal(
                this.plugin.app,
                (parentFolder) =>
                  new PromptModal(
                    this.plugin.app,
                    "New folder",
                    "",
                    (name) => void this.plugin.createFolder(parentFolder, name, project)
                  ).open(),
                [root, ...projectFolders]
              ).open();
            })
        );
        menu.addItem((item) =>
          item
            .setTitle("Add note to project…")
            .setIcon("file-search")
            .onClick(() =>
              VaultTreeModal.pickNote(
                this.plugin.app,
                (file) => void this.plugin.addNoteToProject(project, file),
                {
                  excludePaths: new Set(
                    this.plugin.projectFiles(project).map((f) => f.path)
                  ),
                }
              ).open()
            )
        );
        menu.addItem((item) =>
          item
            .setTitle("Add folder to project…")
            .setIcon("folder-plus")
            .onClick(() =>
              VaultTreeModal.pickFolder(this.plugin.app, (folder) =>
                void this.plugin.addFolderToProject(project, folder)
              ).open()
            )
        );
        menu.addSeparator();
        menu.addItem((item) =>
          item
            .setTitle("New pane")
            .setIcon("layout-panel-left")
            .onClick(() =>
              new PromptModal(
                this.plugin.app,
                "New pane",
                `Pane ${project.panes.length + 1}`,
                (name) => void this.plugin.addPane(project, name)
              ).open()
            )
        );
      }
      if (project && !project.driveFolderId) {
        // Linking only stores a folder mapping: needs credentials configured,
        // not an active connection.
        if (this.plugin.drive.isConfigured()) {
          menu.addItem((item) =>
            item
              .setTitle("Link to Google Drive folder")
              .setIcon("link")
              .onClick(() =>
                new DriveLinkModal(
                  this.plugin.app,
                  this.plugin,
                  project
                ).open()
              )
          );
        }
        // Uploading as a new folder transfers now: needs an active connection.
        if (this.plugin.drive.isConnected()) {
          menu.addItem((item) =>
            item
              .setTitle("Upload to Google Drive as new folder")
              .setIcon("folder-up")
              .onClick(() =>
                new DriveUploadAsNewModal(
                  this.plugin.app,
                  this.plugin,
                  project
                ).open()
              )
          );
        }
      }
      if (project?.driveFolderId) {
        menu.addItem((item) =>
          item
            .setTitle("Download from Google Drive")
            .setIcon("cloud-download")
            .onClick(() => void this.plugin.downloadProjectFromDrive(project))
        );
        menu.addItem((item) =>
          item
            .setTitle("Upload to Google Drive")
            .setIcon("cloud-upload")
            .onClick(() => void this.plugin.uploadProjectToDrive(project))
        );
        menu.addItem((item) =>
          item
            .setTitle("Unlink from Google Drive")
            .setIcon("unlink")
            .onClick(() =>
              new ConfirmModal(
                this.plugin.app,
                `Unlink "${project.name}" from Google Drive? Local and Drive files are not deleted.`,
                () => void this.plugin.unlinkProjectFromDrive(project)
              ).open()
            )
        );
      }
      menu.addItem((item) =>
        item
          .setTitle("Refresh")
          .setIcon("refresh-cw")
          .onClick(() => this.render())
      );
      showMenu(menu, e, this.contentEl, menuBtn);
    };

    if (!project) {
      c.createDiv({
        cls: "rv-empty",
        text: "Open a project to see its folders and notes.",
      });
      return;
    }

    if (project.description) {
      info.createDiv({ cls: "rv-project-desc", text: project.description });
    }

    this.renderPanes(c, project);

    // Pinned notes, shown above all folders in their saved (drag-reorderable)
    // order.
    const pinnedFiles = (project.pinned ?? [])
      .map((path) => this.plugin.app.vault.getAbstractFileByPath(path))
      .filter((f): f is TFile => f instanceof TFile);
    if (pinnedFiles.length > 0) {
      const section = c.createDiv({ cls: "rv-folder-section rv-pinned-section" });
      if (this.reordering) section.addClass("rv-reordering");
      const head = section.createDiv({ cls: "rv-folder-head" });
      setIcon(head.createSpan({ cls: "rv-folder-icon" }), "pin");
      head.createSpan({ text: "Pinned" });
      const menuBtn = head.createEl("button", {
        cls: "rv-icon-btn rv-head-menu",
      });
      setIcon(menuBtn, "more-vertical");
      menuBtn.setAttribute("aria-label", "More options");
      menuBtn.onclick = (e) => {
        e.stopPropagation();
        const menu = new Menu();
        menu.addItem((i) =>
          i
            .setTitle(this.reordering ? "Done reordering" : "Reorder")
            .setIcon(this.reordering ? "check" : "arrow-up-down")
            .onClick(() => {
              this.reordering = !this.reordering;
              this.render();
            })
        );
        showMenu(menu, e, this.contentEl, menuBtn);
      };

      const fileList = section.createDiv({ cls: "rv-file-list" });
      for (const file of pinnedFiles) {
        const item = this.renderFileItem(fileList, file);
        if (this.reordering) item.dataset.rvId = file.path;
      }
      if (this.reordering) {
        enableReorder(fileList, (ids) =>
          void this.plugin.setPinnedOrder(project, ids)
        );
      }
    } else if (this.reordering) {
      // No pinned notes left to reorder.
      this.reordering = false;
    }

    if (project.notes.length > 0) {
      const section = c.createDiv({ cls: "rv-folder-section" });
      const head = section.createDiv({ cls: "rv-folder-head" });
      setIcon(head.createSpan({ cls: "rv-folder-icon" }), "file-text");
      head.createSpan({ text: "Notes" });
      const fileList = section.createDiv({ cls: "rv-file-list" });
      const looseNotes = project.notes
        .map((path) => this.plugin.app.vault.getAbstractFileByPath(path))
        .filter((f): f is TFile => f instanceof TFile)
        .sort((a, b) => a.basename.localeCompare(b.basename));
      for (const file of looseNotes) this.renderFileItem(fileList, file);
    }

    for (const folderPath of project.folders) {
      const folder = this.plugin.app.vault.getAbstractFileByPath(folderPath);
      if (folder instanceof TFolder) {
        this.renderFolderSection(c, project, folder, 0, folderPath);
      } else {
        const section = c.createDiv({ cls: "rv-folder-section" });
        const head = section.createDiv({ cls: "rv-folder-head" });
        setIcon(head.createSpan({ cls: "rv-folder-icon" }), "folder");
        head.createSpan({ text: folderPath });
        const menuBtn = head.createEl("button", {
          cls: "rv-icon-btn rv-head-menu",
        });
        setIcon(menuBtn, "more-vertical");
        menuBtn.setAttribute("aria-label", "Folder options");
        menuBtn.onclick = (e) => {
          e.stopPropagation();
          const menu = new Menu();
          menu.addItem((i) =>
            i
              .setTitle("Remove from project")
              .setIcon("x")
              .onClick(() =>
                void this.plugin.removeFolderFromProject(project, folderPath)
              )
          );
          showMenu(menu, e, this.contentEl, menuBtn);
        };
        section.createDiv({ cls: "rv-empty-sm", text: "Folder not found" });
      }
    }

    this.updateOpenHighlights();
  }

  /**
   * Grey-highlight the active note, and give a solid file icon to notes that
   * are open as tabs in the current pane.
   */
  updateOpenHighlights(): void {
    const activePath = this.plugin.app.workspace.getActiveFile()?.path;
    const openPaths = new Set<string>();
    const group = this.plugin.getActiveGroup();
    if (group) {
      this.plugin.app.workspace.iterateRootLeaves((leaf) => {
        if (!this.plugin.leafInGroup(leaf, group)) return;
        const p = leaf.getViewState().state?.file;
        if (typeof p === "string") openPaths.add(p);
      });
    }

    this.contentEl
      .querySelectorAll<HTMLElement>(".rv-file-item[data-rv-path]")
      .forEach((el) => {
        const path = el.dataset.rvPath ?? "";
        el.toggleClass("is-open", path === activePath);
        el.toggleClass("is-tab-open", openPaths.has(path));
      });
  }

  /** Scroll the right pane to the item for `path`, if it is rendered. */
  scrollToFile(path: string): void {
    const items = this.contentEl.querySelectorAll<HTMLElement>(
      ".rv-file-item[data-rv-path]"
    );
    for (const el of Array.from(items)) {
      if (el.dataset.rvPath === path) {
        el.scrollIntoView({ behavior: "smooth", block: "nearest" });
        break;
      }
    }
  }

  /** List the project's panes (main + named) when it has named panes. */
  private renderPanes(c: HTMLElement, project: Project): void {
    if (!project.panes || project.panes.length === 0) {
      this.panesReordering = false;
      return;
    }
    const activePaneId = project.activePaneId ?? null;
    const section = c.createDiv({ cls: "rv-folder-section rv-panes-section" });
    if (this.panesReordering) section.addClass("rv-reordering");
    const head = section.createDiv({ cls: "rv-folder-head" });
    setIcon(head.createSpan({ cls: "rv-folder-icon" }), "layout-grid");
    head.createSpan({ text: "Panes" });
    const menuBtn = head.createEl("button", { cls: "rv-icon-btn rv-head-menu" });
    if (this.panesReordering) menuBtn.addClass("is-active");
    setIcon(menuBtn, "more-vertical");
    menuBtn.setAttribute("aria-label", "Panes options");
    menuBtn.onclick = (e) => {
      e.stopPropagation();
      const menu = new Menu();
      menu.addItem((i) =>
        i
          .setTitle("Add pane")
          .setIcon("plus")
          .onClick(() =>
            new PromptModal(
              this.plugin.app,
              "New pane",
              `Pane ${project.panes.length + 1}`,
              (name) => void this.plugin.addPane(project, name)
            ).open()
          )
      );
      menu.addItem((i) =>
        i
          .setTitle(this.panesReordering ? "Done reordering" : "Reorder panes")
          .setIcon(this.panesReordering ? "check" : "arrow-up-down")
          .setDisabled(project.panes.length < 2)
          .onClick(() => {
            this.panesReordering = !this.panesReordering;
            this.render();
          })
      );
      showMenu(menu, e, this.contentEl, menuBtn);
    };
    const list = section.createDiv({ cls: "rv-file-list" });

    this.renderPaneItem(list, project, null, "Main", activePaneId === null);
    for (const pane of project.panes) {
      const item = this.renderPaneItem(
        list,
        project,
        pane.id,
        pane.name,
        activePaneId === pane.id
      );
      if (this.panesReordering) item.dataset.rvId = pane.id;
    }

    if (this.panesReordering) {
      enableReorder(list, (ids) => void this.plugin.setPaneOrder(project, ids));
    }
  }

  private renderPaneItem(
    list: HTMLElement,
    project: Project,
    paneId: string | null,
    name: string,
    isActive: boolean
  ): HTMLElement {
    const item = list.createDiv({ cls: "rv-file-item rv-pane-item" });
    if (isActive) item.addClass("is-active");
    setIcon(
      item.createSpan({ cls: "rv-file-icon" }),
      paneId ? "gallery-vertical" : "home"
    );
    item.createSpan({ cls: "rv-file-name", text: name });
    item.onclick = () => {
      if (this.panesReordering) return;
      void this.plugin.showPane(project, paneId);
    };

    const menuBtn = item.createEl("button", { cls: "rv-icon-btn rv-item-menu" });
    setIcon(menuBtn, "more-vertical");
    menuBtn.setAttribute("aria-label", "Pane options");
    menuBtn.onclick = (e) => {
      e.stopPropagation();
      const menu = new Menu();
      menu.addItem((i) =>
        i
          .setTitle("New note…")
          .setIcon("file-plus")
          .onClick(() => {
            const root = this.plugin.app.vault.getRoot();
            const projectFolders = this.plugin.projectFolders(project);
            new FolderSuggestModal(
              this.plugin.app,
              (folder) =>
                void this.plugin.createNoteForProject(project, folder, paneId),
              [root, ...projectFolders]
            ).open();
          })
      );
      menu.addSeparator();
      menu.addItem((i) =>
        i
          .setTitle("Open default tabs")
          .setIcon("layout-list")
          .setDisabled(this.plugin.paneHasDefaultTabs(project, paneId) === false)
          .onClick(() => void this.plugin.openDefaultTabs(project, paneId))
      );
      const lastClosed = this.plugin.lastClosedNote(project, paneId);
      menu.addItem((i) =>
        i
          .setTitle("Open last closed tab")
          .setIcon("undo-2")
          .setDisabled(!lastClosed)
          .onClick(() =>
            void this.plugin.openLastClosedInPane(project, paneId)
          )
      );
      // Open a folder (project folders + subfolders) into this pane.
      menu.addItem((i) =>
        i
          .setTitle("Open folder…")
          .setIcon("folder-open")
          .onClick(() =>
            new FolderSuggestModal(
              this.plugin.app,
              (folder) =>
                void this.plugin.openFolderInPane(project, paneId, folder),
              this.plugin.projectFolders(project)
            ).open()
          )
      );
      menu.addItem((i) =>
        i
          .setTitle("Open note…")
          .setIcon("file")
          .onClick(() =>
            new FileSuggestModal(
              this.plugin.app,
              (file) => void this.plugin.openNoteInPane(project, paneId, file),
              this.plugin.projectFiles(project)
            ).open()
          )
      );
      menu.addItem((i) =>
        i
          .setTitle("Browse…")
          .setIcon("list-tree")
          .onClick(() =>
            new ProjectTreeModal(
              this.plugin.app,
              project,
              (folder) =>
                void this.plugin.openFolderInPane(project, paneId, folder),
              (file) => void this.plugin.openNoteInPane(project, paneId, file)
            ).open()
          )
      );
      menu.addItem((i) =>
        i
          .setTitle("Close all tabs")
          .setIcon("x")
          .setDisabled(!this.plugin.paneHasOpenTabs(project, paneId))
          .onClick(() => void this.plugin.closeAllInPane(project, paneId))
      );
      menu.addSeparator();
      menu.addItem((i) =>
        i
          .setTitle("Save current tabs as default")
          .setIcon("save")
          .onClick(() => this.plugin.saveDefaultTabs(project, paneId))
      );
      // Rename/Delete only apply to named (non-main) panes.
      if (paneId) {
        menu.addSeparator();
        menu.addItem((i) =>
          i
            .setTitle("Rename")
            .setIcon("pencil")
            .onClick(() =>
              new PromptModal(this.plugin.app, "Rename pane", name, (v) =>
                void this.plugin.renamePaneItem(project, paneId, v)
              ).open()
            )
        );
        menu.addItem((i) =>
          i
            .setTitle("Delete pane")
            .setIcon("trash-2")
            .onClick(() =>
              new ConfirmModal(
                this.plugin.app,
                `Delete pane "${name}"?`,
                () => void this.plugin.deletePaneItem(project, paneId)
              ).open()
            )
        );
      }
      showMenu(menu, e, this.contentEl, menuBtn);
    };
    return item;
  }

  private renderFileItem(container: HTMLElement, file: TFile): HTMLElement {
    const item = container.createDiv({ cls: "rv-file-item" });
    item.dataset.rvPath = file.path;
    setIcon(item.createSpan({ cls: "rv-file-icon" }), "file");
    item.createSpan({ cls: "rv-file-name", text: file.basename });
    item.onclick = () => this.openOrFocus(file);

    const menuBtn = item.createEl("button", { cls: "rv-icon-btn rv-item-menu" });
    setIcon(menuBtn, "more-vertical");
    menuBtn.setAttribute("aria-label", "More options");
    menuBtn.onclick = (e) => {
      e.stopPropagation();
      this.showFileMenu(e, file, menuBtn);
    };
    item.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      this.showFileMenu(e, file, menuBtn);
    });
    return item;
  }

  /**
   * Render a folder's notes (sorted), then each subfolder's notes below a
   * separator labelled with the subfolder name (recursively). Returns the total
   * number of notes rendered.
   */
  /**
   * Render a folder as a section (header + notes), recursing into subfolders
   * which are rendered the same way (indented). projectFolderPath is set only
   * for a project's top-level folders (enables "Remove from project").
   */
  private renderFolderSection(
    container: HTMLElement,
    project: Project,
    folder: TFolder,
    depth: number,
    projectFolderPath: string | null
  ): void {
    const section = container.createDiv({ cls: "rv-folder-section" });
    if (depth > 0) section.setCssProps({ "--rv-depth": String(depth) });
    const head = section.createDiv({ cls: "rv-folder-head" });
    setIcon(head.createSpan({ cls: "rv-folder-icon" }), "folder");
    head.createSpan({ text: folder.name });
    const menuBtn = head.createEl("button", {
      cls: "rv-icon-btn rv-head-menu",
    });
    setIcon(menuBtn, "more-vertical");
    menuBtn.setAttribute("aria-label", "Folder options");
    menuBtn.onclick = (e) => {
      e.stopPropagation();
      const menu = new Menu();
      menu.addItem((i) =>
        i
          .setTitle("New note")
          .setIcon("file-plus")
          .onClick(() => void this.plugin.createNoteInFolder(folder))
      );
      menu.addSeparator();
      menu.addItem((i) =>
        i
          .setTitle("Rename")
          .setIcon("pencil")
          .onClick(() => new RenameModal(this.plugin.app, folder).open())
      );
      if (projectFolderPath) {
        menu.addItem((i) =>
          i
            .setTitle("Remove from project")
            .setIcon("x")
            .onClick(() =>
              void this.plugin.removeFolderFromProject(project, projectFolderPath)
            )
        );
      }
      showMenu(menu, e, this.contentEl, menuBtn);
    };

    const fileList = section.createDiv({ cls: "rv-file-list" });
    const children = [...folder.children];
    const files = children
      .filter((c): c is TFile => c instanceof TFile && c.extension === "md")
      .sort((a, b) => a.basename.localeCompare(b.basename));
    const subfolders = children
      .filter((c): c is TFolder => c instanceof TFolder && countMarkdown(c) > 0)
      .sort((a, b) => a.name.localeCompare(b.name));

    for (const f of files) this.renderFileItem(fileList, f);
    for (const sub of subfolders) {
      this.renderFolderSection(fileList, project, sub, depth + 1, null);
    }
    if (files.length === 0 && subfolders.length === 0) {
      fileList.createDiv({ cls: "rv-empty-sm", text: "No notes" });
    }
  }

  private async moveFileTo(file: TFile, folder: TFolder): Promise<void> {
    const dir = folder.path === "/" ? "" : folder.path;
    const newPath = dir ? `${dir}/${file.name}` : file.name;
    if (newPath === file.path) return;
    if (this.plugin.app.vault.getAbstractFileByPath(newPath)) {
      new Notice(`"${file.name}" already exists in that folder.`);
      return;
    }
    try {
      await this.plugin.app.fileManager.renameFile(file, newPath);
    } catch (e) {
      new Notice(`Move failed: ${(e as Error).message}`);
    }
  }

  private showFileMenu(e: MouseEvent, file: TFile, btn: HTMLElement): void {
    const project = this.plugin.getActiveProject();
    const menu = new Menu();

    // Close (only if the note is open as a tab in the current pane).
    const group = this.plugin.getActiveGroup();
    let openLeaf: WorkspaceLeaf | null = null;
    if (group) {
      this.plugin.app.workspace.iterateRootLeaves((leaf) => {
        if (
          !openLeaf &&
          this.plugin.leafInGroup(leaf, group) &&
          leaf.getViewState().state?.file === file.path
        ) {
          openLeaf = leaf;
        }
      });
    }
    if (openLeaf) {
      const leaf = openLeaf as WorkspaceLeaf;
      menu.addItem((i) =>
        i
          .setTitle("Close")
          .setIcon("x")
          .onClick(() => leaf.detach())
      );
      menu.addSeparator();
    }

    // Merge notes get an "apply ticks to original" action up top.
    if (this.plugin.isMergeNote(file)) {
      menu.addItem((i) =>
        i
          .setTitle("Apply ticks to original note")
          .setIcon("check-check")
          .onClick(() => void this.plugin.applyMergeNoteToOriginal(file))
      );
      menu.addSeparator();
    }

    if (project) {
      const pinned = (project.pinned ?? []).includes(file.path);
      menu.addItem((i) =>
        i
          .setTitle(pinned ? "Unpin from top" : "Pin to top")
          .setIcon(pinned ? "pin-off" : "pin")
          .onClick(() => void this.plugin.togglePin(project, file.path))
      );
    }
    menu.addItem((i) =>
      i
        .setTitle("Rename")
        .setIcon("pencil")
        .onClick(() => new RenameModal(this.plugin.app, file).open())
    );
    if (project && project.folders.length > 0) {
      menu.addItem((i) =>
        i
          .setTitle("Move to folder in project…")
          .setIcon("folder-input")
          .onClick(() =>
            new FolderSuggestModal(
              this.plugin.app,
              (folder) => void this.moveFileTo(file, folder),
              this.plugin.projectFolders(project)
            ).open()
          )
      );
    }
    menu.addItem((i) =>
      i
        .setTitle("Move to folder in vault…")
        .setIcon("folder-input")
        .onClick(() =>
          VaultTreeModal.pickFolder(
            this.plugin.app,
            (folder) => void this.moveFileTo(file, folder)
          ).open()
        )
    );
    if (project?.driveFolderId) {
      menu.addItem((i) =>
        i
          .setTitle("Upload to Google Drive")
          .setIcon("cloud-upload")
          .onClick(() => void this.plugin.uploadFileToDrive(project, file))
      );
      menu.addItem((i) =>
        i
          .setTitle("Download from Google Drive")
          .setIcon("cloud-download")
          .onClick(() => void this.plugin.downloadFileFromDrive(project, file))
      );
      menu.addItem((i) =>
        i
          .setTitle("Show Drive versions…")
          .setIcon("history")
          .onClick(() =>
            new DriveVersionPickerModal(
              this.plugin.app,
              this.plugin,
              project,
              file
            ).open()
          )
      );
      // Merge only makes sense for text-like notes (binaries can't be diffed).
      if (file.extension === "md" || file.extension === "txt") {
        menu.addItem((i) =>
          i
            .setTitle("Merge with Google Drive on Local")
            .setIcon("git-merge")
            .onClick(() => void this.plugin.mergeFileFromDrive(project, file))
        );
      }
    }
    menu.addSeparator();
    menu.addItem((i) =>
      i
        .setTitle("Delete")
        .setIcon("trash-2")
        .onClick(() =>
          new ConfirmModal(
            this.plugin.app,
            `Delete "${file.basename}"?`,
            () => void this.plugin.app.fileManager.trashFile(file)
          ).open()
        )
    );
    showMenu(menu, e, this.contentEl, btn);
  }

  private openOrFocus(file: TFile): void {
    const { workspace } = this.plugin.app;
    const group = this.plugin.getActiveGroup();
    // If the file is already open in the active project's pane, focus that tab
    // instead of opening a duplicate.
    const existing = this.findLeafForFile(file, group);
    if (existing) {
      workspace.setActiveLeaf(existing, { focus: true });
      void workspace.revealLeaf(existing);
      return;
    }
    // Open in the active project's pane: focus a leaf in it first so the new
    // tab is appended there rather than in another project's (hidden) pane.
    if (group) this.plugin.focusActiveGroup();
    void workspace.getLeaf("tab").openFile(file);
  }

  private findLeafForFile(
    file: TFile,
    group: WorkspaceParent | null
  ): WorkspaceLeaf | null {
    let found: WorkspaceLeaf | null = null;
    this.plugin.app.workspace.iterateRootLeaves((leaf) => {
      if (found) return;
      if (group && !this.plugin.leafInGroup(leaf, group)) return;
      if (leaf.getViewState().state?.file === file.path) found = leaf;
    });
    return found;
  }
}

class RenameModal extends Modal {
  private item: TAbstractFile;
  private value: string;
  private isFile: boolean;

  constructor(app: App, item: TAbstractFile) {
    super(app);
    this.item = item;
    this.isFile = item instanceof TFile;
    this.value = item instanceof TFile ? item.basename : item.name;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.addClass("recent-view-modal");
    contentEl.createEl("h3", {
      text: this.isFile ? "Rename note" : "Rename folder",
    });

    let inputEl: HTMLInputElement | null = null;
    new Setting(contentEl).setName("New name").addText((t) => {
      t.setValue(this.value).onChange((v) => (this.value = v));
      inputEl = t.inputEl;
      t.inputEl.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          void this.doRename();
        }
      });
    });

    const footer = contentEl.createDiv({ cls: "rv-modal-footer" });
    const ok = footer.createEl("button", { cls: "mod-cta", text: "Rename" });
    ok.onclick = () => void this.doRename();
    const cancel = footer.createEl("button", { text: "Cancel" });
    cancel.onclick = () => this.close();

    window.setTimeout(() => {
      inputEl?.focus();
      inputEl?.select();
    }, 0);
  }

  private async doRename(): Promise<void> {
    const name = this.value.trim();
    if (!name) {
      new Notice("Name is required");
      return;
    }
    const parent = this.item.parent?.path;
    const dir = parent && parent !== "/" ? `${parent}/` : "";
    const ext = this.item instanceof TFile ? `.${this.item.extension}` : "";
    const newPath = `${dir}${name}${ext}`;
    if (newPath === this.item.path) {
      this.close();
      return;
    }
    try {
      await this.app.fileManager.renameFile(this.item, newPath);
    } catch (e) {
      new Notice(`Rename failed: ${(e as Error).message}`);
      return;
    }
    this.close();
  }
}

function countMarkdown(folder: TFolder): number {
  let n = 0;
  for (const child of folder.children) {
    if (child instanceof TFolder) n += countMarkdown(child);
    else if (child instanceof TFile && child.extension === "md") n++;
  }
  return n;
}

class ProjectEditModal extends Modal {
  plugin: RecentViewPlugin;
  project: Project | null;
  private name: string;
  private description: string;
  private folders: string[];
  private notes: string[];
  private driveLink = "";
  private driveTarget = "";
  private driveFolderName = "";

  constructor(app: App, plugin: RecentViewPlugin, project: Project | null) {
    super(app);
    this.plugin = plugin;
    this.project = project;
    this.name = project?.name ?? "";
    this.description = project?.description ?? "";
    this.folders = [...(project?.folders ?? [])];
    this.notes = [...(project?.notes ?? [])];
  }

  onOpen(): void {
    this.renderForm();
  }

  private renderForm(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("recent-view-modal");
    contentEl.createEl("h3", {
      text: this.project ? "Edit project" : "New project",
    });

    new Setting(contentEl).setName("Name").addText((t) =>
      t
        .setPlaceholder("Project name")
        .setValue(this.name)
        .onChange((v) => (this.name = v))
    );

    new Setting(contentEl)
      .setName("Description")
      .addTextArea((t) =>
        t
          .setPlaceholder("What is this project about?")
          .setValue(this.description)
          .onChange((v) => (this.description = v))
      );

    new Setting(contentEl)
      .setName("Folders")
      .setDesc("Folders included in this project")
      .addButton((b) =>
        b.setButtonText("Add folder").onClick(() => {
          VaultTreeModal.pickFolder(this.app, (folder) => {
            if (!this.folders.includes(folder.path)) {
              this.folders.push(folder.path);
            }
            this.renderForm();
          }).open();
        })
      );
    this.renderChipList(contentEl, this.folders, (path) => {
      this.folders = this.folders.filter((x) => x !== path);
      this.renderForm();
    });

    new Setting(contentEl)
      .setName("Notes")
      .setDesc("Specific notes included in this project")
      .addButton((b) =>
        b.setButtonText("Add note").onClick(() => {
          // Exclude notes already under the selected project folders.
          const covered = new Set<string>();
          for (const fp of this.folders) {
            const folder = this.app.vault.getAbstractFileByPath(fp);
            if (folder instanceof TFolder) {
              Vault.recurseChildren(folder, (f) => {
                if (f instanceof TFile) covered.add(f.path);
              });
            }
          }
          for (const p of this.notes) covered.add(p);
          VaultTreeModal.pickNote(
            this.app,
            (file) => {
              if (!this.notes.includes(file.path)) this.notes.push(file.path);
              this.renderForm();
            },
            { excludePaths: covered }
          ).open();
        })
      );
    this.renderChipList(contentEl, this.notes, (path) => {
      this.notes = this.notes.filter((x) => x !== path);
      this.renderForm();
    });

    if (!this.project) this.renderDriveSection(contentEl);

    const footer = contentEl.createDiv({ cls: "rv-modal-footer" });
    const saveBtn = footer.createEl("button", {
      cls: "mod-cta",
      text: "Save",
    });
    saveBtn.onclick = () => void this.save();
    const cancelBtn = footer.createEl("button", { text: "Cancel" });
    cancelBtn.onclick = () => this.close();
  }

  private renderDriveSection(contentEl: HTMLElement): void {
    new Setting(contentEl).setName("Import from Google Drive").setHeading();
    contentEl.createEl("p", {
      cls: "setting-item-description",
      text: "Paste a Google Drive folder share link to download its files into a folder. Set up Google Drive in plugin settings first. Desktop only.",
    });
    contentEl.createEl("p", {
      cls: "setting-item-description",
      text:
        "Note: download is additive/overwrite — it writes the Drive files into " +
        "the local folder (updating existing ones), but it does not delete " +
        "local files that were removed on Drive. Same one-way model as upload.",
    });

    new Setting(contentEl)
      .setName("Share link")
      .addText((t) =>
        t
          .setPlaceholder("https://drive.google.com/drive/folders/…")
          .setValue(this.driveLink)
          .onChange((v) => (this.driveLink = v))
      )
      .addButton((b) =>
        b.setButtonText("Fetch name").onClick(async () => {
          const id = parseDriveFolderId(this.driveLink);
          if (!id) {
            new Notice("Couldn't find a Google Drive folder in that link.");
            return;
          }
          if (!this.plugin.drive.isConnected()) {
            new Notice("Connect Google Drive in plugin settings first.");
            return;
          }
          try {
            this.driveFolderName = await this.plugin.drive.getFolderName(id);
            if (!this.name.trim()) this.name = this.driveFolderName;
            if (!this.driveTarget.trim()) {
              this.driveTarget = this.plugin.uniqueVaultFolder(
                sanitizeVaultName(this.driveFolderName)
              );
            }
            this.renderForm();
          } catch (e) {
            new Notice(`Google Drive: ${(e as Error).message}`);
          }
        })
      );

    new Setting(contentEl)
      .setName("Download to folder")
      .setDesc("New folder name, or choose an existing folder")
      .addText((t) =>
        t
          .setPlaceholder("Folder name (defaults to the Drive folder name)")
          .setValue(this.driveTarget)
          .onChange((v) => (this.driveTarget = v))
      )
      .addButton((b) =>
        b.setButtonText("Choose").onClick(() =>
          VaultTreeModal.pickFolder(this.app, (folder) => {
            this.driveTarget = folder.path === "/" ? "" : folder.path;
            this.renderForm();
          }).open()
        )
      );
  }

  private renderChipList(
    parent: HTMLElement,
    items: string[],
    onRemove: (path: string) => void
  ): void {
    if (items.length === 0) return;
    const list = parent.createDiv({ cls: "rv-modal-list" });
    for (const path of items) {
      const row = list.createDiv({ cls: "rv-modal-row" });
      row.createSpan({ cls: "rv-modal-row-path", text: path });
      const rm = row.createEl("button", { cls: "rv-icon-btn" });
      setIcon(rm, "x");
      rm.onclick = () => onRemove(path);
    }
  }

  private async save(): Promise<void> {
    if (!this.name.trim()) {
      new Notice("Project name is required");
      return;
    }

    // New project created from a Google Drive link: download then create.
    if (!this.project && this.driveLink.trim()) {
      if (!isDesktop()) {
        new Notice("Google Drive is desktop-only.");
        return;
      }
      if (!this.plugin.drive.isConnected()) {
        new Notice("Connect Google Drive in plugin settings first.");
        return;
      }
      const folderId = parseDriveFolderId(this.driveLink);
      if (!folderId) {
        new Notice("Couldn't find a Google Drive folder in that link.");
        return;
      }
      let target = this.driveTarget.trim();
      if (!target) {
        let driveName = this.driveFolderName;
        if (!driveName) {
          try {
            driveName = await this.plugin.drive.getFolderName(folderId);
          } catch (e) {
            new Notice(`Google Drive: ${(e as Error).message}`);
            return;
          }
        }
        target = this.plugin.uniqueVaultFolder(sanitizeVaultName(driveName));
      }
      this.close();
      await this.plugin.createProjectFromDrive({
        name: this.name.trim(),
        description: this.description,
        folders: this.folders,
        notes: this.notes,
        folderId,
        target,
      });
      return;
    }

    if (this.project) {
      this.project.name = this.name.trim();
      this.project.description = this.description;
      this.project.folders = this.folders;
      this.project.notes = this.notes;
    } else {
      this.plugin.data.projects.push({
        id: genId(),
        name: this.name.trim(),
        description: this.description,
        folders: this.folders,
        notes: this.notes,
        lastOpenNotes: [],
        lastClosedNotes: [],
        panes: [],
        activePaneId: null,
        pinned: [],
      });
    }
    await this.plugin.persistNow();
    this.plugin.refreshListView();
    this.plugin.refreshContentView();
    this.close();
  }
}

/**
 * A lazy vault browser used to pick any folder or note. It expands folders on
 * demand (reading only `folder.children` as the user drills in) instead of
 * enumerating the whole vault up front, so it never lists files the user
 * doesn't navigate to.
 */
class VaultTreeModal extends Modal {
  private constructor(
    app: App,
    private mode: "folder" | "note",
    private onChoose: (item: TFolder | TFile) => void,
    private opts: { excludePaths?: Set<string> } = {}
  ) {
    super(app);
  }

  /** Pick any folder in the vault. */
  static pickFolder(
    app: App,
    onChoose: (folder: TFolder) => void,
    opts: { excludePaths?: Set<string> } = {}
  ): VaultTreeModal {
    return new VaultTreeModal(
      app,
      "folder",
      (i) => {
        if (i instanceof TFolder) onChoose(i);
      },
      opts
    );
  }

  /** Pick any markdown note in the vault. */
  static pickNote(
    app: App,
    onChoose: (file: TFile) => void,
    opts: { excludePaths?: Set<string> } = {}
  ): VaultTreeModal {
    return new VaultTreeModal(
      app,
      "note",
      (i) => {
        if (i instanceof TFile) onChoose(i);
      },
      opts
    );
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("recent-view-modal");
    contentEl.createEl("h3", {
      text: this.mode === "folder" ? "Choose a folder" : "Choose a note",
    });
    contentEl.createDiv({
      cls: "rv-empty-sm",
      text:
        this.mode === "folder"
          ? "Click a folder to browse it, then use its Select button to choose it."
          : "Expand folders with the arrow, then click a note to select it.",
    });

    const tree = contentEl.createDiv({ cls: "rv-tree-picker" });
    const root = this.app.vault.getRoot();
    if (this.mode === "folder") {
      const row = tree.createDiv({ cls: "rv-tree-row rv-tree-folder" });
      row.setCssProps({ "--rv-depth": "0" });
      row.createSpan({ cls: "rv-tree-twirl" });
      setIcon(row.createSpan({ cls: "rv-file-icon" }), "folder");
      row.createSpan({ cls: "rv-file-name", text: "/ (vault root)" });
      this.addSelectButton(row, root);
    }
    this.renderChildren(tree, root, this.mode === "folder" ? 1 : 0);
  }

  /** A "Select" button that chooses this folder (folder mode only). */
  private addSelectButton(row: HTMLElement, folder: TFolder): void {
    const btn = row.createEl("button", {
      cls: "rv-tree-select",
      text: "Select",
    });
    btn.onclick = (e) => {
      e.stopPropagation();
      this.choose(folder);
    };
  }

  private hasExpandableChildren(folder: TFolder): boolean {
    return folder.children.some(
      (c) =>
        c instanceof TFolder ||
        (this.mode === "note" && c instanceof TFile && c.extension === "md")
    );
  }

  private renderChildren(
    container: HTMLElement,
    folder: TFolder,
    depth: number
  ): void {
    const children = [...folder.children];
    const folders = children
      .filter((c): c is TFolder => c instanceof TFolder)
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const f of folders) this.renderFolderRow(container, f, depth);
    if (this.mode === "note") {
      const files = children
        .filter(
          (c): c is TFile => c instanceof TFile && c.extension === "md"
        )
        .sort((a, b) => a.name.localeCompare(b.name));
      for (const f of files) this.renderFileRow(container, f, depth);
    }
  }

  private renderFolderRow(
    container: HTMLElement,
    folder: TFolder,
    depth: number
  ): void {
    const row = container.createDiv({ cls: "rv-tree-row rv-tree-folder" });
    row.setCssProps({ "--rv-depth": String(depth) });
    const expandable = this.hasExpandableChildren(folder);
    const twirl = row.createSpan({ cls: "rv-tree-twirl" });
    if (expandable) setIcon(twirl, "chevron-right");
    setIcon(row.createSpan({ cls: "rv-file-icon" }), "folder");
    row.createSpan({ cls: "rv-file-name", text: folder.name || "/" });

    let childrenWrap: HTMLElement | null = null;
    let expanded = false;
    const toggle = (): void => {
      if (!expandable) return;
      expanded = !expanded;
      if (expanded) {
        if (!childrenWrap) {
          childrenWrap = container.createDiv();
          row.after(childrenWrap);
          // Lazy: only read this folder's children when it is first expanded.
          this.renderChildren(childrenWrap, folder, depth + 1);
        }
        childrenWrap.removeClass("rv-collapsed");
        setIcon(twirl, "chevron-down");
      } else {
        if (childrenWrap) childrenWrap.addClass("rv-collapsed");
        setIcon(twirl, "chevron-right");
      }
    };
    twirl.onclick = (e) => {
      e.stopPropagation();
      toggle();
    };
    // Clicking the row browses (expands/collapses) in both modes. In folder
    // mode an explicit Select button is what actually chooses the folder.
    row.onclick = () => toggle();
    if (this.mode === "folder") this.addSelectButton(row, folder);
  }

  private renderFileRow(
    container: HTMLElement,
    file: TFile,
    depth: number
  ): void {
    if (this.opts.excludePaths?.has(file.path)) return;
    const row = container.createDiv({ cls: "rv-tree-row" });
    row.setCssProps({ "--rv-depth": String(depth) });
    row.createSpan({ cls: "rv-tree-twirl" });
    setIcon(row.createSpan({ cls: "rv-file-icon" }), "file");
    row.createSpan({ cls: "rv-file-name", text: file.basename });
    row.onclick = () => this.choose(file);
  }

  private choose(item: TFolder | TFile): void {
    this.onChoose(item);
    this.close();
  }
}

class FolderSuggestModal extends FuzzySuggestModal<TFolder> {
  private onChoose: (folder: TFolder) => void;
  private items: TFolder[];

  constructor(app: App, onChoose: (folder: TFolder) => void, items: TFolder[]) {
    super(app);
    this.onChoose = onChoose;
    this.items = items;
    this.setPlaceholder("Pick a folder");
  }

  getItems(): TFolder[] {
    return this.items;
  }

  getItemText(item: TFolder): string {
    return item.path === "/" ? "/ (vault root)" : item.path;
  }

  onChooseItem(item: TFolder): void {
    this.onChoose(item);
  }
}

class FileSuggestModal extends FuzzySuggestModal<TFile> {
  private onChoose: (file: TFile) => void;
  private items: TFile[];

  constructor(app: App, onChoose: (file: TFile) => void, items: TFile[]) {
    super(app);
    this.onChoose = onChoose;
    this.items = items;
    this.setPlaceholder("Pick a note");
  }

  getItems(): TFile[] {
    return this.items;
  }

  getItemText(item: TFile): string {
    return item.path;
  }

  onChooseItem(item: TFile): void {
    this.onChoose(item);
  }
}

class ProjectTreeModal extends Modal {
  private project: Project;
  private onFolder: (folder: TFolder) => void;
  private onFile: (file: TFile) => void;

  constructor(
    app: App,
    project: Project,
    onFolder: (folder: TFolder) => void,
    onFile: (file: TFile) => void
  ) {
    super(app);
    this.project = project;
    this.onFolder = onFolder;
    this.onFile = onFile;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("recent-view-modal");
    contentEl.createEl("h3", { text: "Browse project" });
    contentEl.createDiv({
      cls: "rv-empty-sm",
      text: "Choose a folder to open all of its notes, or choose a note to open just that note.",
    });

    const tree = contentEl.createDiv({ cls: "rv-tree-picker" });
    const folders = this.topLevelProjectFolders();
    for (const folder of folders) this.renderFolder(tree, folder, 0);

    const looseNotes = this.looseProjectNotes();
    if (looseNotes.length > 0) {
      const section = tree.createDiv({ cls: "rv-tree-section" });
      section.createSpan({ text: "Notes" });
      for (const file of looseNotes) this.renderFile(tree, file, 1);
    }

    if (folders.length === 0 && looseNotes.length === 0) {
      tree.createDiv({ cls: "rv-empty", text: "No project folders or notes." });
    }
  }

  private topLevelProjectFolders(): TFolder[] {
    const folders = this.project.folders
      .map((path) => this.app.vault.getAbstractFileByPath(path))
      .filter((f): f is TFolder => f instanceof TFolder)
      .sort((a, b) => a.path.localeCompare(b.path));

    return folders.filter(
      (folder, index) =>
        folders.findIndex((other) => folder.path === other.path) === index &&
        !folders.some(
          (other) =>
            other.path !== folder.path && folder.path.startsWith(other.path + "/")
        )
    );
  }

  private looseProjectNotes(): TFile[] {
    const insideProjectFolder = (file: TFile): boolean =>
      this.project.folders.some(
        (folderPath) => file.path === folderPath || file.path.startsWith(folderPath + "/")
      );

    return this.project.notes
      .map((path) => this.app.vault.getAbstractFileByPath(path))
      .filter((f): f is TFile => f instanceof TFile && !insideProjectFolder(f))
      .sort((a, b) => a.path.localeCompare(b.path));
  }

  private renderFolder(container: HTMLElement, folder: TFolder, depth: number): void {
    const row = container.createDiv({ cls: "rv-tree-row rv-tree-folder" });
    row.setCssProps({ "--rv-depth": String(depth) });
    setIcon(row.createSpan({ cls: "rv-file-icon" }), "folder");
    row.createSpan({ cls: "rv-file-name", text: folder.name || "/" });
    row.setAttribute("aria-label", `Open all notes in ${folder.path}`);
    row.onclick = () => {
      this.onFolder(folder);
      this.close();
    };

    const children = [...folder.children];
    const files = children
      .filter((child): child is TFile => child instanceof TFile && child.extension === "md")
      .sort((a, b) => a.basename.localeCompare(b.basename));
    const folders = children
      .filter((child): child is TFolder => child instanceof TFolder)
      .sort((a, b) => a.name.localeCompare(b.name));

    for (const file of files) this.renderFile(container, file, depth + 1);
    for (const child of folders) this.renderFolder(container, child, depth + 1);
  }

  private renderFile(container: HTMLElement, file: TFile, depth: number): void {
    const row = container.createDiv({ cls: "rv-tree-row rv-tree-file" });
    row.setCssProps({ "--rv-depth": String(depth) });
    setIcon(row.createSpan({ cls: "rv-file-icon" }), "file");
    row.createSpan({ cls: "rv-file-name", text: file.basename });
    row.setAttribute("aria-label", `Open ${file.path}`);
    row.onclick = () => {
      this.onFile(file);
      this.close();
    };
  }
}

class ConfirmModal extends Modal {
  private message: string;
  private onConfirm: () => void;

  constructor(app: App, message: string, onConfirm: () => void) {
    super(app);
    this.message = message;
    this.onConfirm = onConfirm;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.createEl("p", { text: this.message });
    const footer = contentEl.createDiv({ cls: "rv-modal-footer" });
    const yes = footer.createEl("button", { cls: "mod-warning", text: "Delete" });
    yes.onclick = () => {
      this.onConfirm();
      this.close();
    };
    const no = footer.createEl("button", { text: "Cancel" });
    no.onclick = () => this.close();
  }
}

class PromptModal extends Modal {
  private titleText: string;
  private value: string;
  private onSubmit: (value: string) => void;

  constructor(
    app: App,
    titleText: string,
    defaultValue: string,
    onSubmit: (value: string) => void
  ) {
    super(app);
    this.titleText = titleText;
    this.value = defaultValue;
    this.onSubmit = onSubmit;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.addClass("recent-view-modal");
    contentEl.createEl("h3", { text: this.titleText });

    let inputEl: HTMLInputElement | null = null;
    new Setting(contentEl).setName("Name").addText((t) => {
      t.setValue(this.value).onChange((v) => (this.value = v));
      inputEl = t.inputEl;
      t.inputEl.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          this.submit();
        }
      });
    });

    const footer = contentEl.createDiv({ cls: "rv-modal-footer" });
    const ok = footer.createEl("button", { cls: "mod-cta", text: "OK" });
    ok.onclick = () => this.submit();
    const cancel = footer.createEl("button", { text: "Cancel" });
    cancel.onclick = () => this.close();

    window.setTimeout(() => {
      inputEl?.focus();
      inputEl?.select();
    }, 0);
  }

  private submit(): void {
    const v = this.value.trim();
    if (!v) {
      new Notice("Name is required");
      return;
    }
    this.onSubmit(v);
    this.close();
  }
}

class DriveLinkModal extends Modal {
  private plugin: RecentViewPlugin;
  private project: Project;
  private folderLink = "";
  private localFolder = "";
  private resolvedName = "";

  constructor(app: App, plugin: RecentViewPlugin, project: Project) {
    super(app);
    this.plugin = plugin;
    this.project = project;
    this.localFolder = project.folders[0] ?? "";
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.addClass("recent-view-modal");
    contentEl.createEl("h3", { text: "Link to Google Drive folder" });
    contentEl.createEl("p", {
      cls: "setting-item-description",
      text:
        "Link this project to an existing Google Drive folder so you can upload " +
        "or download later. No files are transferred now.",
    });

    new Setting(contentEl)
      .setName("Drive folder")
      .setDesc("Paste a Google Drive folder share link or folder ID.")
      .addText((t) =>
        t
          .setPlaceholder("https://drive.google.com/drive/folders/…")
          .setValue(this.folderLink)
          .onChange((v) => {
            this.folderLink = v;
            this.resolvedName = "";
          })
      )
      .addButton((b) =>
        b.setButtonText("Fetch name").onClick(async () => {
          const id = parseDriveFolderId(this.folderLink);
          if (!id) {
            new Notice("Couldn't find a Google Drive folder in that link.");
            return;
          }
          if (!this.plugin.drive.isConnected()) {
            new Notice("Connect Google Drive in plugin settings first.");
            return;
          }
          try {
            this.resolvedName = await this.plugin.drive.getFolderName(id);
            new Notice(`Drive folder: "${this.resolvedName}"`);
          } catch (e) {
            new Notice(`Google Drive: ${(e as Error).message}`);
          }
        })
      );

    new Setting(contentEl)
      .setName("Local folder for upload/download")
      .setDesc("The vault folder whose contents map to the Drive folder.")
      .addText((t) =>
        t
          .setPlaceholder("Folder path (leave blank to use project's first folder)")
          .setValue(this.localFolder)
          .onChange((v) => (this.localFolder = v))
      )
      .addButton((b) =>
        b.setButtonText("Choose").onClick(() =>
          VaultTreeModal.pickFolder(this.app, (folder) => {
            this.localFolder = folder.path === "/" ? "" : folder.path;
            this.render();
          }).open()
        )
      );

    const footer = contentEl.createDiv({ cls: "rv-modal-footer" });
    const ok = footer.createEl("button", { cls: "mod-cta", text: "Link" });
    ok.onclick = () => void this.submit();
    const cancel = footer.createEl("button", { text: "Cancel" });
    cancel.onclick = () => this.close();
  }

  private render(): void {
    this.contentEl.empty();
    this.onOpen();
  }

  private async submit(): Promise<void> {
    const id = parseDriveFolderId(this.folderLink);
    if (!id) {
      new Notice("Couldn't find a Google Drive folder in that link.");
      return;
    }
    const local = this.localFolder.trim() || (this.project.folders[0] ?? "");
    this.close();
    await this.plugin.linkProjectToDrive(this.project, id, local);
  }
}

class DriveUploadAsNewModal extends Modal {
  private plugin: RecentViewPlugin;
  private project: Project;
  private parentLink = "";

  constructor(app: App, plugin: RecentViewPlugin, project: Project) {
    super(app);
    this.plugin = plugin;
    this.project = project;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.addClass("recent-view-modal");
    contentEl.createEl("h3", { text: "Upload to Google Drive as new folder" });
    contentEl.createEl("p", {
      cls: "setting-item-description",
      text:
        `Creates a new Google Drive folder named "${this.project.name}" ` +
        "under the chosen parent and uploads the project's local folder into it. " +
        "Leave the parent field empty to upload to My Drive root.",
    });

    new Setting(contentEl)
      .setName("Parent folder (optional)")
      .setDesc("Paste a Google Drive folder link or ID, or leave blank for My Drive root.")
      .addText((t) =>
        t
          .setPlaceholder("https://drive.google.com/drive/folders/… or blank")
          .setValue(this.parentLink)
          .onChange((v) => (this.parentLink = v))
      );

    const footer = contentEl.createDiv({ cls: "rv-modal-footer" });
    const ok = footer.createEl("button", { cls: "mod-cta", text: "Upload" });
    ok.onclick = () => void this.submit();
    const cancel = footer.createEl("button", { text: "Cancel" });
    cancel.onclick = () => this.close();
  }

  private async submit(): Promise<void> {
    let parentId = "root";
    const link = this.parentLink.trim();
    if (link) {
      const parsed = parseDriveFolderId(link);
      if (!parsed) {
        new Notice("Couldn't find a Google Drive folder in that link.");
        return;
      }
      parentId = parsed;
    }
    this.close();
    await this.plugin.uploadProjectToDriveAsNewFolder(this.project, parentId);
  }
}

class DriveVersionPickerModal extends Modal {
  private plugin: RecentViewPlugin;
  private project: Project;
  private file: TFile;
  private static readonly LIMIT = 10;

  constructor(app: App, plugin: RecentViewPlugin, project: Project, file: TFile) {
    super(app);
    this.plugin = plugin;
    this.project = project;
    this.file = file;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.addClass("recent-view-modal");
    contentEl.createEl("h3", { text: `Drive versions — ${this.file.basename}` });
    const status = contentEl.createEl("p", {
      cls: "setting-item-description",
      text: "Loading…",
    });
    const list = contentEl.createDiv({ cls: "rv-version-list" });
    void this.loadList(status, list);
  }

  private async loadList(status: HTMLElement, list: HTMLElement): Promise<void> {
    let revisions: DriveRevision[];
    let driveFileId: string;
    try {
      const res = await this.plugin.listDriveRevisionsForFile(
        this.project,
        this.file,
        DriveVersionPickerModal.LIMIT
      );
      revisions = res.revisions;
      driveFileId = res.driveFileId;
    } catch (e) {
      status.setText((e as Error).message);
      return;
    }
    if (revisions.length === 0) {
      status.setText("No revisions on Drive.");
      return;
    }
    status.setText(
      "Drive prunes non-pinned revisions of binary files (~100 / 30 days). " +
        "Click a version to open its contents as a new note."
    );
    revisions.forEach((rev, idx) => {
      const label = `v${idx + 1}`;
      const row = list.createDiv({ cls: "rv-version-row" });
      const left = row.createDiv({ cls: "rv-version-row-left" });
      left.createSpan({ cls: "rv-version-label", text: label });
      const when = rev.modifiedTime
        ? new Date(rev.modifiedTime).toLocaleString()
        : "unknown time";
      left.createSpan({ cls: "rv-version-time", text: when });
      const right = row.createDiv({ cls: "rv-version-row-right" });
      if (rev.size) {
        right.createSpan({
          cls: "rv-version-size",
          text: formatBytes(Number(rev.size)),
        });
      }
      if (rev.keepForever) {
        right.createSpan({ cls: "rv-version-pin", text: "pinned" });
      }
      const fileLabel = formatFilenameTimestamp(rev.modifiedTime);
      row.onclick = () => {
        this.close();
        void this.plugin.openDriveVersionAsNewNote(
          this.file,
          driveFileId,
          rev.id,
          fileLabel
        );
      };
    });
  }
}

class RecentViewSettingTab extends PluginSettingTab {
  plugin: RecentViewPlugin;

  constructor(app: App, plugin: RecentViewPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    this.renderSettings();
  }

  /** Build the settings UI. Use this instead of calling `display()` internally. */
  private renderSettings(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName("Data note path")
      .setDesc(
        "Vault-relative path of the note that stores this vault's projects. " +
          "Stored inside the vault so the data is per-vault and travels with it."
      )
      .addText((text) =>
        text
          .setPlaceholder(DEFAULT_SETTINGS.dataNotePath)
          .setValue(this.plugin.settings.dataNotePath)
          .onChange(async (value) => {
            const next = value.trim() || DEFAULT_SETTINGS.dataNotePath;
            if (next === this.plugin.settings.dataNotePath) return;
            this.plugin.settings.dataNotePath = next;
            // Write the current data to the new location immediately.
            await this.plugin.persistNow();
          })
      );

    new Setting(containerEl)
      .setName("Close inactive pane groups when switching projects")
      .setDesc(
        "When enabled, the previous project's tab group is closed after switching. " +
          "This keeps the workspace as a single flat pane and avoids split-pane issues. " +
          "When disabled, inactive groups are hidden with CSS so switching back is instant " +
          "(but may cause tabs to appear in a split pane on some layouts)."
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.closePanesOnSwitch)
          .onChange(async (value) => {
            this.plugin.settings.closePanesOnSwitch = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Recent edits to keep")
      .setDesc(
        "How many recently edited notes the Recent edits pane shows. Default 8."
      )
      .addText((text) => {
        text.inputEl.type = "number";
        text.inputEl.min = "1";
        text
          .setPlaceholder(String(DEFAULT_EDIT_HISTORY))
          .setValue(String(this.plugin.settings.editHistorySize))
          .onChange(async (value) => {
            const n = parseInt(value, 10);
            const next = Number.isFinite(n) && n > 0 ? n : DEFAULT_EDIT_HISTORY;
            this.plugin.settings.editHistorySize = next;
            if (this.plugin.editHistory.length > next) {
              this.plugin.editHistory.length = next;
            }
            await this.plugin.saveSettings();
            this.plugin.refreshEditView();
          });
      });

    new Setting(containerEl)
      .setName("Track whitespace-only changes")
      .setDesc(
        "When enabled, edits that only add or remove whitespace (e.g. new lines, " +
          "spaces) are recorded in the Recent edits pane too."
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.trackWhitespaceEdits)
          .onChange(async (value) => {
            this.plugin.settings.trackWhitespaceEdits = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl).setName("Google Drive").setHeading();

    containerEl.createEl("p", {
      cls: "setting-item-description",
      text:
        "Create an OAuth client (type: Desktop app) in Google Cloud Console, " +
        "enable the Google Drive API, then paste the Client ID and Secret " +
        "below and click Connect. Desktop only.",
    });

    new Setting(containerEl).setName("Client ID").addText((text) =>
      text
        .setValue(this.plugin.settings.gdriveClientId)
        .onChange(async (v) => {
          this.plugin.settings.gdriveClientId = v.trim();
          await this.plugin.saveSettings();
        })
    );

    new Setting(containerEl).setName("Client Secret").addText((text) => {
      text.inputEl.type = "password";
      text.setValue(this.plugin.settings.gdriveClientSecret).onChange(async (v) => {
        this.plugin.settings.gdriveClientSecret = v.trim();
        await this.plugin.saveSettings();
      });
    });

    const connected = this.plugin.drive.isConnected();
    new Setting(containerEl)
      .setName("Connection")
      .setDesc(connected ? "Connected to Google Drive." : "Not connected.")
      .addButton((b) =>
        b
          .setButtonText(connected ? "Reconnect" : "Connect")
          .setCta()
          .onClick(async () => {
            if (!isDesktop()) {
              new Notice("Google Drive sign-in is desktop-only.");
              return;
            }
            try {
              new Notice("Opening Google sign-in in your browser…");
              await this.plugin.drive.connect();
              new Notice("Connected to Google Drive.");
              this.renderSettings();
            } catch (e) {
              console.error("[RecentView] Google Drive connect failed", e);
              new Notice(`Google Drive connect failed: ${(e as Error).message}`, 12000);
            }
          })
      )
      .addExtraButton((b) =>
        b
          .setIcon("log-out")
          .setTooltip("Disconnect")
          .onClick(async () => {
            await this.plugin.drive.disconnect();
            this.renderSettings();
          })
      );
  }
}
