# ProjectView

An [Obsidian](https://obsidian.md) plugin that organizes your notes into **projects**. Each project keeps its own set of folders and notes, remembers the tabs you had open, and can sync with a Google Drive folder.

A project lives as a pane in the left sidebar; clicking it instantly restores that project's workspace (its open tabs, scroll position, and active tab) without losing state.

> Desktop‑focused. The core project features work anywhere, but the Google Drive integration is desktop‑only.

---

## Features

### Projects
- A **Projects** list in the left sidebar; each project is a full‑width box showing its name and description.
- Create projects with **+ New** — set a name, description, member folders, and specific notes.
- The project list is auto‑docked **above the native File Explorer**, so the explorer sits at the bottom of the left sidebar.

### Live panes (instant project switching)
- Each project keeps its **own live tab group**. Switching projects **hides** the old pane and **shows** the target's instead of closing/reopening notes — so scroll position, cursor, undo history and the active tab are all preserved.
- When you close the last tab in a pane, a fresh empty tab is shown so the project always has a visible pane.
- On restart, only the active project's pane is rebuilt; others are recreated lazily on first click.

### Multiple panes per project
- Add extra named **panes** to a project (project header `⋮` → **New pane**). Each pane has its own remembered tabs.
- A **Panes** section lists the **Main** pane plus your named panes; click to switch. Named panes can be renamed or deleted.

### Project contents pane (right sidebar)
- Shows the active project's **pinned notes**, **folders**, and loose **notes**.
- **Pinned** section at the top — pin/unpin notes from a note's menu; toggle **reorder** mode to drag‑reorder pins.
- Folder notes are sorted by name; a subfolder's notes appear under a labeled separator.
- Auto‑refreshes when notes are created, deleted, or renamed in the vault.
- Clicking a note **opens or focuses** it (no duplicate tabs).

### Context menus
- **Note** menu: Pin / Unpin, Rename, Upload to Google Drive (linked projects).
- **Folder** menu: Rename, Remove from project (keeps the folder in your vault).
- **Pane** menu: Open folder…, Open note…, Browse… (a folder/file tree of the project), Rename / Delete (named panes).

### Google Drive sync (desktop only)
- **Create a project from a Drive share link**: in **+ New**, paste a folder link, pick a new or existing folder, and the folder's files/subfolders are downloaded and linked to the project.
- **Download from / Upload to Google Drive** from the project menu (left pane and right‑pane header).
- **Upload a single file** from a note's menu.
- Google‑native files are exported on download: Docs → `.md`, Sheets → `.csv`, Slides → `.pdf`.

> Sync is **one‑way and additive**: download writes/updates files locally (never deletes local files removed on Drive); upload writes/updates files on Drive (never deletes Drive files removed locally).

---

## Installation (manual)

This plugin isn't in the community store. To install manually:

1. Create the folder `<your-vault>/.obsidian/plugins/obsidian-project-view/`.
2. Copy `manifest.json`, `main.js`, and `styles.css` into it.
3. In Obsidian, enable **ProjectView** under **Settings → Community plugins**.

---

## Data storage

Projects are stored in a **note inside your vault** (default `ProjectView.md`, configurable in settings) as a JSON code block — so the data is per‑vault and travels/syncs with your vault. Plugin settings (and Drive credentials) live in the plugin's `data.json`. (Data from an older `RecentView.md` note is migrated automatically.)

---

## Google Drive setup

1. In the [Google Cloud Console](https://console.cloud.google.com/): create a project and enable the **Google Drive API**.
2. Create an **OAuth client ID** of type **Desktop app**.
3. Add yourself as a test user on the OAuth consent screen (or publish it).
4. In **Settings → ProjectView → Google Drive**, paste the **Client ID** and **Client Secret**, then click **Connect** and authorize in your browser.

You need **edit access** to a shared folder for uploads to work.

---

## Building from source

```bash
npm install
npm run build     # type-check + bundle to main.js
npm run dev       # watch mode
```

Source: `main.ts` (plugin) and `gdrive.ts` (Google Drive client), bundled with esbuild.

---

## License

MIT
