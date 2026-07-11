import * as fs from 'fs'
import * as path from 'path'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { logInfo, logError } from './logger'

const execFileAsync = promisify(execFile)

/**
 * 转码模块
 * 支持生成代理文件、LUT/CDL 应用
 */

export type TranscodeFormat = 'prores' | 'h264' | 'h265'
export type TranscodeResolution = '4k' | '1080p' | '720p' | '480p'
export type TranscodeQuality = 'low' | 'medium' | 'high'

export interface TranscodeOptions {
  inputPath: string
  outputPath: string
  format: TranscodeFormat
  resolution: TranscodeResolution
  quality: TranscodeQuality
  applyLUT?: string  // LUT 文件路径
  applyCDL?: CDLOptions
  preserveTimecode: boolean
  preserveAudio: boolean
  hardwareAcceleration?: 'auto' | 'videotoolbox' | 'qsv' | 'nvenc'
}

export interface CDLOptions {
  slope: [number, number, number]
  offset: [number, number, number]
  power: [number, number, number]
  saturation: number
}

export interface TranscodeResult {
  success: boolean
  outputPath: string
  duration: number  // 毫秒
  inputSize: number
  outputSize: number
  compressionRatio: number
  error?: string
}

/**
 * FFmpeg 路径（内置）
 */
const ffmpegPath = process.env.FFMPEG_PATH || 'ffmpeg'

/**
 * 转码视频文件
 */
export async function transcodeVideo(options: TranscodeOptions): Promise<TranscodeResult> {
  const startTime = Date.now()
  const args = buildFFmpegArgs(options)

  logInfo(`开始转码: ${options.inputPath}`)
  logInfo(`输出: ${options.outputPath}`)
  logInfo(`格式: ${options.format}, 分辨率: ${options.resolution}, 质量: ${options.quality}`)

  try {
    // 确保输出目录存在
    const outputDir = path.dirname(options.outputPath)
    await fs.promises.mkdir(outputDir, { recursive: true })

    // 执行转码
    await execFileAsync(ffmpegPath, args, {
      maxBuffer: 1024 * 1024 * 10  // 10MB buffer
    })

    // 获取文件大小
    const [inputStat, outputStat] = await Promise.all([
      fs.promises.stat(options.inputPath),
      fs.promises.stat(options.outputPath)
    ])

    const duration = Date.now() - startTime
    const compressionRatio = outputStat.size / inputStat.size

    logInfo(`转码完成: ${options.outputPath}`)
    logInfo(`耗时: ${duration}ms, 压缩率: ${(compressionRatio * 100).toFixed(2)}%`)

    return {
      success: true,
      outputPath: options.outputPath,
      duration,
      inputSize: inputStat.size,
      outputSize: outputStat.size,
      compressionRatio
    }
  } catch (err) {
    logError(`转码失败: ${options.inputPath}`, err)
    return {
      success: false,
      outputPath: options.outputPath,
      duration: Date.now() - startTime,
      inputSize: 0,
      outputSize: 0,
      compressionRatio: 0,
      error: String(err)
    }
  }
}

/**
 * 构建 FFmpeg 参数
 */
function buildFFmpegArgs(options: TranscodeOptions): string[] {
  const args: string[] = [
    '-i', options.inputPath,
    '-y'  // 覆盖输出文件
  ]

  // 视频编码
  const videoCodec = getVideoCodec(options.format, options.hardwareAcceleration)
  args.push('-c:v', videoCodec)

  // 分辨率
  const resolution = getResolution(options.resolution)
  if (resolution) {
    args.push('-vf', `scale=${resolution}`)
  }

  // 质量（CRF）
  const crf = getCRF(options.format, options.quality)
  args.push('-crf', crf.toString())

  // 音频编码
  if (options.preserveAudio) {
    args.push('-c:a', 'aac', '-b:a', '128k')
  } else {
    args.push('-an')
  }

  // 时间码
  if (options.preserveTimecode) {
    args.push('-map_metadata', '0')
  }

  // LUT 应用
  if (options.applyLUT) {
    const lutFilter = `lut3d='${options.applyLUT}'`
    if (args.includes('-vf')) {
      // 追加到现有滤镜
      const vfIndex = args.indexOf('-vf')
      args[vfIndex + 1] += `,${lutFilter}`
    } else {
      args.push('-vf', lutFilter)
    }
  }

  // CDL 应用
  if (options.applyCDL) {
    const cdlFilter = buildCDLFilter(options.applyCDL)
    if (args.includes('-vf')) {
      const vfIndex = args.indexOf('-vf')
      args[vfIndex + 1] += `,${cdlFilter}`
    } else {
      args.push('-vf', cdlFilter)
    }
  }

  args.push(options.outputPath)
  return args
}

