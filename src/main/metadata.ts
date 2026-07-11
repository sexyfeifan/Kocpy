import * as path from 'path'
import * as fs from 'fs'

/**
 * 媒体元数据提取模块
 * 支持主流摄影机格式的元数据提取
 */

export interface MediaMetadata {
  // 基础信息
  fileName: string
  filePath: string
  fileSize: number
  fileType: string
  mimeType: string

  // 视频信息
  duration?: number  // 秒
  frameRate?: number
  resolution?: {
    width: number
    height: number
  }
  aspectRatio?: string
  codec?: string
  bitrate?: number

  // 摄影机信息
  camera?: {
    manufacturer: string
    model: string
    serialNumber?: string
    firmware?: string
  }

  // 拍摄参数
  exposure?: {
    iso?: number
    shutter?: string
    aperture?: string
    whiteBalance?: number
    exposureTime?: string
  }

  // 时间码
  timecode?: {
    record?: string
    camera?: string
    userBits?: string
  }

  // 镜头信息
  lens?: {
    model?: string
    focalLength?: number
    maxAperture?: number
    serialNumber?: string
  }

  // 色彩信息
  color?: {
    colorSpace?: string
    colorProfile?: string
    bitDepth?: number
  }

  // GPS信息
  gps?: {
    latitude?: number
    longitude?: number
    altitude?: number
  }

  // 其他元数据
  metadata: Record<string, any>
}

/**
 * 元数据提取器接口
 */
export interface MetadataExtractor {
  canHandle(filePath: string): boolean
  extract(filePath: string): Promise<MediaMetadata>
}

/**
 * 通用元数据提取器（基于 ExifTool）
 */
export class ExifToolExtractor implements MetadataExtractor {
  private exiftool: any

  constructor() {
    this.initExifTool()
  }

  private async initExifTool() {
    try {
      const { exiftool } = await import('exiftool-vendored')
      this.exiftool = exiftool
    } catch (err) {
      console.warn('ExifTool not available:', err)
    }
  }

  canHandle(filePath: string): boolean {
    const ext = path.extname(filePath).toLowerCase()
    const supportedExtensions = [
      '.mp4', '.mov', '.mxf', '.avi', '.mkv',
      '.jpg', '.jpeg', '.png', '.tiff', '.tif',
      '.raw', '.cr2', '.nef', '.arw', '.dng',
      '.r3d', '.braw'
    ]
    return supportedExtensions.includes(ext)
  }

  async extract(filePath: string): Promise<MediaMetadata> {
    if (!this.exiftool) {
      throw new Error('ExifTool not initialized')
    }

    try {
      const tags = await this.exiftool.read(filePath)

      return this.parseExifToolTags(filePath, tags)
    } catch (err) {
      console.error(`Failed to extract metadata from ${filePath}:`, err)
      throw err
    }
  }

  private parseExifToolTags(filePath: string, tags: any): MediaMetadata {
    const stat = fs.statSync(filePath)

    return {
      fileName: path.basename(filePath),
      filePath,
      fileSize: stat.size,
      fileType: tags.FileType || 'Unknown',
      mimeType: tags.MIMEType || 'application/octet-stream',

      // 视频信息
      duration: tags.Duration ? parseFloat(tags.Duration) : undefined,
      frameRate: tags.VideoFrameRate ? parseFloat(tags.VideoFrameRate) : undefined,
      resolution: tags.ImageWidth && tags.ImageHeight ? {
        width: tags.ImageWidth,
        height: tags.ImageHeight
      } : undefined,
      aspectRatio: tags.AspectRatio,
      codec: tags.VideoCodec || tags.CompressorName,
      bitrate: tags.VideoBitrate ? parseInt(tags.VideoBitrate) : undefined,

      // 摄影机信息
      camera: {
        manufacturer: tags.Make || 'Unknown',
        model: tags.Model || 'Unknown',
        serialNumber: tags.SerialNumber || tags.CameraSerialNumber,
        firmware: tags.Firmware || tags.FirmwareVersion
      },

      // 拍摄参数
      exposure: {
        iso: tags.ISO ? parseInt(tags.ISO) : undefined,
        shutter: tags.ShutterSpeed || tags.ExposureTime,
        aperture: tags.Aperture || tags.FNumber,
        whiteBalance: tags.WhiteBalance ? parseInt(tags.WhiteBalance) : undefined,
        exposureTime: tags.ExposureTime
      },

      // 时间码
      timecode: {
        record: tags.TimeCode || tags.Timecode,
        camera: tags.CameraTimecode,
        userBits: tags.UserBits
      },

      // 镜头信息
      lens: {
        model: tags.LensModel || tags.Lens,
        focalLength: tags.FocalLength ? parseFloat(tags.FocalLength) : undefined,
        maxAperture: tags.MaxApertureValue ? parseFloat(tags.MaxApertureValue) : undefined,
        serialNumber: tags.LensSerialNumber
      },

      // 色彩信息
      color: {
        colorSpace: tags.ColorSpace,
        colorProfile: tags.ColorProfile || tags.ICCProfile,
        bitDepth: tags.BitDepth ? parseInt(tags.BitDepth) : undefined
      },

      // GPS信息
      gps: tags.GPSLatitude && tags.GPSLongitude ? {
        latitude: parseFloat(tags.GPSLatitude),
        longitude: parseFloat(tags.GPSLongitude),
        altitude: tags.GPSAltitude ? parseFloat(tags.GPSAltitude) : undefined
      } : undefined,

      // 其他元数据
      metadata: tags
    }
  }
}

