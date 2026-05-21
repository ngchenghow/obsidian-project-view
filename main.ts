import {
  ItemView,
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
  FuzzySuggestModal,
  setIcon,
  App,
} from "obsidian";
import {
  GoogleDriveClient,
  isDesktop,
  parseDriveFolderId,
} from "./gdrive";

const VIEW_TYPE_PROJECT_LIST = "recent-view-project-list";
const VIEW_TYPE_PROJECT_CONTENT = "recent-view-project-content";

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
}

interface RecentViewData {
  projects: Project[];
  activeProjectId: string | null;
}

interface RecentViewSettings {
  // Vault-relative path of the note that stores this vault's project data.
  dataNotePath: string;
  // Google Drive OAuth credentials + token.
  gdriveClientId: string;
  gdriveClientSecret: string;
  gdriveRefreshToken: string;
}

const DEFAULT_SETTINGS: RecentViewSettings = {
  dataNotePath: "RecentView.md",
  gdriveClientId: "",
  gdriveClientSecret: "",
  gdriveRefreshToken: "",
};

// Header written above the JSON block so the note is self-explanatory.
const DATA_NOTE_HEADER =
  "# Recent View data\n\n" +
  "This note is managed by the **Recent View** plugin and stores this " +
  "vault's projects. Avoid editing the JSON block below by hand.";

function genId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function sanitizeVaultName(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, "_").trim() || "Google Drive";
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
  const prevPointerEvents = paneEl.style.pointerEvents;
  paneEl.style.pointerEvents = "none";
  menu.onHide(() => {
    btn?.removeClass("is-active");
    paneEl.style.pointerEvents = prevPointerEvents;
  });
  menu.showAtMouseEvent(event);
}

export default class RecentViewPlugin extends Plugin {
  data: RecentViewData = { projects: [], activeProjectId: null };
  settings: RecentViewSettings = { ...DEFAULT_SETTINGS };
  private isActivating = false;
  private noteWriteTimer: number | null = null;
  // Live tab group (pane) per project, kept alive so switching just shows/hides
  // panes instead of closing and reopening notes.
  private projectGroups: Map<string, WorkspaceParent> = new Map();
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

    this.addRibbonIcon("folder-kanban", "Recent View: projects", () =>
      this.activateListView()
    );

    this.addCommand({
      id: "open-projects-pane",
      name: "Open projects pane",
      callback: () => this.activateListView(),
    });

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