/**
 * 获取视频编码器
 */
function getVideoCodec(format: TranscodeFormat, hwAccel?: string): string {
  switch (format) {
    case 'prores':
      return 'prores_ks'
    case 'h264':
      if (hwAccel === 'videotoolbox') return 'h264_videotoolbox'
      if (hwAccel === 'qsv') return 'h264_qsv'
      if (hwAccel === 'nvenc') return 'h264_nvenc'
      return 'libx264'
    case 'h265':
      if (hwAccel === 'videotoolbox') return 'hevc_videotoolbox'
      if (hwAccel === 'qsv') return 'hevc_qsv'
      if (hwAccel === 'nvenc') return 'hevc_nvenc'
      return 'libx265'
    default:
      return 'libx264'
  }
}

/**
 * 获取分辨率
 */
function getResolution(resolution: TranscodeResolution): string | null {
  switch (resolution) {
    case '4k':
      return '3840:2160'
    case '1080p':
      return '1920:1080'
    case '720p':
      return '1280:720'
    case '480p':
      return '854:480'
    default:
      return null
  }
}

/**
 * 获取 CRF 值（质量控制）
 */
function getCRF(format: TranscodeFormat, quality: TranscodeQuality): number {
  const crfMap: Record<TranscodeFormat, Record<TranscodeQuality, number>> = {
    prores: {
      low: 28,
      medium: 23,
      high: 18
    },
    h264: {
      low: 28,
      medium: 23,
      high: 18
    },
    h265: {
      low: 30,
      medium: 25,
      high: 20
    }
  }

  return crfMap[format][quality]
}

/**
 * 构建 CDL 滤镜
 */
function buildCDLFilter(cdl: CDLOptions): string {
  const { slope, offset, power, saturation } = cdl
  return `colorbalance=rs=${slope[0]}:gs=${slope[1]}:bs=${slope[2]}:ro=${offset[0]}:go=${offset[1]}:bo=${offset[2]}:rp=${power[0]}:gp=${power[1]}:bp=${power[2]}:s=${saturation}`
}

/**
 * 批量转码
 */
export async function transcodeBatch(
  files: Array<{ inputPath: string; outputPath: string }>,
  options: Omit<TranscodeOptions, 'inputPath' | 'outputPath'>,
  concurrency: number = 2
): Promise<TranscodeResult[]> {
  const results: TranscodeResult[] = []
  const queue = [...files]
  const workers: Promise<void>[] = []

  async function worker() {
    while (queue.length > 0) {
      const { inputPath, outputPath } = queue.shift()!
      const result = await transcodeVideo({
        ...options,
        inputPath,
        outputPath
      })
      results.push(result)
    }
  }

  // 启动多个并行 worker
  for (let i = 0; i < Math.min(concurrency, files.length); i++) {
    workers.push(worker())
  }

  await Promise.all(workers)
  return results
}

/**
 * 生成代理文件名
 */
export function generateProxyFileName(
  originalName: string,
  format: TranscodeFormat,
  resolution: TranscodeResolution
): string {
  const ext = path.extname(originalName)
  const name = path.basename(originalName, ext)
  return `${name}_proxy_${resolution}.${format === 'prores' ? 'mov' : format}`
}

/**
 * 获取支持的格式列表
 */
export function getSupportedFormats(): TranscodeFormat[] {
  return ['prores', 'h264', 'h265']
}

/**
 * 获取格式描述
 */
export function getFormatDescription(format: TranscodeFormat): string {
  const descriptions: Record<TranscodeFormat, string> = {
    prores: 'Apple ProRes (高质量，适合编辑)',
    h264: 'H.264/AVC (兼容性好，文件小)',
    h265: 'H.265/HEVC (最新标准，压缩率高)'
  }
  return descriptions[format]
}

/**
 * 获取分辨率描述
 */
export function getResolutionDescription(resolution: TranscodeResolution): string {
  const descriptions: Record<TranscodeResolution, string> = {
    '4k': '4K (3840x2160)',
    '1080p': '1080p (1920x1080)',
    '720p': '720p (1280x720)',
    '480p': '480p (854x480)'
  }
  return descriptions[resolution]
}
