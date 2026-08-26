import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
export class Storage {
  private writes = Promise.resolve();
  constructor(public root: string) {}
  async read<T>(name: string, fallback: T): Promise<T> {
    for (const suffix of ["", ".bak"]) {
      try {
        return JSON.parse(
          await fs.readFile(path.join(this.root, name + suffix), "utf8"),
        );
      } catch (e: any) {
        if (e.code !== "ENOENT" && !(e instanceof SyntaxError)) throw e;
      }
    }
    return fallback;
  }
  write(name: string, value: unknown) {
    const data = JSON.stringify(value, null, 2);
    const result = this.writes
      .catch(() => {})
      .then(async () => {
        await fs.mkdir(this.root, { recursive: true });
        const file = path.join(this.root, name),
          temp = file + "." + randomUUID() + ".tmp";
        try {
          await fs.copyFile(file, file + ".bak").catch((e) => {
            if (e.code !== "ENOENT") throw e;
          });
          await fs.writeFile(temp, data, { flag: "wx" });
          const handle = await fs.open(temp, "r+");
          try {
            await handle.sync();
          } finally {
            await handle.close();
          }
          await fs.rename(temp, file);
        } finally {
          await fs.unlink(temp).catch(() => {});
        }
      });
    this.writes = result;
    return result;
  }
  flush() {
    return this.writes;
  }
}
export const defaultSettings = {
  defaultHash: "sha256",
  defaultDuplicateStrategy: "skip",
  includeHidden: true,
  operator: "",
  theme: "dark",
};
