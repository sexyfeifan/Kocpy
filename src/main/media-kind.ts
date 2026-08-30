import type { BackupTask, FileRecord } from "./types";

export type MediaKind = "video" | "photo" | "audio" | "mixed" | "other";
export type MediaBreakdown = NonNullable<BackupTask["mediaBreakdown"]>;

const mediaKinds = ["video", "photo", "audio", "other"] as const;

export function mediaKindForName(
  name: string,
): Exclude<MediaKind, "mixed"> {
  if (/\.(mov|mp4|mxf|mkv|avi|m4v|r3d|braw)$/i.test(name)) return "video";
  if (/\.(jpg|jpeg|png|heic|tif|tiff|dng|arw|cr2|cr3|nef|raf)$/i.test(name))
    return "photo";
  if (/\.(wav|mp3|aac|flac|aif|aiff)$/i.test(name)) return "audio";
  return "other";
}

export function mediaBreakdownFromFiles(
  files: Array<Pick<FileRecord, "name" | "size">>,
): MediaBreakdown {
  const breakdown = Object.fromEntries(
    mediaKinds.map((kind) => [kind, { files: 0, bytes: 0 }]),
  ) as MediaBreakdown;
  for (const file of files) {
    const group = breakdown[mediaKindForName(file.name)];
    group.files++;
    group.bytes += file.size;
  }
  return breakdown;
}

export function ensureTaskMediaBreakdown(task: BackupTask): boolean {
  if (task.mediaBreakdown || !task.fileRecords.length) return false;
  task.mediaBreakdown = mediaBreakdownFromFiles(task.fileRecords);
  return true;
}

const audioDevice = (task: Pick<BackupTask, "devices">) =>
  task.devices.some((device) =>
    /(?:音频|录音|声音|audio|sound|boom|mixer)/i.test(device),
  );

export function taskMediaKind(
  task: Pick<BackupTask, "devices" | "mediaBreakdown">,
): MediaKind {
  const breakdown = task.mediaBreakdown;
  if (!breakdown) return audioDevice(task) ? "audio" : "other";
  const present = mediaKinds
    .filter((kind) => kind !== "other" && breakdown[kind].files > 0)
    .map((kind) => ({
      kind,
      bytes: breakdown[kind].bytes,
      files: breakdown[kind].files,
    }));
  if (!present.length) return audioDevice(task) ? "audio" : "other";
  if (present.length === 1) return present[0].kind;
  const ordered = present.sort(
      (left, right) => right.bytes - left.bytes || right.files - left.files,
    ),
    totalBytes = ordered.reduce((sum, item) => sum + item.bytes, 0),
    totalFiles = ordered.reduce((sum, item) => sum + item.files, 0),
    leader = ordered[0];
  if (
    (totalBytes > 0 && leader.bytes / totalBytes >= 0.8) ||
    (totalBytes === 0 && leader.files / totalFiles >= 0.8)
  )
    return leader.kind;
  return "mixed";
}
