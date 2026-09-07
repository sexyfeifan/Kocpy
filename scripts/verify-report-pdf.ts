import { app, BrowserWindow } from "electron";
import { promises as fs } from "node:fs";
import { withTemporaryReportHtml } from "../src/main/report-html";

async function main() {
  await app.whenReady();
  const repeatedRows = Array.from(
    { length: 250 },
    (_, index) =>
      `<tr><td>${index}</td><td>synthetic/DCIM/clip-${index}.mov</td><td>verified</td></tr>`,
  ).join("");
  const embeddedThumbnailPayload = "a".repeat(8 * 1024 * 1024);
  const html = `<!doctype html><meta charset="utf-8"><style>body{font:12px sans-serif}table{width:100%}</style><template data-synthetic-thumbnails="${embeddedThumbnailPayload}"></template><table>${repeatedRows}</table>`;
  const report = new BrowserWindow({
    show: false,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  let temporaryFile = "";
  try {
    await withTemporaryReportHtml(html, async (file) => {
      temporaryFile = file;
      await report.loadFile(file);
    });
    await fs.stat(temporaryFile).then(
      () => {
        throw new Error("temporary report HTML was not removed after loading");
      },
      (error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      },
    );
    const pdf = await report.webContents.printToPDF({
      printBackground: true,
      pageSize: "A4",
    });
    if (pdf.length < 1024)
      throw new Error(`generated PDF is unexpectedly small: ${pdf.length}`);
    console.log(
      JSON.stringify({
        status: "PASS",
        htmlBytes: Buffer.byteLength(html),
        pdfBytes: pdf.length,
        temporaryHtmlRemovedBeforePrint: true,
      }),
    );
  } finally {
    report.destroy();
    app.quit();
  }
}

void main().catch((error) => {
  console.error(error);
  app.exit(1);
});
