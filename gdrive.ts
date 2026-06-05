import { App, requestUrl, TFile, TFolder } from "obsidian";

export interface GDriveAuthStore {
  gdriveClientId: string;
  gdriveClientSecret: string;
  gdriveRefreshToken: string;
}

export interface DriveChild {
  id: string;
  name: string;
  mimeType: string;
  md5Checksum?: string;
  size?: string;
}

export const FOLDER_MIME = "application/vnd.google-apps.folder";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const SCOPE = "https://www.googleapis.com/auth/drive";

/** Map Google-native document types to an exportable format + extension. */
const EXPORT_MAP: Record<string, { mime: string; ext: string }> = {
  "application/vnd.google-apps.document": { mime: "text/markdown", ext: "md" },
  "application/vnd.google-apps.spreadsheet": { mime: "text/csv", ext: "csv" },
  "application/vnd.google-apps.presentation": {
    mime: "application/pdf",
    ext: "pdf",
  },
  "application/vnd.google-apps.drawing": { mime: "image/png", ext: "png" },
};

function getNode<T = unknown>(mod: string): T | null {
  try {
    const req = (window as unknown as { require?: (m: string) => unknown })
      .require;
    return (req ? (req(mod) as T) : null) ?? null;
  } catch {
    return null;
  }
}

function sanitizeName(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, "_").trim() || "untitled";
}

function md5Hex(data: ArrayBuffer): string | null {
  const crypto = getNode<typeof import("crypto")>("crypto");
  if (!crypto) return null;
  return crypto.createHash("md5").update(Buffer.from(data)).digest("hex");
}

function encodeForm(data: Record<string, string>): string {
  return Object.entries(data)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
}

export function isDesktop(): boolean {
  return getNode("http") !== null;
}

/** Extract a Drive folder id from a share link (or a raw id). */
export function parseDriveFolderId(input: string): string | null {
  const s = input.trim();
  const folders = s.match(/\/folders\/([a-zA-Z0-9_-]+)/);
  if (folders) return folders[1];
  const idParam = s.match(/[?&]id=([a-zA-Z0-9_-]+)/);
  if (idParam) return idParam[1];
  const open = s.match(/\/d\/([a-zA-Z0-9_-]+)/);
  if (open) return open[1];
  if (/^[a-zA-Z0-9_-]{10,}$/.test(s)) return s;
  return null;
}

export class GoogleDriveClient {
  private accessToken = "";
  private expiry = 0;

  constructor(
    private app: App,
    private getStore: () => GDriveAuthStore,
    private persist: () => Promise<void>
  ) {}

  /** Always read the live settings object (never a stale captured copy). */
  private get store(): GDriveAuthStore {
    return this.getStore();
  }

  isConfigured(): boolean {
    return !!(this.store.gdriveClientId && this.store.gdriveClientSecret);
  }

  isConnected(): boolean {
    return !!this.store.gdriveRefreshToken;
  }

  async disconnect(): Promise<void> {
    this.store.gdriveRefreshToken = "";
    this.accessToken = "";
    this.expiry = 0;
    await this.persist();
  }

