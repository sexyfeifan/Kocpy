import path from "node:path";
import { pathToFileURL } from "node:url";
import type { ProxyJob } from "./types";

const csv = (value: unknown) => `"${String(value ?? "").replace(/"/g, '""')}"`;
const xml = (value: unknown) =>
  String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
const completed = (jobs: ProxyJob[]) =>
  jobs.filter((job) => job.status === "completed" && job.outputPath);
const dimensions = (value: string) => {
  const exact = value.match(/(\d+)x(\d+)/i);
  if (exact) return [Number(exact[1]), Number(exact[2])];
  const height = Number(value.match(/(\d+)p/i)?.[1] || 1080);
  return [Math.round((height * 16) / 9), height];
};
const frameDuration = (value?: string) => {
  const fps = Number(value) || 25;
  if (Math.abs(fps - 23.976) < 0.02) return "1001/24000s";
  if (Math.abs(fps - 29.97) < 0.02) return "1001/30000s";
  if (Math.abs(fps - 59.94) < 0.02) return "1001/60000s";
  return `1/${Math.max(1, Math.round(fps))}s`;
};
const mediaDuration = (value?: string) => {
  const parts = String(value || "")
      .split(":")
      .map(Number),
    seconds =
      parts.length === 3
        ? parts[0] * 3600 + parts[1] * 60 + parts[2]
        : Number(value);
  return Number.isFinite(seconds) && seconds > 0
    ? Math.round(seconds * 1000)
    : 1000;
};

export function generateDeliveryManifest(
  jobs: ProxyJob[],
  format: "resolve" | "premiere" | "fcpxml" | "json",
) {
  const rows = completed(jobs);
  if (!rows.length) throw new Error("没有已完成的代理可供交付");
  if (format === "json")
    return JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        application: "Kocpy",
        proxies: rows,
      },
      null,
      2,
    );
  if (format === "resolve")
    return (
      "\ufeff" +
      [
        "Media Path,Clip Name,Reel,Timecode,Frame Rate,Source Path,Validation",
        ...rows.map((job) =>
          [
            job.outputPath,
            path.basename(job.outputPath!),
            path.basename(job.input, path.extname(job.input)),
            job.timecode,
            job.sourceFrameRate,
            job.input,
            job.validation?.notes.join("; ") || "OK",
          ]
            .map(csv)
            .join(","),
        ),
      ].join("\n")
    );
  if (format === "premiere")
    return (
      "\ufeff" +
      [
        "File Path,Name,Media Type,Video Info,Audio Info,Start Timecode,Source",
        ...rows.map((job) =>
          [
            job.outputPath,
            path.basename(job.outputPath!),
            "Video",
            `${job.resolution} ${job.format.toUpperCase()}`,
            job.sourceAudio,
            job.timecode,
            job.input,
          ]
            .map(csv)
            .join(","),
        ),
      ].join("\n")
    );
  const formats = rows
    .map((job, index) => {
      const [width, height] = dimensions(job.resolution);
      return `<format id="f${index + 1}" name="Kocpy ${xml(job.resolution)}" frameDuration="${frameDuration(job.sourceFrameRate)}" width="${width}" height="${height}"/>`;
    })
    .join("");
  let offset = 0;
  const clips = rows
    .map((job, index) => {
      const duration = mediaDuration(job.sourceDuration),
        clip = `<asset-clip ref="r${index + 1}" offset="${offset}/1000s" duration="${duration}/1000s"/>`;
      offset += duration;
      return clip;
    })
    .join("");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE fcpxml>\n<fcpxml version="1.10"><resources>${formats}${rows.map((job, index) => `<asset id="r${index + 1}" name="${xml(path.basename(job.outputPath!))}" src="${xml(pathToFileURL(job.outputPath!).href)}" start="0s" duration="${mediaDuration(job.sourceDuration)}/1000s" hasVideo="1" hasAudio="${job.sourceAudio ? "1" : "0"}" format="f${index + 1}"/>`).join("")}</resources><library><event name="Kocpy Proxy Delivery"><project name="Kocpy Proxies"><sequence format="f1" duration="${offset}/1000s"><spine>${clips}</spine></sequence></project></event></library></fcpxml>\n`;
}
