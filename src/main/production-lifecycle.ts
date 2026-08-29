import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { scan } from "./backup/safety";
import { hashFile } from "./backup/BackupEngine";
import type { BackupTask, ExistingImportPreview, ProjectConfig, ProjectCoverage, ProjectTemplate } from "./types";

const datePattern = /(?:19|20)\d{2}[-_.]?(?:0[1-9]|1[0-2])[-_.]?(?:0[1-9]|[12]\d|3[01])/;
const cardPattern = /(?:card|roll|卷|卡|a|b|c|d|e)[-_ ]?\d{1,4}/i;
const cameraPattern = /(?:fx\d|a\d{3,4}|c\d{2,3}|r\d|ursa|komodo|venice|alexa|red|cam)[-_ ]?[a-e]?/i;
const normalizedDate = (value?: string) => value?.replace(/[^0-9]/g, "").replace(/^(\d{4})(\d{2})(\d{2})$/, "$1-$2-$3");

export async function previewExistingBackup(root: string): Promise<ExistingImportPreview> {
  const stat = await fs.stat(root); if (!stat.isDirectory()) throw new Error("接管路径必须是文件夹");
  const result = await scan(root, false), groupMap = new Map<string, ExistingImportPreview["groups"][number]>();
  for (const file of result.files) {
    const parts = file.relativePath.split(path.sep), relativeRoot = parts.length > 1 ? parts[0] : ".", current = groupMap.get(relativeRoot) || { key: relativeRoot, relativeRoot, files: 0, bytes: 0 };
    current.files++; current.bytes += file.size; const sample = parts.join("/"); current.suggestedDate ||= normalizedDate(sample.match(datePattern)?.[0]); current.suggestedDevice ||= sample.match(cameraPattern)?.[0]?.toUpperCase(); current.suggestedCard ||= sample.match(cardPattern)?.[0]; groupMap.set(relativeRoot, current);
  }
  const manifestFile = result.files.find((file) => /(?:\.mhl|sha256sums\.txt|manifest.*\.json)$/i.test(file.name));
  const sample = result.files.slice(0, 200).map((file) => file.relativePath).join("/");
  const candidateMap = new Map<string, ExistingImportPreview["candidates"][number]>(), mediaFiles = result.files.filter((file) => !/(?:\.mhl|sha256sums\.txt|manifest.*\.json)$/i.test(file.name));
  for (const file of mediaFiles) {
    const parts = file.relativePath.split(path.sep), cardIndex = parts.findIndex((part) => cardPattern.test(part));
    const end = cardIndex >= 0 ? cardIndex + 1 : parts.length === 1 ? 0 : 1, relativeRoot = end ? parts.slice(0, end).join(path.sep) : ".";
    const value = candidateMap.get(relativeRoot) || { relativeRoot, files: 0, bytes: 0, shootingDate: normalizedDate(relativeRoot.match(datePattern)?.[0]), device: relativeRoot.match(cameraPattern)?.[0]?.toUpperCase(), card: parts[cardIndex >= 0 ? cardIndex : end - 1] };
    value.files++; value.bytes += file.size; candidateMap.set(relativeRoot, value);
  }
  return { root, files: result.files.length, bytes: result.totalBytes, manifest: manifestFile?.absolutePath, suggestedDate: normalizedDate(sample.match(datePattern)?.[0]), suggestedDevice: sample.match(cameraPattern)?.[0]?.toUpperCase(), suggestedCard: sample.match(cardPattern)?.[0], groups: [...groupMap.values()].sort((a,b) => a.relativeRoot.localeCompare(b.relativeRoot)), candidates: [...candidateMap.values()].sort((a,b)=>a.relativeRoot.localeCompare(b.relativeRoot)) };
}

async function readManifest(file?: string) {
  const values = new Map<string,string>(); if (!file) return values; const text = await fs.readFile(file, "utf8");
  for (const block of text.matchAll(/<hash(?:\s[^>]*)?>([\s\S]*?)<\/hash>/gi)) {
    const name = block[1].match(/<(?:path|file)(?:\s[^>]*)?>([^<]+)<\/(?:path|file)>/i)?.[1];
    const checksum = block[1].match(/<(?:md5|sha1|sha256)(?:\s[^>]*)?>([a-f0-9]{32,64})<\/(?:md5|sha1|sha256)>/i)?.[1];
    if (name && checksum) values.set(name.replaceAll("/", path.sep), checksum.toLowerCase());
  }
  for (const line of text.split(/\r?\n/)) { const match = line.match(/^([a-f0-9]{32,64})\s+\*?(.+)$/i); if (match) values.set(match[2].replaceAll("/", path.sep), match[1].toLowerCase()); }
  if (/\.json$/i.test(file)) try { const parsed = JSON.parse(text), rows = Array.isArray(parsed) ? parsed : parsed.files || parsed.entries || []; for (const row of rows) { const name = row.path || row.file || row.relativePath, checksum = row.sha256 || row.sha1 || row.md5 || row.checksum; if (typeof name === "string" && typeof checksum === "string" && /^[a-f0-9]{32,64}$/i.test(checksum)) values.set(name.replaceAll("/", path.sep), checksum.toLowerCase()); } } catch { /* non-JSON manifests continue through text parsers */ }
  return values;
}