  /** Run the loopback OAuth flow and store a refresh token (desktop only). */
  async connect(): Promise<void> {
    if (!this.isConfigured()) {
      throw new Error("Set your Google OAuth Client ID and Secret first.");
    }
    const http = getNode<typeof import("http")>("http");
    if (!http) throw new Error("Google Drive sign-in is desktop-only.");

    const { code, redirectUri } = await new Promise<{
      code: string;
      redirectUri: string;
    }>((resolve, reject) => {
      let redirectUri = "";
      const server = http.createServer((req, res) => {
        try {
          const u = new URL(req.url ?? "", "http://127.0.0.1");
          const code = u.searchParams.get("code");
          const err = u.searchParams.get("error");
          res.writeHead(200, { "Content-Type": "text/html" });
          res.end(
            "<html><body style='font-family:sans-serif'>Recent View: authorization received. Return to Obsidian to finish connecting, then close this tab.</body></html>"
          );
          server.close();
          if (err) reject(new Error(err));
          else if (code) resolve({ code, redirectUri });
          else reject(new Error("No authorization code returned."));
        } catch (e) {
          reject(e as Error);
        }
      });
      server.on("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        const port = typeof addr === "object" && addr ? addr.port : 0;
        redirectUri = `http://127.0.0.1:${port}`;
        const authUrl =
          `${AUTH_URL}?` +
          encodeForm({
            client_id: this.store.gdriveClientId,
            redirect_uri: redirectUri,
            response_type: "code",
            scope: SCOPE,
            access_type: "offline",
            prompt: "consent",
          });
        const electron = getNode<{
          shell?: { openExternal: (u: string) => void };
        }>("electron");
        if (electron?.shell?.openExternal) electron.shell.openExternal(authUrl);
        else window.open(authUrl, "_blank");
      });
      window.setTimeout(() => {
        try {
          server.close();
        } catch {
          /* noop */
        }
        reject(new Error("OAuth timed out."));
      }, 300000);
    });

