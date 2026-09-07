import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Materialize report HTML as a private, unique temporary file while Chromium
 * loads it. This avoids data-URL length limits for reports with many embedded
 * thumbnails. The exact temporary directory is removed on success or failure.
 */
export async function withTemporaryReportHtml<T>(
  html: Buffer | string,
  load: (file: string) => Promise<T>,
): Promise<T> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "kocpy-report-"));
  const file = path.join(directory, "report.html");
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(file, "wx", 0o600);
    await handle.writeFile(html);
    await handle.sync();
    await handle.close();
    handle = undefined;
    return await load(file);
  } finally {
    await handle?.close().catch(() => undefined);
    await fs.rm(directory, { recursive: true, force: true });
  }
}
