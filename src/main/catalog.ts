import initSqlJs, { type Database } from "sql.js";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { BackupTask, ProjectConfig } from "./types";
import { entityDigest, type WorkspaceState } from "./workspace-contract";

const SCHEMA = 4;
const EMPTY_FILE_DIGEST = createHash("sha256").digest("hex");

function taskHeader(task: BackupTask) {
  return [
    task.projectId || "",
    task.name || "",
    task.shootingDate || "",
    task.status || "",
    task.provenance || "kocpy-transfer",
    task.createdAt || 0,
    task.totalFiles,
    task.totalBytes,
    JSON.stringify({ ...task, fileRecords: [] }),
  ];
}

function projectRow(project: ProjectConfig) {
  return [
    project.name || "",
    project.status || "active",
    JSON.stringify(project),
  ];
}

function fileRow(
  taskId: string,
  file: BackupTask["fileRecords"][number],
  ordinal: number,
) {
  return [
    taskId,
    file.relativePath,
    file.size,
    file.srcChecksum,
    file.destinations.some((item) => item.verified) ? 1 : 0,
    path.extname(file.name).toLowerCase(),
    JSON.stringify(file),
    ordinal,
  ];
}

function appendDigest(hash: ReturnType<typeof createHash>, value: unknown[]) {
  const encoded = JSON.stringify(value);
  hash
    .update(String(Buffer.byteLength(encoded)))
    .update(":")
    .update(encoded);
}

function taskFilesDigest(task: BackupTask) {
  const hash = createHash("sha256");
  for (const [ordinal, file] of task.fileRecords.entries())
    appendDigest(hash, fileRow(task.id, file, ordinal));
  return hash.digest("hex");
}

