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
  async readValidated<T>(
    name: string,
    fallback: T,
    validate: (value: unknown) => T,
  ): Promise<T> {
    return (await this.readValidatedWithSource(name, fallback, validate)).value;
  }
  async readValidatedWithSource<T>(
    name: string,
    fallback: T,
    validate: (value: unknown) => T,
  ): Promise<{
    value: T;
    source: "primary" | "backup" | "fallback";
  }> {
    let found = false,
      lastError: unknown;
    for (const [suffix, source] of [
      ["", "primary"],
      [".bak", "backup"],
    ] as const) {
      try {
        const serialized = await fs.readFile(
          path.join(this.root, name + suffix),
          "utf8",
        );
        found = true;
        return { value: validate(JSON.parse(serialized)), source };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        if (error instanceof SyntaxError || found) {
          lastError = error;
          continue;
        }
        throw error;
      }
    }
    if (found)
      throw new Error(
        `${name} 主记录与备份均未通过完整性校验：${
          lastError instanceof Error ? lastError.message : String(lastError)
        }`,
      );
    return { value: fallback, source: "fallback" };
  }
  write(name: string, value: unknown) {
    return this.writeSerialized(name, JSON.stringify(value, null, 2));
  }
  /**
   * Repairs a primary record from a value that was already semantically
   * validated from `.bak`. The known-good backup is intentionally preserved;
   * a syntactically valid but semantically corrupt primary must never replace
   * it during recovery.
   */
  writeRecovered(name: string, value: unknown) {
    return this.writeSerialized(name, JSON.stringify(value, null, 2), false);
  }
  writeSerialized(name: string, data: string, backupCurrent = true) {
    const result = this.writes
      .catch(() => {})
      .then(async () => {
        await fs.mkdir(this.root, { recursive: true });
        const file = path.join(this.root, name),
          temp = file + "." + randomUUID() + ".tmp";
        try {
          if (backupCurrent) {
            const currentIsValid = await fs
              .readFile(file, "utf8")
              .then((current) => {
                JSON.parse(current);
                return true;
              })
              .catch((error) => {
                if (error.code === "ENOENT" || error instanceof SyntaxError)
                  return false;
                throw error;
              });
            if (currentIsValid) await fs.copyFile(file, file + ".bak");
          }
          await fs.writeFile(temp, data, { flag: "wx" });
          const handle = await fs.open(temp, "r+");
          try {
            await handle.sync();
          } finally {
            await handle.close();
          }
          await fs.rename(temp, file);
          const directory = await fs.open(this.root, "r");
          try {
            await directory.sync().catch((error) => {
              if (!["EINVAL", "ENOTSUP", "EBADF"].includes(error.code || ""))
                throw error;
            });
          } finally {
            await directory.close();
          }
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
  automaticPdf: true,
  operator: "",
  theme: "dark",
  reportSyncPath: "",
  thumbnailCacheGiB: 2,
  notificationSound: true,
};
