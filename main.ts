import {
  ItemView,
  Modal,
  Notice,
  Plugin,
  Setting,
  TFile,
  TFolder,
  Vault,
  WorkspaceLeaf,
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
}

interface Project {
  id: string;
  name: string;
  description: string;
  folders: string[];
  notes: string[];
  lastOpenNotes: OpenNote[];
}

interface RecentViewData {
  projects: Project[];
  activeProjectId: string | null;
}

const DEFAULT_DATA: RecentViewData = {
  projects: [],
  activeProjectId: null,
};

function genId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

export default class RecentViewPlugin extends Plugin {
  data: RecentViewData = DEFAULT_DATA;
  private isActivating = false;

  async onload(): Promise<void> {
    this.data = Object.assign({}, DEFAULT_DATA, await this.loadData());

    // Migrate lastOpenNotes from the old string[] format to OpenNote[].
    for (const project of this.data.projects) {
      project.lastOpenNotes = (
        project.lastOpenNotes as unknown as (string | OpenNote)[]
      ).map((n) => (typeof n === "string" ? { path: n } : n));
    }

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

    this.app.workspace.onLayoutReady(() => this.activateListView());
  }

  async persist(): Promise<void> {
    await this.saveData(this.data);
  }

  getActiveProject(): Project | null {
    return (
      this.data.projects.find((p) => p.id === this.data.activeProjectId) ?? null
    );
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
   * Opening a project: close every open tab in the main area, then restore the
   * notes that were open the last time this project was active.
   */
  async openProject(project: Project): Promise<void> {
    // Persist the outgoing project's tabs while they are still on screen,
    // before we change activeProjectId or detach anything.
    this.saveActiveProjectTabs();

    this.isActivating = true;
    this.data.activeProjectId = project.id;

    // Update the selection UI synchronously, before any async tab work that
    // could throw and leave the highlight stuck on the previous project.
    this.refreshListView();
    void this.activateContentView();

    // Collect the current main-area leaves.
    // Note: iterateRootLeaves stops as soon as the callback returns a truthy
    // value, so the body must not return one (Array.push returns a number).
    const existing: WorkspaceLeaf[] = [];
    this.app.workspace.iterateRootLeaves((leaf) => {
      existing.push(leaf);
    });

    const notes = project.lastOpenNotes
      .map((n) => ({
        file: this.app.vault.getAbstractFileByPath(n.path),
        eState: n.eState,
      }))
      .filter((n): n is { file: TFile; eState?: Record<string, unknown> } =>
        n.file instanceof TFile
      );

    if (notes.length === 0) {
      // No notes to restore: close every tab.
      for (const leaf of existing) leaf.detach();
    } else {
      // Keep one existing leaf alive so its tab group (WorkspaceTabs) persists.
      // A leaf created after detaching *everything* can sit directly in the
      // root split with no tab-group wrapper, which makes getLeaf("tab") open
      // splits instead of tabs. Reusing an existing leaf guarantees the
      // wrapper, so each getLeaf("tab") appends a real tab to the same group.
      // The saved eState restores each note's scroll position and cursor.
      const target = existing[0] ?? this.app.workspace.getLeaf(false);
      for (const leaf of existing) {
        if (leaf !== target) leaf.detach();
      }
      await target.openFile(notes[0].file, { eState: notes[0].eState });
      for (let i = 1; i < notes.length; i++) {
        await this.app.workspace
          .getLeaf("tab")
          .openFile(notes[i].file, { eState: notes[i].eState });
      }
      this.app.workspace.setActiveLeaf(target, { focus: false });
    }

    await this.persist();

    // Release the guard after the layout settles so restored tabs are not
    // immediately recorded as an (empty) snapshot mid-transition.
    window.setTimeout(() => {
      this.isActivating = false;
    }, 150);
  }

  saveActiveProjectTabs(force = false): number {
    if (this.isActivating && !force) return -1;
    const project = this.getActiveProject();
    if (!project) return -1;
    const open: OpenNote[] = [];
    this.app.workspace.iterateRootLeaves((leaf) => {
      // Read the file path from the view state rather than leaf.view.file:
      // background tabs are deferred in Obsidian 1.7+, so their view has no
      // .file until activated, but getViewState().state.file is always set.
      const filePath = leaf.getViewState().state?.file;
      if (typeof filePath === "string" && !open.some((o) => o.path === filePath)) {
        open.push({ path: filePath, eState: leaf.getEphemeralState() });
      }
    });
    project.lastOpenNotes = open;
    void this.persist();
    return open.length;
  }

  async deleteProject(project: Project): Promise<void> {
    this.data.projects = this.data.projects.filter((p) => p.id !== project.id);
    if (this.data.activeProjectId === project.id) {
      this.data.activeProjectId = null;
    }
    await this.persist();
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
      const editBtn = actions.createEl("button", { cls: "rv-icon-btn" });
      setIcon(editBtn, "pencil");
      editBtn.setAttribute("aria-label", "Edit project");
      editBtn.onclick = (e) => {
        e.stopPropagation();
        new ProjectEditModal(this.plugin.app, this.plugin, project).open();
      };

      const delBtn = actions.createEl("button", { cls: "rv-icon-btn" });
      setIcon(delBtn, "trash-2");
      delBtn.setAttribute("aria-label", "Delete project");
      delBtn.onclick = (e) => {
        e.stopPropagation();
        new ConfirmModal(
          this.plugin.app,
          `Delete project "${project.name}"?`,
          () => void this.plugin.deleteProject(project)
        ).open();
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

    const project = this.plugin.getActiveProject();
    if (!project) {
      c.createDiv({
        cls: "rv-empty",
        text: "Open a project to see its folders and notes.",
      });
      return;
    }

    c.createEl("h4", { cls: "rv-content-title", text: project.name });
    if (project.description) {
      c.createDiv({ cls: "rv-project-desc", text: project.description });
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
      for (const path of project.notes) {
        const file = this.plugin.app.vault.getAbstractFileByPath(path);
        if (file instanceof TFile) this.renderFileItem(fileList, file);
      }
    }
  }

  private renderFileItem(container: HTMLElement, file: TFile): void {
    const item = container.createDiv({ cls: "rv-file-item" });
    setIcon(item.createSpan({ cls: "rv-file-icon" }), "file");
    item.createSpan({ cls: "rv-file-name", text: file.basename });
    item.onclick = () => {
      void this.plugin.app.workspace.getLeaf("tab").openFile(file);
    };
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
  return out;
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
      });
    }
    await this.plugin.persist();
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