    const res = await requestUrl({
      url: TOKEN_URL,
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: encodeForm({
        code,
        client_id: this.store.gdriveClientId,
        client_secret: this.store.gdriveClientSecret,
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
      }),
      throw: false,
    });
    if (res.status >= 400) {
      throw new Error(`Token exchange failed: ${res.text}`);
    }
    const json = res.json as {
      access_token: string;
      refresh_token?: string;
      expires_in: number;
    };
    if (!json.refresh_token) {
      throw new Error(
        "No refresh token returned. Remove the app's access at myaccount.google.com/permissions and try again."
      );
    }
    this.store.gdriveRefreshToken = json.refresh_token;
    this.accessToken = json.access_token;
    this.expiry = Date.now() + json.expires_in * 1000;
    await this.persist();
  }

  private async getAccessToken(): Promise<string> {
    if (this.accessToken && Date.now() < this.expiry - 60000) {
      return this.accessToken;
    }
    if (!this.store.gdriveRefreshToken) {
      throw new Error("Not connected to Google Drive.");
    }
    const res = await requestUrl({
      url: TOKEN_URL,
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: encodeForm({
        client_id: this.store.gdriveClientId,
        client_secret: this.store.gdriveClientSecret,
        refresh_token: this.store.gdriveRefreshToken,
        grant_type: "refresh_token",
      }),
      throw: false,
    });
    if (res.status >= 400) {
      throw new Error(`Token refresh failed: ${res.text}`);
    }
    const json = res.json as { access_token: string; expires_in: number };
    this.accessToken = json.access_token;
    this.expiry = Date.now() + json.expires_in * 1000;
    return this.accessToken;
  }

  private async api(
    url: string,
    init: { method?: string; headers?: Record<string, string>; body?: string | ArrayBuffer } = {}
  ) {
    const token = await this.getAccessToken();
    const res = await requestUrl({
      url,
      method: init.method ?? "GET",
      headers: { Authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
      body: init.body,
      throw: false,
    });
    if (res.status >= 400) {
      throw new Error(`Drive API ${res.status}: ${res.text}`);
    }
    return res;
  }

  async getFolderName(folderId: string): Promise<string> {
    const res = await this.api(
      `https://www.googleapis.com/drive/v3/files/${folderId}?fields=name&supportsAllDrives=true`
    );
    return (res.json as { name?: string }).name ?? "Google Drive";
  }

  /** List a Drive folder's immediate children. */
  async listFolder(folderId: string): Promise<DriveChild[]> {
    return this.listChildren(folderId);
  }

  /** Resolve a path (relative to rootFolderId) to its Drive child, or null if missing. */
  async findChildByPath(
    rootFolderId: string,
    parts: string[]
  ): Promise<DriveChild | null> {
    if (parts.length === 0) return null;
    let currentId = rootFolderId;
    for (let i = 0; i < parts.length; i++) {
      const name = parts[i];
      const isLast = i === parts.length - 1;
      const children = await this.listChildren(currentId);
      const match = isLast
        ? children.find((c) => c.name === name)
        : children.find((c) => c.name === name && c.mimeType === FOLDER_MIME);
      if (!match) return null;
      if (isLast) return match;
      currentId = match.id;
    }
    return null;
  }

  private async listChildren(folderId: string): Promise<DriveChild[]> {
    const out: DriveChild[] = [];
    let pageToken = "";
    do {
      const q = encodeURIComponent(`'${folderId}' in parents and trashed=false`);
      const url =
        `https://www.googleapis.com/drive/v3/files?q=${q}` +
        `&fields=nextPageToken,files(id,name,mimeType,md5Checksum,size)&pageSize=1000` +
        `&supportsAllDrives=true&includeItemsFromAllDrives=true` +
        (pageToken ? `&pageToken=${pageToken}` : "");
      const res = await this.api(url);
      const json = res.json as { files?: DriveChild[]; nextPageToken?: string };
      out.push(...(json.files ?? []));
      pageToken = json.nextPageToken ?? "";
    } while (pageToken);
    return out;
  }

  private async ensureDir(path: string): Promise<void> {
    const adapter = this.app.vault.adapter;
    const parts = path.split("/").filter(Boolean);
    let cur = "";
    for (const part of parts) {
      cur = cur ? `${cur}/${part}` : part;
      if (!(await adapter.exists(cur))) await adapter.mkdir(cur);
    }
  }

  /** Recursively download a Drive folder into a vault directory. Files whose local md5 already matches Drive's are skipped. */
  async downloadFolder(folderId: string, vaultDir: string): Promise<number> {
    await this.ensureDir(vaultDir);
    const adapter = this.app.vault.adapter;
    let count = 0;
    for (const child of await this.listChildren(folderId)) {
      if (child.mimeType === FOLDER_MIME) {
        count += await this.downloadFolder(
          child.id,
          `${vaultDir}/${sanitizeName(child.name)}`
        );
        continue;
      }
      if (child.md5Checksum) {
        const targetPath = `${vaultDir}/${sanitizeName(child.name)}`;
        if (await adapter.exists(targetPath)) {
          const localMd5 = md5Hex(await adapter.readBinary(targetPath));
          if (localMd5 === child.md5Checksum) continue;
        }
      }
      const dl = await this.downloadFile(child);
      if (!dl) continue;
      await adapter.writeBinary(`${vaultDir}/${dl.name}`, dl.data);
      count++;
    }
    return count;
  }

  /**
   * Download one Drive file into `vaultDir`. Returns the written filename and
   * whether anything was written (skipped when local md5 already matches).
   * Returns null for unsupported Google-native types.
   */
  async downloadChildTo(
    child: DriveChild,
    vaultDir: string
  ): Promise<{ name: string; written: boolean } | null> {
    if (child.mimeType === FOLDER_MIME) return null;
    await this.ensureDir(vaultDir);
    const adapter = this.app.vault.adapter;
    if (child.md5Checksum) {
      const targetPath = `${vaultDir}/${sanitizeName(child.name)}`;
      if (await adapter.exists(targetPath)) {
        const localMd5 = md5Hex(await adapter.readBinary(targetPath));
        if (localMd5 === child.md5Checksum) {
          return { name: sanitizeName(child.name), written: false };
        }
      }
    }
    const dl = await this.downloadFile(child);
    if (!dl) return null;
    await adapter.writeBinary(`${vaultDir}/${dl.name}`, dl.data);
    return { name: dl.name, written: true };
  }

  private async downloadFile(
    child: DriveChild
  ): Promise<{ name: string; data: ArrayBuffer } | null> {
    let url: string;
    let name = sanitizeName(child.name);
    if (child.mimeType.startsWith("application/vnd.google-apps")) {
      const exp = EXPORT_MAP[child.mimeType];
      if (!exp) return null; // unsupported Google-native type
      url = `https://www.googleapis.com/drive/v3/files/${child.id}/export?mimeType=${encodeURIComponent(exp.mime)}`;
      if (!name.toLowerCase().endsWith(`.${exp.ext}`)) name += `.${exp.ext}`;
    } else {
      url = `https://www.googleapis.com/drive/v3/files/${child.id}?alt=media&supportsAllDrives=true`;
    }
    const res = await this.api(url);
    return { name, data: res.arrayBuffer };
  }

  async createFolder(name: string, parentId: string): Promise<string> {
    const res = await this.api(
      "https://www.googleapis.com/drive/v3/files?supportsAllDrives=true&fields=id",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, mimeType: FOLDER_MIME, parents: [parentId] }),
      }
    );
    return (res.json as { id: string }).id;
  }

  private async createFile(
    name: string,
    parentId: string,
    data: ArrayBuffer
  ): Promise<void> {
    const meta = await this.api(
      "https://www.googleapis.com/drive/v3/files?supportsAllDrives=true&fields=id",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, parents: [parentId] }),
      }
    );
    const id = (meta.json as { id: string }).id;
    await this.updateFileContent(id, data);
  }

  private async updateFileContent(id: string, data: ArrayBuffer): Promise<void> {
    await this.api(
      `https://www.googleapis.com/upload/drive/v3/files/${id}?uploadType=media&supportsAllDrives=true`,
      { method: "PATCH", body: data }
    );
  }

  /** Ensure a nested folder path exists under a Drive folder; return leaf id. */
  private async ensureSubfolder(
    parentId: string,
    names: string[]
  ): Promise<string> {
    let current = parentId;
    for (const name of names) {
      const children = await this.listChildren(current);
      const match = children.find(
        (c) => c.name === name && c.mimeType === FOLDER_MIME
      );
      current = match ? match.id : await this.createFolder(name, current);
    }
    return current;
  }

  /** Upload (create or update) one file into rootFolderId/<relDirParts>. Returns true if uploaded, false if skipped as unchanged. */
  async uploadSingleFile(
    rootFolderId: string,
    file: TFile,
    relDirParts: string[]
  ): Promise<boolean> {
    const parentId = await this.ensureSubfolder(rootFolderId, relDirParts);
    const data = await this.app.vault.readBinary(file);
    const children = await this.listChildren(parentId);
    const match = children.find(
      (c) => c.name === file.name && c.mimeType !== FOLDER_MIME
    );
    if (match) {
      const localMd5 = md5Hex(data);
      if (localMd5 && match.md5Checksum && localMd5 === match.md5Checksum) {
        return false;
      }
      await this.updateFileContent(match.id, data);
    } else {
      await this.createFile(file.name, parentId, data);
    }
    return true;
  }

  /** Create a new Drive folder named `name` under `parentId`, upload `vaultDir` into it, return the new folder's id. */
  async uploadFolderAsNew(
    name: string,
    parentId: string,
    vaultDir: string
  ): Promise<{ folderId: string; count: number }> {
    const folderId = await this.createFolder(name, parentId);
    const count = await this.uploadFolder(vaultDir, folderId);
    return { folderId, count };
  }

  /** Recursively upload a vault folder's contents into a Drive folder. */
  async uploadFolder(vaultDir: string, folderId: string): Promise<number> {
    const folder = this.app.vault.getAbstractFileByPath(vaultDir);
    if (!(folder instanceof TFolder)) return 0;
    const existing = await this.listChildren(folderId);
    const byName = new Map(existing.map((c) => [c.name, c]));
    let count = 0;
    for (const child of folder.children) {
      if (child instanceof TFolder) {
        const match = byName.get(child.name);
        const subId =
          match && match.mimeType === FOLDER_MIME
            ? match.id
            : await this.createFolder(child.name, folderId);
        count += await this.uploadFolder(child.path, subId);
      } else if (child instanceof TFile) {
        const data = await this.app.vault.readBinary(child);
        const match = byName.get(child.name);
        if (match && match.mimeType !== FOLDER_MIME) {
          const localMd5 = md5Hex(data);
          if (localMd5 && match.md5Checksum && localMd5 === match.md5Checksum) {
            continue;
          }
          await this.updateFileContent(match.id, data);
        } else {
          await this.createFile(child.name, folderId, data);
        }
        count++;
      }
    }
    return count;
  }
}
