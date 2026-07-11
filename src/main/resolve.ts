import * as fs from 'fs'
import * as path from 'path'
import { logInfo, logError } from './logger'

/**
 * DaVinci Resolve 集成模块
 * 支持导出 ALE、XML、CDL 文件，自动创建 Resolve 项目
 */

export interface ResolveExportOptions {
  format: 'ale' | 'xml' | 'edl' | 'cdl'
  outputPath: string
  includeMetadata: boolean
  includeLUT: boolean
  lutPath?: string
}

export interface ALEEntry {
  clipName: string
  sourceFile: string
  startTimecode: string
  endTimecode: string
  duration: string
  frameRate: string
  resolution: string
  camera: string
  iso: string
  aperture: string
  shutter: string
  // 更多元数据...
}

/**
 * 导出 ALE 文件
 */
export async function exportALE(entries: ALEEntry[], outputPath: string): Promise<void> {
  const header = 'Name\tDuration\tStart\tEnd\tSource File\tFrame Rate\tResolution\tCamera\tISO\tAperture\tShutter\n'
  
  const rows = entries.map(entry => [
    entry.clipName,
    entry.duration,
    entry.startTimecode,
    entry.endTimecode,
    entry.sourceFile,
    entry.frameRate,
    entry.resolution,
    entry.camera,
    entry.iso,
    entry.aperture,
    entry.shutter
  ].join('\t')).join('\n')

  const content = header + rows
  await fs.promises.writeFile(outputPath, content, 'utf-8')
  logInfo(`ALE exported: ${outputPath}`)
}

/**
 * 导出 FCP XML 文件
 */
export async function exportFCPXML(entries: ALEEntry[], outputPath: string): Promise<void> {
  const clips = entries.map(entry => `
    <clip>
      <name>${escapeXML(entry.clipName)}</name>
      <duration>${entry.duration}</duration>
      <rate>
        <ntsc>FALSE</ntsc>
        <timebase>${entry.frameRate}</timebase>
      </rate>
      <in>0</in>
      <out>${entry.duration}</out>
      <start>0</start>
      <end>${entry.duration}</end>
      <file>
        <name>${escapeXML(path.basename(entry.sourceFile))}</name>
        <pathurl>${escapeXML(entry.sourceFile)}</pathurl>
        <rate>
          <ntsc>FALSE</ntsc>
          <timebase>${entry.frameRate}</timebase>
        </rate>
        <duration>${entry.duration}</duration>
        <media>
          <video>
            <samplecharacteristics>
              <width>${entry.resolution.split('x')[0]}</width>
              <height>${entry.resolution.split('x')[1]}</height>
            </samplecharacteristics>
          </video>
        </media>
      </file>
    </clip>`
  ).join('\n')

  const content = `<?xml version="1.0" encoding="UTF-8"?>
<xmeml version="5">
  <sequence>
    <name>Kocpy Export</name>
    <media>
      <video>
        <format>
          <samplecharacteristics>
            <width>1920</width>
            <height>1080</height>
          </samplecharacteristics>
        </format>
        <track>
          ${clips}
        </track>
      </video>
    </media>
  </sequence>
</xmeml>`

  await fs.promises.writeFile(outputPath, content, 'utf-8')
  logInfo(`FCP XML exported: ${outputPath}`)
}

/**
 * 导出 EDL 文件
 */
export async function exportEDL(entries: ALEEntry[], outputPath: string): Promise<void> {
  const edl = entries.map((entry, index) => {
    const eventNum = String(index + 1).padStart(3, '0')
    return `${eventNum}  ${entry.clipName} V  C  00:00:00:00 ${entry.duration} 00:00:00:00 ${entry.duration}
* FROM CLIP NAME: ${entry.sourceFile}
* CAMERA: ${entry.camera}
* ISO: ${entry.iso}
* APERTURE: ${entry.aperture}
* SHUTTER: ${entry.shutter}`
  }).join('\n\n')

  await fs.promises.writeFile(outputPath, edl, 'utf-8')
  logInfo(`EDL exported: ${outputPath}`)
}

/**
 * 导出 CDL 文件
 */
export async function exportCDL(options: {
  name: string
  slope: [number, number, number]
  offset: [number, number, number]
  power: [number, number, number]
  saturation: number
}, outputPath: string): Promise<void> {
  const content = `<?xml version="1.0" encoding="UTF-8"?>
<ColorDecisionList version="1.0">
  <ColorDecision>
    <ColorCorrection name="${options.name}">
      <SOPNode>
        <Slope>${options.slope.join(' ')}</Slope>
        <Offset>${options.offset.join(' ')}</Offset>
        <Power>${options.power.join(' ')}</Power>
      </SOPNode>
      <SatNode>
        <Saturation>${options.saturation}</Saturation>
      </SatNode>
    </ColorCorrection>
  </ColorDecision>
</ColorDecisionList>`

  await fs.promises.writeFile(outputPath, content, 'utf-8')
  logInfo(`CDL exported: ${outputPath}`)
}

/**
 * 创建 Resolve 项目结构
 */
export async function createResolveProject(projectName: string, basePath: string): Promise<{
  projectDir: string
  mediaDir: string
  timelineDir: string
  exportDir: string
}> {
  const projectDir = path.join(basePath, projectName)
  const mediaDir = path.join(projectDir, 'Media')
  const timelineDir = path.join(projectDir, 'Timelines')
  const exportDir = path.join(projectDir, 'Exports')

  await fs.promises.mkdir(projectDir, { recursive: true })
  await fs.promises.mkdir(mediaDir, { recursive: true })
  await fs.promises.mkdir(timelineDir, { recursive: true })
  await fs.promises.mkdir(exportDir, { recursive: true })

  logInfo(`Resolve project created: ${projectDir}`)

  return { projectDir, mediaDir, timelineDir, exportDir }
}

/**
 * 生成 Resolve 项目文件 (.drp)
 */
export async function generateDRP(projectName: string, outputPath: string): Promise<void> {
  // DRP 是 DaVinci Resolve 的二进制项目文件
  // 这里生成一个简化的 XML 结构
  const content = `<?xml version="1.0" encoding="UTF-8"?>
<ResolveProject name="${projectName}" version="18.0">
  <MediaPool>
    <Bins/>
    <Clips/>
  </MediaPool>
  <Timelines/>
  <ColorGrading/>
  <ExportSettings>
    <Format>ProRes</Format>
    <Resolution>1920x1080</Resolution>
    <FrameRate>23.976</FrameRate>
  </ExportSettings>
</ResolveProject>`

  await fs.promises.writeFile(outputPath, content, 'utf-8')
  logInfo(`DRP generated: ${outputPath}`)
}

/**
 * XML 转义
 */
function escapeXML(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

/**
 * 获取支持的导出格式
 */
export function getSupportedExportFormats(): Array<{ value: string; label: string }> {
  return [
    { value: 'ale', label: 'ALE (Avid Log Exchange)' },
    { value: 'xml', label: 'FCP XML (Final Cut Pro)' },
    { value: 'edl', label: 'EDL (Edit Decision List)' },
    { value: 'cdl', label: 'CDL (Color Decision List)' }
  ]
}
