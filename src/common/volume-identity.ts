export interface VolumeIdentity {
  id: string;
  uuid?: string;
  deviceNode?: string;
  name: string;
  device: string;
  fileSystem?: string;
  mountPoint?: string;
}

export function compareVolumeIdentity(
  expectedUuid: string | undefined,
  expectedId: string | undefined,
  current: VolumeIdentity,
): "match" | "legacy-match" | "unrecorded" | "unavailable" | "changed" {
  if (expectedUuid) {
    if (!current.uuid) return "unavailable";
    return expectedUuid.toUpperCase() === current.uuid.toUpperCase()
      ? "match"
      : "changed";
  }
  if (!expectedId) return "unrecorded";
  if (expectedId === current.id) return "match";
  // Older builds queried subdirectories and stored st_dev / device nodes instead of UUIDs.
  // This only preserves their existing comparison; it never overrides a recorded UUID.
  if (expectedId === current.device || expectedId === current.deviceNode)
    return "legacy-match";
  return "changed";
}

export function assertVolumeIdentity(
  expectedUuid: string | undefined,
  expectedId: string | undefined,
  current: VolumeIdentity,
  label: string,
) {
  const comparison = compareVolumeIdentity(expectedUuid, expectedId, current);
  if (comparison === "unavailable")
    throw new Error(
      `${label}磁盘身份暂时无法读取，已安全停止；这不表示 UUID 已改变。请到“检查并恢复”重新检查连接。`,
    );
  if (comparison === "changed")
    throw new Error(
      `${label}磁盘身份与任务记录不一致，已安全停止。请连接原磁盘；若已换盘，请另建备份任务，不要覆盖旧身份记录。`,
    );
}