    this.app.workspace.onLayoutReady(() => {
      this.arrangeLeftSidebar();

      // Rebuild only the active project's pane on startup (other projects'
      // panes are recreated lazily the first time they are clicked).
      const active = this.getActiveProject();
      if (active) void this.openProject(active);

      // Keep the content pane in sync when notes are added/removed/renamed in
      // the vault (e.g. a new note created inside a project folder). Registered
      // after layout is ready so the initial "create" burst is not handled.
      const onVaultChange = () => this.refreshContentView();
      this.registerEvent(this.app.vault.on("create", onVaultChange));
      this.registerEvent(this.app.vault.on("delete", onVaultChange));
      this.registerEvent(
        this.app.vault.on("rename", (file, oldPath) => {
          this.handlePathRename(oldPath, file.path);
          this.refreshContentView();
        })
      );
    });
  }

  onunload(): void {
    // Flush any debounced note write so nothing is lost on disable/close.
    if (this.noteWriteTimer !== null) {
      window.clearTimeout(this.noteWriteTimer);
      this.noteWriteTimer = null;
      void this.writeDataNote();
    }
  }

  /**
   * Load settings (from the plugin's data.json) and project data (from the
   * note inside the vault). Falls back to migrating legacy project data that
   * older versions stored in data.json.
   */
  async loadAll(): Promise<void> {
    const stored = ((await this.loadData()) ?? {}) as Partial<
      RecentViewSettings & RecentViewData
    >;
    this.settings = {
      dataNotePath: stored.dataNotePath || DEFAULT_SETTINGS.dataNotePath,
      gdriveClientId: stored.gdriveClientId ?? "",
      gdriveClientSecret: stored.gdriveClientSecret ?? "",
      gdriveRefreshToken: stored.gdriveRefreshToken ?? "",
    };

    const fromNote = await this.readDataNote();
    if (fromNote) {
      this.data = fromNote;
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
      project.pinned = project.pinned ?? [];
      project.panes = (project.panes ?? []).map((p) => ({
        id: p.id,
        name: p.name,
        lastOpenNotes: migrateNotes(p.lastOpenNotes),
        lastClosedNotes: migrateNotes(p.lastClosedNotes),
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
    await this.saveData(this.settings);
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
    if (changed) void this.persist();
  }

  /** Reorder pinned notes: move fromPath next to toPath (after or before). */
  async movePin(
    project: Project,
    fromPath: string,
    toPath: string,
    after: boolean
  ): Promise<void> {
    const pinned = project.pinned ?? (project.pinned = []);
    const from = pinned.indexOf(fromPath);
    if (from < 0) return;
    pinned.splice(from, 1);
    const target = pinned.indexOf(toPath);
    if (target < 0) pinned.push(fromPath);
    else pinned.splice(after ? target + 1 : target, 0, fromPath);
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
    workspace.revealLeaf(leaf);
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
      return;
    }
    for (const l of workspace.getLeavesOfType(VIEW_TYPE_PROJECT_LIST)) {
      l.detach();
    }
    const leaf = workspace.createLeafBySplit(fileExplorer, "horizontal", true);
    void leaf
      .setViewState({ type: VIEW_TYPE_PROJECT_LIST, active: true })
      .then(() => workspace.revealLeaf(leaf));
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
    workspace.revealLeaf(leaf);
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

  /**
   * Open a project: show its live pane (tab group), creating it from the saved
   * notes the first time. Other projects' panes are hidden, not closed, so
   * their tabs keep their full editor state.
   */
  async openProject(project: Project): Promise<void> {
    await this.showPane(project, project.activePaneId ?? null);
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
    // Snapshot the currently visible pane before switching away.
    this.saveActiveProjectTabs();

    this.isActivating = true;
    this.data.activeProjectId = project.id;
    project.activePaneId = paneId;

    // Update the selection UI synchronously.
    this.refreshListView();
    void this.activateContentView();

    const key = this.paneKey(project.id, paneId);
    try {
      let group = this.getLiveGroup(key);
      if (!group) group = await this.createPaneGroup(project, paneId);
      if (group) {
        this.projectGroups.set(key, group);
        this.applyGroupVisibility(key);
        this.focusGroup(group);
      }
    } catch (e) {
      console.error("[RecentView] failed to open pane", e);
    }

    await this.persist();

    // Release the guard after the layout settles.
    window.setTimeout(() => {
      this.isActivating = false;
    }, 150);
  }

  /** Build a new tab group for a pane from its saved notes. */
  private async createPaneGroup(
    project: Project,
    paneId: string | null
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
      const leaf = workspace.getLeaf("tab");
      await leaf.openFile(notes[i].file, { eState: notes[i].eState });
      opened.push(leaf);
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
      if (projectId === activeId) {
        // Fill the root split, but allow shrinking below the tab-header content
        // width (min-width:auto would otherwise stop the main area from getting
        // narrower as more tabs open, limiting how far the sidebar can grow).
        el.style.display = "";
        el.style.flexGrow = "1";
        el.style.flexShrink = "1";
        el.style.flexBasis = "0";
        el.style.minWidth = "0";
        el.style.width = "";
      } else {
        el.style.display = "none";
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
    if (this.isActivating) return;
    const project = this.getActiveProject();
    if (!project) return;
    const paneId = project.activePaneId ?? null;
    const key = this.paneKey(project.id, paneId);
    if (this.getLiveGroup(key)) {
      this.saveActiveProjectTabs();
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
    if (this.isActivating && !force) return -1;
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
          eState: leaf.getEphemeralState(),
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

  /** Upload a single file to its matching place in the project's Drive folder. */
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
    let dirParts: string[] = [];
    if (local && file.path.startsWith(local + "/")) {
      const parts = file.path.slice(local.length + 1).split("/");
      parts.pop(); // drop the file name
      dirParts = parts;
    }
    new Notice(`Uploading "${file.name}" to Google Drive…`);
    try {
      await this.drive.uploadSingleFile(project.driveFolderId, file, dirParts);
      new Notice(`Uploaded "${file.name}" to Google Drive.`);
    } catch (e) {
      new Notice(`Google Drive upload failed: ${(e as Error).message}`);
    }
  }
}

class ProjectListView extends ItemView {
  plugin: RecentViewPlugin;

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
    header.createEl("span", { cls: "rv-header-title", text: "Projects" });
    const addBtn = header.createEl("button", {
      cls: "rv-new-btn",
      text: "+ New",
    });
    addBtn.onclick = () =>
      new ProjectEditModal(this.plugin.app, this.plugin, null).open();

    const list = c.createDiv({ cls: "rv-project-list" });

    if (this.plugin.data.projects.length === 0) {
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

      box.onclick = () => void this.plugin.openProject(project);
    }
  }
}

class ProjectContentView extends ItemView {
  plugin: RecentViewPlugin;
  private reordering = false;

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
            .setTitle("New pane")
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
        if (this.reordering) this.makePinDraggable(item, file, project);
      }
    } else if (this.reordering) {
      // No pinned notes left to reorder.
      this.reordering = false;
    }

    for (const folderPath of project.folders) {
      const folder = this.plugin.app.vault.getAbstractFileByPath(folderPath);
      const section = c.createDiv({ cls: "rv-folder-section" });
      const head = section.createDiv({ cls: "rv-folder-head" });
      setIcon(head.createSpan({ cls: "rv-folder-icon" }), "folder");
      head.createSpan({ text: folder?.name ?? folderPath });
      const menuBtn = head.createEl("button", {
        cls: "rv-icon-btn rv-head-menu",
      });
      setIcon(menuBtn, "more-vertical");
      menuBtn.setAttribute("aria-label", "More options");
      menuBtn.onclick = (e) => {
        e.stopPropagation();
        const menu = new Menu();
        if (folder instanceof TFolder) {
          menu.addItem((i) =>
            i
              .setTitle("Rename")
              .setIcon("pencil")
              .onClick(() => new RenameModal(this.plugin.app, folder).open())
          );
        }
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

      const fileList = section.createDiv({ cls: "rv-file-list" });
      if (folder instanceof TFolder) {
        const count = this.renderFolderTree(fileList, folder);
        if (count === 0) {
          fileList.createDiv({ cls: "rv-empty-sm", text: "No notes" });
        }
      } else {
        fileList.createDiv({ cls: "rv-empty-sm", text: "Folder not found" });
      }
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
  }

  /** List the project's panes (main + named) when it has named panes. */
  private renderPanes(c: HTMLElement, project: Project): void {
    if (!project.panes || project.panes.length === 0) return;
    const activePaneId = project.activePaneId ?? null;
    const section = c.createDiv({ cls: "rv-folder-section rv-panes-section" });
    const head = section.createDiv({ cls: "rv-folder-head" });
    setIcon(head.createSpan({ cls: "rv-folder-icon" }), "layout-grid");
    head.createSpan({ text: "Panes" });
    const list = section.createDiv({ cls: "rv-file-list" });

    this.renderPaneItem(list, project, null, "Main", activePaneId === null);
    for (const pane of project.panes) {
      this.renderPaneItem(
        list,
        project,
        pane.id,
        pane.name,
        activePaneId === pane.id
      );
    }
  }

  private renderPaneItem(
    list: HTMLElement,
    project: Project,
    paneId: string | null,
    name: string,
    isActive: boolean
  ): void {
    const item = list.createDiv({ cls: "rv-file-item rv-pane-item" });
    if (isActive) item.addClass("is-active");
    setIcon(
      item.createSpan({ cls: "rv-file-icon" }),
      paneId ? "gallery-vertical" : "home"
    );
    item.createSpan({ cls: "rv-file-name", text: name });
    item.onclick = () => void this.plugin.showPane(project, paneId);

    const menuBtn = item.createEl("button", { cls: "rv-icon-btn rv-item-menu" });
    setIcon(menuBtn, "more-vertical");
    menuBtn.setAttribute("aria-label", "Pane options");
    menuBtn.onclick = (e) => {
      e.stopPropagation();
      const menu = new Menu();
      const lastClosed = this.plugin.lastClosedNote(project, paneId);
      menu.addItem((i) =>
        i
          .setTitle(
            lastClosed
              ? `Open last closed tab: ${lastClosed.path}`
              : "Open last closed tab"
          )
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
  }

  private renderFileItem(container: HTMLElement, file: TFile): HTMLElement {
    const item = container.createDiv({ cls: "rv-file-item" });
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
    return item;
  }

  /**
   * Render a folder's notes (sorted), then each subfolder's notes below a
   * separator labelled with the subfolder name (recursively). Returns the total
   * number of notes rendered.
   */
  private renderFolderTree(container: HTMLElement, folder: TFolder): number {
    const children = [...folder.children];
    const files = children
      .filter((c): c is TFile => c instanceof TFile && c.extension === "md")
      .sort((a, b) => a.basename.localeCompare(b.basename));
    const subfolders = children
      .filter((c): c is TFolder => c instanceof TFolder)
      .sort((a, b) => a.name.localeCompare(b.name));

    let count = 0;
    for (const f of files) {
      this.renderFileItem(container, f);
      count++;
    }
    for (const sub of subfolders) {
      if (countMarkdown(sub) === 0) continue;
      const sep = container.createDiv({ cls: "rv-subfolder-sep" });
      sep.createSpan({ cls: "rv-subfolder-label", text: sub.name });
      count += this.renderFolderTree(container, sub);
    }
    return count;
  }

  private showFileMenu(e: MouseEvent, file: TFile, btn: HTMLElement): void {
    const project = this.plugin.getActiveProject();
    const menu = new Menu();
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
    if (project?.driveFolderId) {
      menu.addItem((i) =>
        i
          .setTitle("Upload to Google Drive")
          .setIcon("cloud-upload")
          .onClick(() => void this.plugin.uploadFileToDrive(project, file))
      );
    }
    showMenu(menu, e, this.contentEl, btn);
  }

  /** Make a pinned item draggable so the pinned list can be reordered. */
  private makePinDraggable(
    item: HTMLElement,
    file: TFile,
    project: Project
  ): void {
    item.draggable = true;
    item.addClass("rv-pin-draggable");
    item.addEventListener("dragstart", (e) => {
      e.dataTransfer?.setData("text/plain", file.path);
      if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
      item.addClass("rv-dragging");
    });
    item.addEventListener("dragend", () => item.removeClass("rv-dragging"));
    item.addEventListener("dragover", (e) => {
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
      const rect = item.getBoundingClientRect();
      const after = e.clientY > rect.top + rect.height / 2;
      item.toggleClass("rv-drop-after", after);
      item.toggleClass("rv-drop-before", !after);
    });
    item.addEventListener("dragleave", () => {
      item.removeClass("rv-drop-before");
      item.removeClass("rv-drop-after");
    });
    item.addEventListener("drop", (e) => {
      e.preventDefault();
      const after = item.hasClass("rv-drop-after");
      item.removeClass("rv-drop-before");
      item.removeClass("rv-drop-after");
      const fromPath = e.dataTransfer?.getData("text/plain");
      if (fromPath && fromPath !== file.path) {
        void this.plugin.movePin(project, fromPath, file.path, after);
      }
    });
  }

  private openOrFocus(file: TFile): void {
    const { workspace } = this.plugin.app;
    const group = this.plugin.getActiveGroup();
    // If the file is already open in the active project's pane, focus that tab
    // instead of opening a duplicate.
    const existing = this.findLeafForFile(file, group);
    if (existing) {
      workspace.setActiveLeaf(existing, { focus: true });
      workspace.revealLeaf(existing);
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
          new FolderSuggestModal(this.app, (folder) => {
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
          new FileSuggestModal(this.app, (file) => {
            if (!this.notes.includes(file.path)) this.notes.push(file.path);
            this.renderForm();
          }).open();
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
          new FolderSuggestModal(this.app, (folder) => {
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

class FolderSuggestModal extends FuzzySuggestModal<TFolder> {
  private onChoose: (folder: TFolder) => void;
  private items?: TFolder[];

  constructor(
    app: App,
    onChoose: (folder: TFolder) => void,
    items?: TFolder[]
  ) {
    super(app);
    this.onChoose = onChoose;
    this.items = items;
    this.setPlaceholder("Pick a folder");
  }

  getItems(): TFolder[] {
    if (this.items) return this.items;
    const folders: TFolder[] = [];
    Vault.recurseChildren(this.app.vault.getRoot(), (f) => {
      if (f instanceof TFolder) folders.push(f);
    });
    return folders;
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
  private items?: TFile[];

  constructor(app: App, onChoose: (file: TFile) => void, items?: TFile[]) {
    super(app);
    this.onChoose = onChoose;
    this.items = items;
    this.setPlaceholder("Pick a note");
  }

  getItems(): TFile[] {
    return this.items ?? this.app.vault.getMarkdownFiles();
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
    row.style.paddingLeft = `${8 + depth * 14}px`;
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
    row.style.paddingLeft = `${8 + depth * 14}px`;
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

class RecentViewSettingTab extends PluginSettingTab {
  plugin: RecentViewPlugin;

  constructor(app: App, plugin: RecentViewPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
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
              this.display();
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
            this.display();
          })
      );
  }
}
