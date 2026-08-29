import path from "node:path";
import type { ProxyJob } from "./types";

const csv = (value: unknown) => `"${String(value ?? "").replace(/"/g, '""')}"`;
const xml = (value: unknown) => String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const completed = (jobs: ProxyJob[]) => jobs.filter((job) => job.status === "completed" && job.outputPath);

export function generateDeliveryManifest(jobs: ProxyJob[], format: "resolve" | "premiere" | "fcpxml" | "json") {
  const rows = completed(jobs);
  if (!rows.length) throw new Error("没有已完成的代理可供交付");
  if (format === "json") return JSON.stringify({ generatedAt: new Date().toISOString(), application: "Kocpy", proxies: rows }, null, 2);
  if (format === "resolve") return "\ufeff" + ["Media Path,Clip Name,Reel,Timecode,Frame Rate,Source Path,Validation", ...rows.map((job) => [job.outputPath, path.basename(job.outputPath!), path.basename(job.input, path.extname(job.input)), job.timecode, job.sourceFrameRate, job.input, job.validation?.notes.join("; ") || "OK"].map(csv).join(","))].join("\n");
  if (format === "premiere") return "\ufeff" + ["File Path,Name,Media Type,Video Info,Audio Info,Start Timecode,Source", ...rows.map((job) => [job.outputPath, path.basename(job.outputPath!), "Video", `${job.resolution} ${job.format.toUpperCase()}`, job.sourceAudio, job.timecode, job.input].map(csv).join(","))].join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE fcpxml>\n<fcpxml version="1.10"><resources><format id="f1" name="Kocpy Proxy" frameDuration="1/25s" width="1920" height="1080"/>${rows.map((job, index) => `<asset id="r${index + 1}" name="${xml(path.basename(job.outputPath!))}" src="file://${xml(job.outputPath)}" start="0s" hasVideo="1" hasAudio="${job.sourceAudio ? "1" : "0"}" format="f1"/>`).join("")}</resources><library><event name="Kocpy Proxy Delivery"><project name="Kocpy Proxies"><sequence format="f1"><spine>${rows.map((_job, index) => `<asset-clip ref="r${index + 1}" offset="${index}s" duration="1s"/>`).join("")}</spine></sequence></project></event></library></fcpxml>\n`;
}
