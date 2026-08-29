import initSqlJs, { type Database } from "sql.js";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { BackupTask, ProjectConfig } from "./types";

const SCHEMA = 1;
export class CatalogDatabase {
  private db?: Database;
  private writes = Promise.resolve();
  constructor(private root: string) {}
  private get file() { return path.join(this.root, "catalog.sqlite"); }
  async open() {
    if (this.db) return this.db;
    const SQL = await initSqlJs();
    const bytes = await fs.readFile(this.file).catch(() => undefined);
    this.db = bytes ? new SQL.Database(bytes) : new SQL.Database();
    this.db.run(`PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY,project_id TEXT,name TEXT,shooting_date TEXT,status TEXT,provenance TEXT,created_at INTEGER,total_files INTEGER,total_bytes INTEGER,json TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS tasks_project_date ON tasks(project_id,shooting_date,created_at DESC);
      CREATE TABLE IF NOT EXISTS files(task_id TEXT NOT NULL,relative_path TEXT NOT NULL,size INTEGER,checksum TEXT,verified INTEGER,kind TEXT,PRIMARY KEY(task_id,relative_path));
      CREATE INDEX IF NOT EXISTS files_path ON files(relative_path);
      CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY,name TEXT,status TEXT,json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS changes(id TEXT PRIMARY KEY,project_id TEXT,task_id TEXT,at INTEGER,kind TEXT,note TEXT,json TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS changes_project_at ON changes(project_id,at DESC);`);
    this.db.run("INSERT OR REPLACE INTO meta(key,value) VALUES('schema',?)", [String(SCHEMA)]);
    await this.flush(); return this.db;
  }
  async rebuild(tasks: BackupTask[], projects: ProjectConfig[]) {
    const db = await this.open(); db.run("BEGIN");
    try {
      db.run("DELETE FROM files"); db.run("DELETE FROM tasks"); db.run("DELETE FROM projects");
      for (const project of projects) db.run("INSERT INTO projects VALUES(?,?,?,?)", [project.id, project.name, project.status || "active", JSON.stringify(project)]);
      for (const task of tasks) {
        db.run("INSERT INTO tasks VALUES(?,?,?,?,?,?,?,?,?,?)", [task.id, task.projectId || "", task.name, task.shootingDate || "", task.status, task.provenance || "kocpy-transfer", task.createdAt || 0, task.totalFiles, task.totalBytes, JSON.stringify(task)]);
        for (const file of task.fileRecords) db.run("INSERT OR REPLACE INTO files VALUES(?,?,?,?,?,?)", [task.id, file.relativePath, file.size, file.srcChecksum, file.destinations.some((item) => item.verified) ? 1 : 0, path.extname(file.name).toLowerCase()]);
      }
      db.run("COMMIT"); await this.flush();
    } catch (error) { db.run("ROLLBACK"); throw error; }
  }
  async pageFiles(options: { projectId?: string; query?: string; offset?: number; limit?: number }) {
    const db = await this.open(), limit = Math.min(1000, Math.max(1, options.limit || 100)), offset = Math.max(0, options.offset || 0), query = `%${(options.query || "").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
    const where = `${options.projectId ? "t.project_id=? AND " : ""}f.relative_path LIKE ? ESCAPE '\\'`, params: Array<string | number> = [...(options.projectId ? [options.projectId] : []), query, limit, offset];
    const statement = db.prepare(`SELECT f.task_id,f.relative_path,f.size,f.checksum,f.verified,t.name task_name,t.project_id FROM files f JOIN tasks t ON t.id=f.task_id WHERE ${where} ORDER BY t.created_at DESC,f.relative_path LIMIT ? OFFSET ?`); statement.bind(params);
    const rows: Record<string, unknown>[] = []; while (statement.step()) rows.push(statement.getAsObject()); statement.free(); return rows;
  }
  async stats() { const db = await this.open(), row = db.exec("SELECT (SELECT count(*) FROM tasks) tasks,(SELECT count(*) FROM files) files,(SELECT count(*) FROM projects) projects")[0]?.values[0] || [0,0,0]; return { tasks: Number(row[0]), files: Number(row[1]), projects: Number(row[2]), schema: SCHEMA }; }
  flush() { const action = this.writes.then(async () => { if (!this.db) return; await fs.mkdir(this.root, { recursive: true }); const temp = `${this.file}.tmp`, backup = `${this.file}.bak`; await fs.copyFile(this.file, backup).catch(() => {}); await fs.writeFile(temp, Buffer.from(this.db.export())); await fs.rename(temp, this.file); }); this.writes = action.catch(() => {}); return action; }
  async recover() { await fs.copyFile(`${this.file}.bak`, this.file); this.db?.close(); this.db = undefined; return this.open(); }
}