export async function importExistingBackup(project: ProjectConfig, root: string, mode: "manifest-import" | "external-baseline" | "unverified-import", metadata: { shootingDate?: string; device?: string; card?: string } = {}): Promise<BackupTask> {
  const preview = await previewExistingBackup(root), scanned = await scan(root, false), manifest = await readManifest(preview.manifest), algorithm = manifest.size && [...manifest.values()][0]?.length === 32 ? "md5" : "sha256", destinationId = randomUUID(), verifiedMode = mode !== "unverified-import";
  const records = [];
  for (const file of scanned.files) {
    if (file.absolutePath === preview.manifest) continue;
    const expected = manifest.get(file.relativePath), checksum = verifiedMode ? await hashFile(file.absolutePath, algorithm) : "";
    const verified = mode === "external-baseline" || (mode === "manifest-import" && Boolean(expected) && expected === checksum);
    records.push({ name:file.name, relativePath:file.relativePath, size:file.size, srcChecksum:checksum || expected || "", destinations:[{ path:file.absolutePath, checksum:checksum || "", verified }] });
  }
  const verified = records.length > 0 && records.every((file) => file.destinations[0].verified), now = Date.now();
  return { id:randomUUID(), projectId:project.id, projectFolderName:project.projectFolderName, shootingDate:metadata.shootingDate || preview.suggestedDate, createdAt:now, importedAt:now, provenance:mode, confidence:mode === "manifest-import" && verified ? "verified" : mode === "external-baseline" ? "baseline" : "unverified", name:metadata.card || preview.suggestedCard || path.basename(root), sourcePath:root, devices:[metadata.device || preview.suggestedDevice || "外部素材"], destinations:[{ id:destinationId,path:root,resolvedPath:root,label:path.basename(root),verified,bytesWritten:0,copiedBytes:0,verifiedBytes:verified ? records.reduce((sum,file)=>sum+file.size,0):0,copyProgress:100,verifyProgress:verified?100:0 }], hashAlgorithm:algorithm, namingTemplate:path.basename(root), status:verified?"completed":"failed", totalFiles:records.length,completedFiles:records.length,totalBytes:records.reduce((sum,file)=>sum+file.size,0),transferredBytes:records.reduce((sum,file)=>sum+file.size,0),physicalWrittenBytes:0,verifiedBytes:verified?records.reduce((sum,file)=>sum+file.size,0):0,speedBps:0,eta:0,currentFile:"",verifyLog:[mode === "manifest-import" ? `根据外部清单接管：${verified ? "全部匹配" : "存在缺失或不匹配"}` : mode === "external-baseline" ? "已在接管时建立首次哈希基线；不代表原始现场接收校验" : "目录结构已导入，尚未建立可信校验"],errorMessage:verified?undefined:"接管目录尚未全部通过可信校验",fileRecords:records };
}

export function projectCoverage(project: ProjectConfig, tasks: BackupTask[]): ProjectCoverage {
  const related = tasks.filter((task) => task.projectId === project.id), required = project.requiredCopies || 2, byProvenance: Record<string,number> = {};
  let verified=0, compliant=0, attention=0; for (const task of related) { const source=task.provenance||"kocpy-transfer"; byProvenance[source]=(byProvenance[source]||0)+1; const copies=new Set(task.destinations.filter((item)=>item.verified).map((item)=>item.volumeUuid||item.volumeId||item.path)).size; if (copies) verified++; if (copies>=required) compliant++; else attention++; }
  const expected=project.expectedVolumes; return { recorded:related.length,verified,compliant,attention,byProvenance,managedSince:project.managedSince,expected,coveragePercent:expected?Math.min(100,Math.round(related.length/expected*100)):undefined };
}

export const builtInProductionTemplates = (): ProjectTemplate[] => [
  ["commercial","广告",["A Cam","B Cam"],3],["documentary","纪录片",["A Cam","Audio"],2],["short","短片",["A Cam","B Cam","Audio"],3],["variety","综艺",["Cam 1","Cam 2","Cam 3","Audio"],2],["feature","电影",["A Cam","B Cam","Sound"],3],
].map(([id,name,devices,copies]) => ({ id:`builtin-${id}`,name:`${name}制作`,devices:devices as string[],volumePrefix:"ROLL_",requiredCopies:Number(copies),namingRule:"{date}_{project}/{shootingDate}/{device}/{card}",completionActions:["report","delivery"],createdAt:0,updatedAt:0 }));
