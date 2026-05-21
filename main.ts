import {
  ItemView,
  Menu,
  Modal,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  TFolder,
  Vault,
  WorkspaceLeaf,
  WorkspaceParent,
  FuzzySuggestModal,
  setIcon,
  App,
} from "obsidian";

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

interface Project {
  id: string;
  name: string;
  description: string;
  folders: string[];
  notes: string[];
  lastOpenNotes: OpenNote[];
  // Note paths pinned to the top of the content pane, above the folders.
  pinned: string[];
}

interface RecentViewData {
  projects: Project[];
  activeProjectId: string | null;
}

interface RecentViewSettings {
  // Vault-relative path of the note that stores this vault's project data.
  dataNotePath: string;
}

const DEFAULT_SETTINGS: RecentViewSettings = {
  dataNotePath: "RecentView.md",
};

// Header written above the JSON block so the note is self-explanatory.
const DATA_NOTE_HEADER =
  "# Recent View data\n\n" +
  "This note is managed by the **Recent View** plugin and stores this " +
  "vault's projects. Avoid editing the JSON block below by hand.";

function genId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
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

export default class RecentViewPlugin extends Plugin {
  data: RecentViewData = { projects: [], activeProjectId: null };
  settings: RecentViewSettings = { ...DEFAULT_SETTINGS };
  private isActivating = false;
  private noteWriteTimer: number | null = null;
  // Live tab group (pane) per project, kept alive so switching just shows/hides
  // panes instead of closing and reopening notes.
  private projectGroups: Map<string, WorkspaceParent> = new Map();

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
      this.app.workspace.on("layout-change", () => this.saveActiveProjectTabs())
    );

    this.app.workspace.onLayoutReady(() => {
      this.activateListView();

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
      this.registerEvent(this.app.vault.on("rename", onVaultChange));
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
    for (const project of this.data.projects) {
      project.lastOpenNotes = (
        (project.lastOpenNotes ?? []) as unknown as (string | OpenNote)[]
      ).map((n) => (typeof n === "string" ? { path: n } : n));
      project.pinned = project.pinned ?? [];
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
      const left = workspace.getLeftLeaf(false);
      if (!left) return;
      leaf = left;
      await leaf.setViewState({ type: VIEW_TYPE_PROJECT_LIST, active: true });
    }
    workspace.revealLeaf(leaf);
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
    // Snapshot the outgoing project's tabs (only if it has a live pane).
    this.saveActiveProjectTabs();

    this.isActivating = true;
    this.data.activeProjectId = project.id;

    // Update the selection UI synchronously.
    this.refreshListView();
    void this.activateContentView();

    try {
      let group = this.getLiveGroup(project.id);
      if (!group) group = await this.createProjectGroup(project);
      if (group) {
        this.projectGroups.set(project.id, group);
        this.applyGroupVisibility(project.id);
        this.focusGroup(group);
      }
    } catch (e) {
      console.error("[RecentView] failed to open project pane", e);
    }

    await this.persist();

    // Release the guard after the layout settles.
    window.setTimeout(() => {
      this.isActivating = false;
    }, 150);
  }

  /** Build a new tab group for a project from its saved notes. */
  private async createProjectGroup(
    project: Project
  ): Promise<WorkspaceParent | null> {
    const notes = this.resolveNotes(project);
    const { workspace } = this.app;

    let firstLeaf: WorkspaceLeaf;
    if (!this.hasAnyLiveGroup()) {
      // No project pane exists yet: adopt the current main area by keeping one
      // leaf (so a tab group survives) and closing the rest.
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

  private resolveNotes(project: Project): {
    file: TFile;
    eState: Record<string, unknown> | undefined;
    active: boolean;
  }[] {
    return project.lastOpenNotes
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

  /** The container element of a tab group, or null if it's gone. */
  private groupContainer(group: WorkspaceParent): HTMLElement | null {
    const el = (group as unknown as { containerEl?: HTMLElement }).containerEl;
    return el ?? null;
  }

  /** Return the project's tab group if it still exists in the layout. */
  private getLiveGroup(projectId: string | null): WorkspaceParent | null {
    if (!projectId) return null;
    const group = this.projectGroups.get(projectId);
    if (!group) return null;
    const el = this.groupContainer(group);
    if (!el || !el.isConnected) {
      this.projectGroups.delete(projectId);
      return null;
    }
    return group;
  }

  getActiveGroup(): WorkspaceParent | null {
    return this.getLiveGroup(this.data.activeProjectId);
  }

  private hasAnyLiveGroup(): boolean {
    for (const [id] of this.projectGroups) {
      if (this.getLiveGroup(id)) return true;
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

  /** Focus the active project's pane (used before opening a note into it). */
  focusActiveGroup(): void {
    const group = this.getActiveGroup();
    if (group) this.focusGroup(group);
  }

  saveActiveProjectTabs(force = false): number {
    if (this.isActivating && !force) return -1;
    const project = this.getActiveProject();
    if (!project) return -1;
    const group = this.getLiveGroup(project.id);
    if (!group) return -1; // No live pane yet (e.g. startup): nothing to save.

    const activeLeaf = this.app.workspace.getMostRecentLeaf(
      this.app.workspace.rootSplit
    );
    const activePath = activeLeaf?.getViewState().state?.file;

    const open: OpenNote[] = [];
    this.app.workspace.iterateRootLeaves((leaf) => {
      // Only capture tabs that belong to this project's pane.
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
    project.lastOpenNotes = open;
    void this.persist();
    return open.length;
  }

  async deleteProject(project: Project): Promise<void> {
    // Close the project's pane if it is live.
    const group = this.projectGroups.get(project.id);
    if (group) {
      const toClose: WorkspaceLeaf[] = [];
      this.app.workspace.iterateRootLeaves((leaf) => {
        if (this.leafInGroup(leaf, group)) toClose.push(leaf);
      });
      for (const leaf of toClose) leaf.detach();
      this.projectGroups.delete(project.id);
    }

    this.data.projects = this.data.projects.filter((p) => p.id !== project.id);
    if (this.data.activeProjectId === project.id) {
      this.data.activeProjectId = null;
    }
    await this.persistNow();
    this.refreshListView();
    this.refreshContentView();
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
        menu.showAtMouseEvent(e);
      };

      box.onclick = () => void this.plugin.openProject(project);
    }
  }
}

class ProjectContentView extends ItemView {
  plugin: RecentViewPlugin;

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
    const project = this.plugin.getActiveProject();
    header.createEl("h4", {
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
      menu.addItem((item) =>
        item
          .setTitle("Refresh")
          .setIcon("refresh-cw")
          .onClick(() => this.render())
      );
      menu.showAtMouseEvent(e);
    };

    if (!project) {
      c.createDiv({
        cls: "rv-empty",
        text: "Open a project to see its folders and notes.",
      });
      return;
    }

    if (project.description) {
      c.createDiv({ cls: "rv-project-desc", text: project.description });
    }

    // Pinned notes, shown above all folders in their saved (drag-reorderable)
    // order.
    const pinnedFiles = (project.pinned ?? [])
      .map((path) => this.plugin.app.vault.getAbstractFileByPath(path))
      .filter((f): f is TFile => f instanceof TFile);
    if (pinnedFiles.length > 0) {
      const section = c.createDiv({ cls: "rv-folder-section rv-pinned-section" });
      const head = section.createDiv({ cls: "rv-folder-head" });
      setIcon(head.createSpan({ cls: "rv-folder-icon" }), "pin");
      head.createSpan({ text: "Pinned" });
      const fileList = section.createDiv({ cls: "rv-file-list" });
      for (const file of pinnedFiles) {
        const item = this.renderFileItem(fileList, file);
        this.makePinDraggable(item, file, project);
      }
    }

    for (const folderPath of project.folders) {
      const folder = this.plugin.app.vault.getAbstractFileByPath(folderPath);
      const section = c.createDiv({ cls: "rv-folder-section" });
      const head = section.createDiv({ cls: "rv-folder-head" });
      setIcon(head.createSpan({ cls: "rv-folder-icon" }), "folder");
      head.createSpan({ text: folder?.name ?? folderPath });

      const fileList = section.createDiv({ cls: "rv-file-list" });
      if (folder instanceof TFolder) {
        const files = collectMarkdown(folder);
        if (files.length === 0) {
          fileList.createDiv({ cls: "rv-empty-sm", text: "No notes" });
        }
        for (const f of files) this.renderFileItem(fileList, f);
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

  private renderFileItem(container: HTMLElement, file: TFile): HTMLElement {
    const item = container.createDiv({ cls: "rv-file-item" });
    setIcon(item.createSpan({ cls: "rv-file-icon" }), "file");
    item.createSpan({ cls: "rv-file-name", text: file.basename });
    item.onclick = () => this.openOrFocus(file);

    const project = this.plugin.getActiveProject();
    const pinned = !!project && (project.pinned ?? []).includes(file.path);
    const pinBtn = item.createEl("button", { cls: "rv-icon-btn rv-pin-btn" });
    if (pinned) pinBtn.addClass("is-pinned");
    setIcon(pinBtn, "pin");
    pinBtn.setAttribute("aria-label", pinned ? "Unpin from top" : "Pin to top");
    pinBtn.onclick = (e) => {
      e.stopPropagation();
      if (project) void this.plugin.togglePin(project, file.path);
    };
    return item;
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

function collectMarkdown(folder: TFolder): TFile[] {
  const out: TFile[] = [];
  const walk = (f: TFolder) => {
    for (const child of f.children) {
      if (child instanceof TFolder) walk(child);
      else if (child instanceof TFile && child.extension === "md") out.push(child);
    }
  };
  walk(folder);
  return out.sort((a, b) => a.basename.localeCompare(b.basename));
}

class ProjectEditModal extends Modal {
  plugin: RecentViewPlugin;
  project: Project | null;
  private name: string;
  private description: string;
  private folders: string[];
  private notes: string[];

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

    const footer = contentEl.createDiv({ cls: "rv-modal-footer" });
    const saveBtn = footer.createEl("button", {
      cls: "mod-cta",
      text: "Save",
    });
    saveBtn.onclick = () => void this.save();
    const cancelBtn = footer.createEl("button", { text: "Cancel" });
    cancelBtn.onclick = () => this.close();
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

  constructor(app: App, onChoose: (folder: TFolder) => void) {
    super(app);
    this.onChoose = onChoose;
    this.setPlaceholder("Pick a folder");
  }

  getItems(): TFolder[] {
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

  constructor(app: App, onChoose: (file: TFile) => void) {
    super(app);
    this.onChoose = onChoose;
    this.setPlaceholder("Pick a note");
  }

  getItems(): TFile[] {
    return this.app.vault.getMarkdownFiles();
  }

  getItemText(item: TFile): string {
    return item.path;
  }

  onChooseItem(item: TFile): void {
    this.onChoose(item);
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
  }
}
