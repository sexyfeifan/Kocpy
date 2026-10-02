import type { ProxyAdvanced } from "../../main/types";
import { api } from "./api";

export function ProxyAdvancedSettings({ value, onChange, format, purpose, bitrate, onError }: {
  value: ProxyAdvanced; onChange: (value: ProxyAdvanced) => void;
  format: "h264" | "prores"; purpose: string; bitrate: number; onError: (error: string) => void;
}) {
  const update = (key: keyof ProxyAdvanced, choice: unknown) => onChange({ ...value, [key]: choice });
  const select = (key: keyof ProxyAdvanced, label: string, choices: [string, string][], numeric = false) => <label>{label}<select value={String(value[key] ?? "")} onChange={event => update(key, event.target.value ? numeric ? Number(event.target.value) : event.target.value : undefined)}>{choices.map(([id, text]) => <option key={id} value={id}>{text}</option>)}</select></label>;
  return <details className="proxy-advanced"><summary>高级转码设置</summary>
    <p className="muted">明确的转换会写入冻结参数与交付证据；原始素材不变。BT.709 转换不是 HDR 色调映射。</p>
    <div className="form-grid">
      {format === "h264" && select("encoder", "H.264 编码方式", [["software", "软件（兼容优先）"], ["auto", "自动（硬件不可用时回退）"], ["hardware", "仅硬件（不可用时报错）"]])}
      {select("frameRate", "输出帧率", [["source", "保留源帧率"], ...["24000/1001", "24", "25", "30000/1001", "30", "50", "60000/1001", "60"].map(rate => [rate, rate] as [string, string])])}
      {select("audioMode", "音轨选择", [["all", "全部音轨"], ["first", "第一音轨"], ...(purpose === "editorial" ? [] : [["none", "无音轨"] as [string, string]])])}
      {select("audioCodec", "音频编码", [["", "按格式自动"], ["aac", "AAC"], ["pcm_s16le", "PCM（MOV / MKV）"]])}
      {select("audioSampleRate", "音频采样率", [["", "保留源采样率"], ["44100", "44.1 kHz"], ["48000", "48 kHz"]], true)}
      {select("audioChannels", "每音轨声道数", [["", "保留源声道数"], ["1", "单声道"], ["2", "立体声"]], true)}
      {select("timecodeMode", "时间码", [["keep", "保留"], ["custom", "自定义"], ...(purpose === "editorial" ? [] : [["drop", "移除"] as [string, string]])])}
      {value.timecodeMode === "custom" && <label>自定义时间码<input value={value.timecode || ""} placeholder="01:00:00:00" onChange={event => update("timecode", event.target.value)} /></label>}
      {select("colorMode", "色彩处理", [["keep", "保留源色彩标记"], ["bt709", "转换为 BT.709（需已知源色彩）"]])}
      {select("rotation", "旋转处理", [["auto", "按源旋转信息自动转正"], ["metadata", "保留旋转元数据"], ["90", "顺时针 90°"], ["-90", "逆时针 90°"], ["180", "旋转 180°"]])}
      {select("aspect", "自定义尺寸比例", [["fit", "适配并补黑边"], ["crop", "填满并裁切"], ["stretch", "拉伸"]])}
      {format === "prores" ? select("proresProfile", "ProRes 档位（软件）", [["0", "Proxy"], ["1", "LT"], ["2", "422"], ["3", "HQ"]], true) : <>
        {select("h264Profile", "H.264 Profile", [["", "编码器默认"], ["baseline", "Baseline"], ["main", "Main"], ["high", "High"]])}
        <label>GOP 帧数<input type="number" min={1} max={300} value={value.gop ?? ""} onChange={event => update("gop", event.target.value ? Number(event.target.value) : undefined)} placeholder="编码器默认" /></label>
        {value.encoder === "software" && <>
          {!bitrate && <label>CRF（越低质量越高）<input type="number" min={0} max={51} value={value.crf ?? 23} onChange={event => update("crf", Number(event.target.value))} /></label>}
          {select("speed", "软件编码速度", [["", "Fast（默认）"], ["fast", "Fast"], ["medium", "Medium"], ["slow", "Slow"]])}
        </>}
      </>}
    </div>
    <label>3D .cube LUT<input readOnly value={value.lutPath || "未选择"} /></label>
    <div className="inline-actions"><button type="button" onClick={() => void api.selectProxyLut().then(lutPath => { if (lutPath) onChange({ ...value, lutPath, lutEvidence: undefined }); }).catch(error => onError(String(error)))}>选择 LUT</button><button type="button" disabled={!value.lutPath} onClick={() => onChange({ ...value, lutPath: undefined, lutEvidence: undefined })}>移除 LUT</button></div>
    <small>预检记录 LUT 哈希；入队与转码前检查内容是否变化。仅自动模式在编码器兼容性错误时重试软件编码，磁盘和权限错误不回退。</small>
  </details>;
}