/**
 * ARRI 摄影机元数据提取器
 */
export class ARRIExtractor implements MetadataExtractor {
  canHandle(filePath: string): boolean {
    const ext = path.extname(filePath).toLowerCase()
    return ext === '.ari' || ext === '.mov' || ext === '.mxf'
  }

  async extract(filePath: string): Promise<MediaMetadata> {
    // 使用 ExifTool 提取 ARRI 特定元数据
    const extractor = new ExifToolExtractor()
    const metadata = await extractor.extract(filePath)

    // ARRI 特定字段映射
    if (metadata.metadata.ARRI) {
      metadata.camera = {
        manufacturer: 'ARRI',
        model: metadata.metadata.ARRI.Model || metadata.camera?.model || 'Unknown',
        serialNumber: metadata.metadata.ARRI.SerialNumber || metadata.camera?.serialNumber,
        firmware: metadata.metadata.ARRI.Firmware || metadata.camera?.firmware
      }
    }

    return metadata
  }
}

/**
 * RED 摄影机元数据提取器
 */
export class REDExtractor implements MetadataExtractor {
  canHandle(filePath: string): boolean {
    const ext = path.extname(filePath).toLowerCase()
    return ext === '.r3d'
  }

  async extract(filePath: string): Promise<MediaMetadata> {
    const extractor = new ExifToolExtractor()
    const metadata = await extractor.extract(filePath)

    // RED 特定字段映射
    if (metadata.metadata.RED) {
      metadata.camera = {
        manufacturer: 'RED',
        model: metadata.metadata.RED.Model || metadata.camera?.model || 'Unknown',
        serialNumber: metadata.metadata.RED.SerialNumber || metadata.camera?.serialNumber,
        firmware: metadata.metadata.RED.Firmware || metadata.camera?.firmware
      }
    }

    return metadata
  }
}

/**
 * Sony 摄影机元数据提取器
 */
export class SonyExtractor implements MetadataExtractor {
  canHandle(filePath: string): boolean {
    const ext = path.extname(filePath).toLowerCase()
    return ext === '.mp4' || ext === '.mxf' || ext === '.mov'
  }

  async extract(filePath: string): Promise<MediaMetadata> {
    const extractor = new ExifToolExtractor()
    const metadata = await extractor.extract(filePath)

    // Sony 特定字段映射
    if (metadata.metadata.Sony) {
      metadata.camera = {
        manufacturer: 'Sony',
        model: metadata.metadata.Sony.Model || metadata.camera?.model || 'Unknown',
        serialNumber: metadata.metadata.Sony.SerialNumber || metadata.camera?.serialNumber,
        firmware: metadata.metadata.Sony.Firmware || metadata.camera?.firmware
      }
    }

    return metadata
  }
}

/**
 * Blackmagic 摄影机元数据提取器
 */
export class BlackmagicExtractor implements MetadataExtractor {
  canHandle(filePath: string): boolean {
    const ext = path.extname(filePath).toLowerCase()
    return ext === '.braw'
  }

  async extract(filePath: string): Promise<MediaMetadata> {
    const extractor = new ExifToolExtractor()
    const metadata = await extractor.extract(filePath)

    // Blackmagic 特定字段映射
    if (metadata.metadata.Blackmagic) {
      metadata.camera = {
        manufacturer: 'Blackmagic',
        model: metadata.metadata.Blackmagic.Model || metadata.camera?.model || 'Unknown',
        serialNumber: metadata.metadata.Blackmagic.SerialNumber || metadata.camera?.serialNumber,
        firmware: metadata.metadata.Blackmagic.Firmware || metadata.camera?.firmware
      }
    }

    return metadata
  }
}

/**
 * 元数据提取管理器
 */
export class MetadataManager {
  private extractors: MetadataExtractor[] = []

  constructor() {
    // 注册提取器（按优先级排序）
    this.extractors = [
      new ARRIExtractor(),
      new REDExtractor(),
      new BlackmagicExtractor(),
      new SonyExtractor(),
      new ExifToolExtractor()  // 通用提取器作为后备
    ]
  }

  /**
   * 提取文件元数据
   */
  async extractMetadata(filePath: string): Promise<MediaMetadata> {
    for (const extractor of this.extractors) {
      if (extractor.canHandle(filePath)) {
        try {
          return await extractor.extract(filePath)
        } catch (err) {
          console.warn(`Extractor failed for ${filePath}:`, err)
          continue
        }
      }
    }

    throw new Error(`No suitable extractor found for ${filePath}`)
  }

  /**
   * 批量提取元数据
   */
  async extractMetadataBatch(filePaths: string[]): Promise<Map<string, MediaMetadata>> {
    const results = new Map<string, MediaMetadata>()

    for (const filePath of filePaths) {
      try {
        const metadata = await this.extractMetadata(filePath)
        results.set(filePath, metadata)
      } catch (err) {
        console.error(`Failed to extract metadata from ${filePath}:`, err)
      }
    }

    return results
  }

  /**
   * 获取支持的格式列表
   */
  getSupportedFormats(): string[] {
    return [
      '.mp4', '.mov', '.mxf', '.avi', '.mkv',
      '.jpg', '.jpeg', '.png', '.tiff', '.tif',
      '.raw', '.cr2', '.nef', '.arw', '.dng',
      '.r3d', '.braw', '.ari'
    ]
  }
}

// 导出单例
export const metadataManager = new MetadataManager()
