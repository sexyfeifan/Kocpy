import path from "node:path";
import { existsSync } from "node:fs";
export function ffmpegPath() {
  const name = `ffmpeg-darwin-${process.arch === "x64" ? "x64" : "arm64"}`;
  const packaged = path.join((process as any).resourcesPath || "", "ffmpeg", name);
  const development = path.resolve(process.cwd(), "resources", "ffmpeg", name);
  const binary = existsSync(packaged) ? packaged : development;
  if (!existsSync(binary)) throw new Error(`缺少 ${process.arch} 架构的内置 FFmpeg`);
  return binary;
}