export class CatalogDatabase {
  private db?: Database;
  private writes: Promise<void> = Promise.resolve();
  constructor(private root: string) {}
  private get file() {
    return path.join(this.root, "catalog.sqlite");
  }
  async open() {
    if (this.db) return this.db;
    const SQL = await initSqlJs();
    const bytes = await fs.readFile(this.file).catch(() => undefined);
    this.db = bytes ? new SQL.Database(bytes) : new SQL.Database();
    if (bytes) {
      const integrity = this.db.exec("PRAGMA integrity_check")[0]
        ?.values[0]?.[0];
      if (integrity !== "ok") {
        this.db.close();
        this.db = undefined;
        throw new Error(
          `素材目录数据库完整性检查失败：${String(integrity || "未知错误")}`,
        );
      }
    }
    this.db.run(`PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY,project_id TEXT,name TEXT,shooting_date TEXT,status TEXT,provenance TEXT,created_at INTEGER,total_files INTEGER,total_bytes INTEGER,json TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS tasks_project_date ON tasks(project_id,shooting_date,created_at DESC);
      CREATE TABLE IF NOT EXISTS files(task_id TEXT NOT NULL,relative_path TEXT NOT NULL,size INTEGER,checksum TEXT,verified INTEGER,kind TEXT,json TEXT,ordinal INTEGER,PRIMARY KEY(task_id,relative_path));
      CREATE INDEX IF NOT EXISTS files_path ON files(relative_path);
      CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY,name TEXT,status TEXT,json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS changes(id TEXT PRIMARY KEY,project_id TEXT,task_id TEXT,at INTEGER,kind TEXT,note TEXT,json TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS changes_project_at ON changes(project_id,at DESC);
      CREATE TABLE IF NOT EXISTS workspace_entities(kind TEXT NOT NULL,id TEXT NOT NULL,digest TEXT NOT NULL,PRIMARY KEY(kind,id));
      CREATE TABLE IF NOT EXISTS workspace_state(id INTEGER PRIMARY KEY CHECK(id=1),revision INTEGER NOT NULL,digest TEXT NOT NULL,schema_version INTEGER NOT NULL,committed_at INTEGER NOT NULL,json TEXT NOT NULL);`);
    const columns =
      this.db
        .exec("PRAGMA table_info(files)")[0]
        ?.values.map((row) => String(row[1])) || [];
    if (!columns.includes("json"))
      this.db.run("ALTER TABLE files ADD COLUMN json TEXT");
    if (!columns.includes("ordinal"))
      this.db.run("ALTER TABLE files ADD COLUMN ordinal INTEGER");
    this.db.run("INSERT OR REPLACE INTO meta(key,value) VALUES('schema',?)", [
      String(SCHEMA),
    ]);
    await this.persistNow();
    return this.db;
  }
  async rebuild(tasks: BackupTask[], projects: ProjectConfig[]) {
    return this.enqueue(async () => {
      const db = await this.open();
      db.run("BEGIN");
      try {
        db.run("DELETE FROM files");
        db.run("DELETE FROM tasks");
        db.run("DELETE FROM projects");
        for (const project of projects)
          db.run("INSERT INTO projects VALUES(?,?,?,?)", [
            project.id,
            project.name,
            project.status || "active",
            JSON.stringify(project),
          ]);
        for (const task of tasks) {
          db.run("INSERT INTO tasks VALUES(?,?,?,?,?,?,?,?,?,?)", [
            task.id,
            task.projectId || "",
            task.name,
            task.shootingDate || "",
            task.status,
            task.provenance || "kocpy-transfer",
            task.createdAt || 0,
            task.totalFiles,
            task.totalBytes,
            JSON.stringify({ ...task, fileRecords: [] }),
          ]);
          for (const [ordinal, file] of task.fileRecords.entries())
            db.run("INSERT OR REPLACE INTO files VALUES(?,?,?,?,?,?,?,?)", [
              task.id,
              file.relativePath,
              file.size,
              file.srcChecksum,
              file.destinations.some((item) => item.verified) ? 1 : 0,
              path.extname(file.name).toLowerCase(),
              JSON.stringify(file),
              ordinal,
            ]);
        }
        db.run("COMMIT");
        await this.persistNow();
      } catch (error) {
        db.run("ROLLBACK");
        throw error;
      }
    });
  }
  async loadTasks(): Promise<BackupTask[]> {
    const db = await this.open(),
      statement = db.prepare(
        "SELECT id,json FROM tasks ORDER BY created_at ASC",
      ),
      rows: BackupTask[] = [];
    const tasks = new Map<string, BackupTask>(),
      embeddedFiles = new Map<string, BackupTask["fileRecords"]>();
    while (statement.step()) {
      const values = statement.get(),
        task = JSON.parse(String(values[1])) as BackupTask;
      embeddedFiles.set(String(values[0]), task.fileRecords || []);
      task.fileRecords = [];
      tasks.set(String(values[0]), task);
      rows.push(task);
    }
    statement.free();
    const files = db.prepare(
      "SELECT task_id,relative_path,size,checksum,verified,json FROM files ORDER BY task_id,ordinal,relative_path",
    );
    while (files.step()) {
      const values = files.get(),
        task = tasks.get(String(values[0]));
      if (!task) continue;
      const embedded = embeddedFiles
        .get(String(values[0]))
        ?.find((file) => file.relativePath === String(values[1]));
      task.fileRecords.push(
        values[5]
          ? JSON.parse(String(values[5]))
          : embedded || {
              name: path.basename(String(values[1])),
              relativePath: String(values[1]),
              size: Number(values[2] || 0),
              srcChecksum: String(values[3] || ""),
              destinations: [],
            },
      );
    }
    files.free();
    return rows;
  }
  async loadProjects(): Promise<ProjectConfig[]> {
    const db = await this.open(),
      statement = db.prepare("SELECT json FROM projects ORDER BY name"),
      rows: ProjectConfig[] = [];
    while (statement.step()) {
      rows.push(JSON.parse(String(statement.get()[0])));
    }
    statement.free();
    return rows;
  }
  async loadWorkspaceState(): Promise<WorkspaceState | undefined> {
    const db = await this.open(),
      row = db.exec("SELECT json FROM workspace_state WHERE id=1")[0]
        ?.values[0];
    return row ? (JSON.parse(String(row[0])) as WorkspaceState) : undefined;
  }
  async applyWorkspaceState(state: WorkspaceState) {
    return this.enqueue(async () => {
      const db = await this.open(),
        snapshot = db.export();
      let committed = false;
      db.run("BEGIN");
      try {
        const existing = new Map<string, string>(),
          rows = db.prepare("SELECT kind,id,digest FROM workspace_entities");
        while (rows.step()) {
          const values = rows.get();
          existing.set(
            `${String(values[0])}:${String(values[1])}`,
            String(values[2]),
          );
        }
        rows.free();
        const taskIds = new Set(state.tasks.map((task) => task.id)),
          projectIds = new Set(state.projects.map((project) => project.id)),
          storedTaskIds = new Set<string>(),
          storedProjectIds = new Set<string>(),
          storedTaskHeaders = new Map<string, string>(),
          storedProjectRows = new Map<string, string>(),
          storedFileCounts = new Map<string, number>(),
          storedFileDigests = new Map<string, string>(),
          taskRows = db.prepare(
            "SELECT id,project_id,name,shooting_date,status,provenance,created_at,total_files,total_bytes,json FROM tasks",
          ),
          projectRows = db.prepare("SELECT id,name,status,json FROM projects"),
          fileCountRows = db.prepare(
            "SELECT task_id,count(*) FROM files GROUP BY task_id",
          ),
          fileRows = db.prepare(
            "SELECT task_id,relative_path,size,checksum,verified,kind,json,ordinal FROM files ORDER BY task_id,ordinal,relative_path",
          );
        while (taskRows.step()) {
          const values = taskRows.get(),
            id = String(values[0]);
          storedTaskIds.add(id);
          storedTaskHeaders.set(
            id,
            JSON.stringify([
              String(values[1] || ""),
              String(values[2] || ""),
              String(values[3] || ""),
              String(values[4] || ""),
              String(values[5] || ""),
              Number(values[6] || 0),
              Number(values[7] || 0),
              Number(values[8] || 0),
              String(values[9] || ""),
            ]),
          );
        }
        while (projectRows.step()) {
          const values = projectRows.get(),
            id = String(values[0]);
          storedProjectIds.add(id);
          storedProjectRows.set(
            id,
            JSON.stringify([
              String(values[1] || ""),
              String(values[2] || ""),
              String(values[3] || ""),
            ]),
          );
        }
        while (fileCountRows.step()) {
          const values = fileCountRows.get();
          storedFileCounts.set(String(values[0]), Number(values[1]));
        }
        let digestTaskId = "",
          digestHash: ReturnType<typeof createHash> | undefined;
        while (fileRows.step()) {
          const values = fileRows.get(),
            taskId = String(values[0]);
          if (taskId !== digestTaskId) {
            if (digestHash)
              storedFileDigests.set(digestTaskId, digestHash.digest("hex"));
            digestTaskId = taskId;
            digestHash = createHash("sha256");
          }
          appendDigest(digestHash!, [
            taskId,
            String(values[1] || ""),
            Number(values[2] || 0),
            String(values[3] || ""),
            Number(values[4] || 0),
            String(values[5] || ""),
            String(values[6] || ""),
            Number(values[7] || 0),
          ]);
        }
        if (digestHash)
          storedFileDigests.set(digestTaskId, digestHash.digest("hex"));
        taskRows.free();
        projectRows.free();
        fileCountRows.free();
        fileRows.free();
        for (const id of storedTaskIds)
          if (!taskIds.has(id)) {
            db.run("DELETE FROM files WHERE task_id=?", [id]);
            db.run("DELETE FROM tasks WHERE id=?", [id]);
            db.run(
              "DELETE FROM workspace_entities WHERE kind='task' AND id=?",
              [id],
            );
          }
        for (const id of storedProjectIds)
          if (!projectIds.has(id)) {
            db.run("DELETE FROM projects WHERE id=?", [id]);
            db.run("DELETE FROM changes WHERE project_id=?", [id]);
            db.run(
              "DELETE FROM workspace_entities WHERE kind='project' AND id=?",
              [id],
            );
          }
        for (const key of existing.keys()) {
          const separator = key.indexOf(":"),
            kind = key.slice(0, separator),
            id = key.slice(separator + 1);
          if (kind === "task" && !taskIds.has(id)) {
            db.run("DELETE FROM files WHERE task_id=?", [id]);
            db.run("DELETE FROM tasks WHERE id=?", [id]);
            db.run(
              "DELETE FROM workspace_entities WHERE kind='task' AND id=?",
              [id],
            );
          }
          if (kind === "project" && !projectIds.has(id)) {
            db.run("DELETE FROM projects WHERE id=?", [id]);
            db.run("DELETE FROM changes WHERE project_id=?", [id]);
            db.run(
              "DELETE FROM workspace_entities WHERE kind='project' AND id=?",
              [id],
            );
          }
        }
        for (const project of state.projects) {
          const digest = entityDigest(project);
          if (
            existing.get(`project:${project.id}`) === digest &&
            storedProjectIds.has(project.id) &&
            storedProjectRows.get(project.id) ===
              JSON.stringify(projectRow(project))
          )
            continue;
          db.run("INSERT OR REPLACE INTO projects VALUES(?,?,?,?)", [
            project.id,
            project.name,
            project.status || "active",
            JSON.stringify(project),
          ]);
          db.run(
            "INSERT OR REPLACE INTO workspace_entities VALUES('project',?,?)",
            [project.id, digest],
          );
        }
        for (const task of state.tasks) {
          const digest = entityDigest(task);
          if (
            existing.get(`task:${task.id}`) === digest &&
            storedTaskIds.has(task.id) &&
            storedTaskHeaders.get(task.id) ===
              JSON.stringify(taskHeader(task)) &&
            (storedFileCounts.get(task.id) || 0) === task.fileRecords.length &&
            (storedFileDigests.get(task.id) || EMPTY_FILE_DIGEST) ===
              taskFilesDigest(task)
          )
            continue;
          db.run("DELETE FROM files WHERE task_id=?", [task.id]);
          db.run("INSERT OR REPLACE INTO tasks VALUES(?,?,?,?,?,?,?,?,?,?)", [
            task.id,
            task.projectId || "",
            task.name,
            task.shootingDate || "",
            task.status,
            task.provenance || "kocpy-transfer",
            task.createdAt || 0,
            task.totalFiles,
            task.totalBytes,
            JSON.stringify({ ...task, fileRecords: [] }),
          ]);
          for (const [ordinal, file] of task.fileRecords.entries())
            db.run("INSERT OR REPLACE INTO files VALUES(?,?,?,?,?,?,?,?)", [
              task.id,
              file.relativePath,
              file.size,
              file.srcChecksum,
              file.destinations.some((item) => item.verified) ? 1 : 0,
              path.extname(file.name).toLowerCase(),
              JSON.stringify(file),
              ordinal,
            ]);
          db.run(
            "INSERT OR REPLACE INTO workspace_entities VALUES('task',?,?)",
            [task.id, digest],
          );
        }
        db.run("INSERT OR REPLACE INTO workspace_state VALUES(1,?,?,?,?,?)", [
          state.revision,
          state.digest,
          state.schemaVersion,
          state.committedAt,
          JSON.stringify(state),
        ]);
        db.run(
          "INSERT OR REPLACE INTO meta(key,value) VALUES('workspace_revision',?)",
          [String(state.revision)],
        );
        db.run(
          "INSERT OR REPLACE INTO meta(key,value) VALUES('workspace_digest',?)",
          [state.digest],
        );
        db.run("COMMIT");
        committed = true;
        await this.persistNow();
      } catch (error) {
        if (!committed) db.run("ROLLBACK");
        else {
          db.close();
          const SQL = await initSqlJs();
          this.db = new SQL.Database(snapshot);
          this.db.run("PRAGMA foreign_keys=ON");
          await this.persistNow().catch(() => undefined);
        }
        throw error;
      }
    });
  }
  async upsertTask(task: BackupTask) {
    return this.enqueue(async () => {
      const db = await this.open();
      db.run("BEGIN");
      try {
        db.run("DELETE FROM files WHERE task_id=?", [task.id]);
        db.run("INSERT OR REPLACE INTO tasks VALUES(?,?,?,?,?,?,?,?,?,?)", [
          task.id,
          task.projectId || "",
          task.name,
          task.shootingDate || "",
          task.status,
          task.provenance || "kocpy-transfer",
          task.createdAt || 0,
          task.totalFiles,
          task.totalBytes,
          JSON.stringify({ ...task, fileRecords: [] }),
        ]);
        for (const [ordinal, file] of task.fileRecords.entries())
          db.run("INSERT OR REPLACE INTO files VALUES(?,?,?,?,?,?,?,?)", [
            task.id,
            file.relativePath,
            file.size,
            file.srcChecksum,
            file.destinations.some((item) => item.verified) ? 1 : 0,
            path.extname(file.name).toLowerCase(),
            JSON.stringify(file),
            ordinal,
          ]);
        db.run("COMMIT");
        await this.persistNow();
      } catch (error) {
        db.run("ROLLBACK");
        throw error;
      }
    });
  }
  async deleteTask(id: string) {
    return this.enqueue(async () => {
      const db = await this.open();
      db.run("BEGIN");
      try {
        db.run("DELETE FROM files WHERE task_id=?", [id]);
        db.run("DELETE FROM tasks WHERE id=?", [id]);
        db.run("COMMIT");
        await this.persistNow();
      } catch (error) {
        db.run("ROLLBACK");
        throw error;
      }
    });
  }
  async upsertProject(project: ProjectConfig) {
    return this.enqueue(async () => {
      const db = await this.open();
      db.run("INSERT OR REPLACE INTO projects VALUES(?,?,?,?)", [
        project.id,
        project.name,
        project.status || "active",
        JSON.stringify(project),
      ]);
      await this.persistNow();
    });
  }
  async deleteProject(id: string) {
    return this.enqueue(async () => {
      const db = await this.open();
      db.run("DELETE FROM projects WHERE id=?", [id]);
      await this.persistNow();
    });
  }
  async deleteProjectRecords(id: string) {
    return this.enqueue(async () => {
      const db = await this.open(),
        snapshot = db.export();
      let committed = false;
      db.run("BEGIN");
      try {
        db.run(
          "DELETE FROM files WHERE task_id IN (SELECT id FROM tasks WHERE project_id=?)",
          [id],
        );
        db.run("DELETE FROM tasks WHERE project_id=?", [id]);
        db.run("DELETE FROM changes WHERE project_id=?", [id]);
        db.run("DELETE FROM projects WHERE id=?", [id]);
        db.run("COMMIT");
        committed = true;
        await this.persistNow();
      } catch (error) {
        if (!committed) db.run("ROLLBACK");
        else {
          db.close();
          const SQL = await initSqlJs();
          this.db = new SQL.Database(snapshot);
          this.db.run("PRAGMA foreign_keys=ON");
        }
        throw error;
      }
    });
  }
  async pageFiles(options: {
    projectId?: string;
    query?: string;
    kind?: string;
    offset?: number;
    limit?: number;
  }) {
    const db = await this.open(),
      limit = Math.min(1000, Math.max(1, options.limit || 100)),
      offset = Math.max(0, options.offset || 0),
      query = `%${(options.query || "").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
    const kind = options.kind || "all",
      kindSql =
        kind === "video"
          ? " AND f.kind IN ('.mov','.mp4','.mxf','.mkv','.avi','.m4v')"
          : kind === "image"
            ? " AND f.kind IN ('.jpg','.jpeg','.png','.arw','.cr3','.nef','.dng','.raf','.heic')"
            : kind === "audio"
              ? " AND f.kind IN ('.wav','.mp3','.aif','.aiff','.m4a','.flac')"
              : kind === "color"
                ? " AND f.kind IN ('.cube','.cdl','.cc','.ccc','.clf')"
                : "";
    const where = `${options.projectId ? "t.project_id=? AND " : ""}f.relative_path LIKE ? ESCAPE '\\'${kindSql}`,
      params: Array<string | number> = [
        ...(options.projectId ? [options.projectId] : []),
        query,
        limit,
        offset,
      ];
    const statement = db.prepare(
      `SELECT f.task_id,f.relative_path,f.size,f.checksum,f.verified,f.json,t.name task_name,t.project_id FROM files f JOIN tasks t ON t.id=f.task_id WHERE ${where} ORDER BY t.created_at DESC,f.relative_path LIMIT ? OFFSET ?`,
    );
    statement.bind(params);
    const rows: Record<string, unknown>[] = [];
    while (statement.step()) {
      const row = statement.getAsObject();
      try {
        Object.assign(row, JSON.parse(String(row.json || "{}")));
      } catch {}
      delete row.json;
      rows.push(row);
    }
    statement.free();
    return rows;
  }
  async stats() {
    const db = await this.open(),
      row = db.exec(
        "SELECT (SELECT count(*) FROM tasks) tasks,(SELECT count(*) FROM files) files,(SELECT count(*) FROM projects) projects",
      )[0]?.values[0] || [0, 0, 0];
    return {
      tasks: Number(row[0]),
      files: Number(row[1]),
      projects: Number(row[2]),
      schema: SCHEMA,
    };
  }
  private enqueue<T>(operation: () => Promise<T>) {
    const action = this.writes.then(operation);
    this.writes = action.then(
      () => undefined,
      () => undefined,
    );
    return action;
  }
  private async persistNow() {
    if (!this.db) return;
    await fs.mkdir(this.root, { recursive: true });
    const temp = `${this.file}.tmp`;
    await fs.copyFile(`${this.file}.bak2`, `${this.file}.bak3`).catch(() => {});
    await fs.copyFile(`${this.file}.bak`, `${this.file}.bak2`).catch(() => {});
    await fs.copyFile(this.file, `${this.file}.bak`).catch(() => {});
    const handle = await fs.open(temp, "w");
    try {
      await handle.writeFile(Buffer.from(this.db.export()));
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(temp, this.file);
    const directory = await fs.open(this.root, "r");
    try {
      await directory.sync();
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (!["EINVAL", "ENOTSUP", "EBADF"].includes(code || "")) throw error;
    } finally {
      await directory.close();
    }
  }
  flush() {
    return this.enqueue(() => this.persistNow());
  }
  async recover() {
    const SQL = await initSqlJs();
    for (const suffix of [".bak", ".bak2", ".bak3"]) {
      try {
        const candidate = await fs.readFile(`${this.file}${suffix}`),
          database = new SQL.Database(candidate),
          integrity = database.exec("PRAGMA integrity_check")[0]
            ?.values[0]?.[0];
        database.close();
        if (integrity !== "ok") continue;
        const temp = `${this.file}.recover-${process.pid}-${Date.now()}`;
        const handle = await fs.open(temp, "wx");
        try {
          await handle.writeFile(candidate);
          await handle.sync();
        } finally {
          await handle.close();
        }
        try {
          await fs.rename(temp, this.file);
        } finally {
          await fs.unlink(temp).catch(() => {});
        }
        const directory = await fs.open(this.root, "r");
        try {
          await directory.sync();
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (!["EINVAL", "ENOTSUP", "EBADF"].includes(code || "")) throw error;
        } finally {
          await directory.close();
        }
        this.db?.close();
        this.db = undefined;
        return this.open();
      } catch {}
    }
    throw new Error("没有通过完整性检查的数据库备份");
  }
}
