import type { VolumeIdentity } from "./volume-identity";
export interface RecoveryCheck {
  role: "source" | "destination";
  label: string;
  path: string;
  expectedUuid?: string;
  expectedId?: string;
  current?: VolumeIdentity;
  status: "match" | "legacy-match" | "unrecorded" | "unavailable" | "changed";
  blocking: boolean;
  note: string;
  freeBytes?: number;
}
export interface RecoveryReport {
  taskId: string;
  checkedAt: number;
  canRetry: boolean;
  checks: RecoveryCheck[];
  explanation: string;
}
export function recoveryAdvice(error: string) {
  if (/UUID|磁盘身份|磁盘.*(断开|更换)|卷身份/.test(error))
    return {
      title: "先确认是原磁盘，再恢复",
      steps: [
        "点击只读检查，比较任务记录与当前磁盘身份。查询失败不等于磁盘已更换。",
        "若身份一致，可重试未通过目标；若离线，请重新连接原盘。",
        "若确实格式化或更换了磁盘，请另建备份任务。不会自动覆盖旧 UUID，也不要通过改盘名绕过检查。",
      ],
    };
  if (/ENOSPC|空间不足|空间.*不够/.test(error))
    return {
      title: "目的地空间不足",
      steps: [
        "在 Finder 中检查目标盘可用空间，或选择容量足够的新目的地。",
        "Kocpy 不会自动删除素材来腾出空间；原任务和已写入文件保留。",
        "处理后重新检查并重试；真正写入前仍会进行精确空间预检。",
      ],
    };
  if (/EACCES|EPERM|EROFS|权限|只读/.test(error))
    return {
      title: "磁盘或目录权限需要处理",
      steps: [
        "在 Finder 确认源可读取、目的地可写，并检查 macOS 文件与文件夹权限。",
        "软件不会自动提权或修改整盘权限；只读介质请另选可写目的地。",
        "权限处理完成后，重新检查再重试。",
      ],
    };
  if (/ENOENT|ENODEV|离线|不存在|No such file/.test(error))
    return {
      title: "先恢复可访问的路径",
      steps: [
        "连接原磁盘，确认源与目的地目录仍在原位置。",
        "若目录已移动或卷名已改变，不要盲目重试。可另建任务选择正确路径；已完成接管素材使用重新定位流程。",
        "重新检查只检查连接与身份，不等于文件哈希校验。",
      ],
    };
  if (/素材源.*(变化|改变)|源文件.*(变化|改变)/.test(error))
    return {
      title: "素材源在任务期间发生变化",
      steps: [
        "停止其他软件对素材源的写入，确认源素材是否仍为本次需要备份的版本。",
        "不要把变化后的源当成原任务继续。保留旧记录，确认后另建任务。",
      ],
    };
  if (/同名|已存在|互相包含|重复|路径.*(冲突|越界)|符号链接/.test(error))
    return {
      title: "目录或同名文件冲突",
      steps: [
        "核对源、目的地和最终保存路径，不能相同或互相包含。",
        "同名不同内容不能当成已有副本。请选择独立的新目录，或使用明确的重名保留策略另建任务。",
        "软件不会自动覆盖、删除冲突素材。",
      ],
    };
  if (/校验|哈希|checksum|hash|EIO|读取失败|写入失败/.test(error))
    return {
      title: "检查读写与内容一致性",
      steps: [
        "查看具体文件和目的地错误，检查磁盘连接、线缆及源素材可读性。",
        "接管素材的外部清单差异应在清单处理入口解决；不能通过普通复制重试抹去差异。",
        "普通备份可在检查后重试未通过目标，仍必须独立回读；反复失败请导出诊断包，不要强行采用副本。",
      ],
    };
  return {
    title: "保留现场，检查后再继续",
    steps: [
      "先检查源和目的地是否在线、身份是否一致。",
      "重试会重新预检并验证可复用文件与断点，不等于跳过复制或校验。",
      "若问题再次出现，请在诊断中心导出诊断包；不要删除原记录或格式化磁盘来消除警告。",
    ],
  };
}
