import initSqlJs, { type Database } from "sql.js";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { BackupTask, ProjectConfig } from "./types";

const SCHEMA = 2;
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
    this.db.run(`PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY,project_id TEXT,name TEXT,shooting_date TEXT,status TEXT,provenance TEXT,created_at INTEGER,total_files INTEGER,total_bytes INTEGER,json TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS tasks_project_date ON tasks(project_id,shooting_date,created_at DESC);
      CREATE TABLE IF NOT EXISTS files(task_id TEXT NOT NULL,relative_path TEXT NOT NULL,size INTEGER,checksum TEXT,verified INTEGER,kind TEXT,json TEXT,PRIMARY KEY(task_id,relative_path));
      CREATE INDEX IF NOT EXISTS files_path ON files(relative_path);
      CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY,name TEXT,status TEXT,json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS changes(id TEXT PRIMARY KEY,project_id TEXT,task_id TEXT,at INTEGER,kind TEXT,note TEXT,json TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS changes_project_at ON changes(project_id,at DESC);`);
    const columns =
      this.db
        .exec("PRAGMA table_info(files)")[0]
        ?.values.map((row) => String(row[1])) || [];
    if (!columns.includes("json"))
      this.db.run("ALTER TABLE files ADD COLUMN json TEXT");
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
            JSON.stringify(task),
          ]);
          for (const file of task.fileRecords)
            db.run("INSERT OR REPLACE INTO files VALUES(?,?,?,?,?,?,?)", [
              task.id,
              file.relativePath,
              file.size,
              file.srcChecksum,
              file.destinations.some((item) => item.verified) ? 1 : 0,
              path.extname(file.name).toLowerCase(),
              JSON.stringify(file),
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
      statement = db.prepare("SELECT json FROM tasks ORDER BY created_at ASC"),
      rows: BackupTask[] = [];
    while (statement.step()) {
      try {
        rows.push(JSON.parse(String(statement.get()[0])));
      } catch {
        /* a damaged row is skipped and can be recovered from the JSON mirror */
      }
    }
    statement.free();
    return rows;
  }
  async loadProjects(): Promise<ProjectConfig[]> {
    const db = await this.open(),
      statement = db.prepare("SELECT json FROM projects ORDER BY name"),
      rows: ProjectConfig[] = [];
    while (statement.step()) {
      try {
        rows.push(JSON.parse(String(statement.get()[0])));
      } catch {
        /* skip damaged row */
      }
    }
    statement.free();
    return rows;
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
          JSON.stringify(task),
        ]);
        for (const file of task.fileRecords)
          db.run("INSERT OR REPLACE INTO files VALUES(?,?,?,?,?,?,?)", [
            task.id,
            file.relativePath,
            file.size,
            file.srcChecksum,
            file.destinations.some((item) => item.verified) ? 1 : 0,
            path.extname(file.name).toLowerCase(),
            JSON.stringify(file),
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
    await fs.writeFile(temp, Buffer.from(this.db.export()));
    await fs.rename(temp, this.file);
  }
  flush() {
    return this.enqueue(() => this.persistNow());
  }
  async recover() {
    let restored = false;
    for (const suffix of [".bak", ".bak2", ".bak3"]) {
      try {
        await fs.copyFile(`${this.file}${suffix}`, this.file);
        restored = true;
        break;
      } catch {}
    }
    if (!restored) throw new Error("没有可用的数据库备份");
    this.db?.close();
    this.db = undefined;
    return this.open();
  }
}
