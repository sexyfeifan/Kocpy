import * as fs from 'fs'
import * as path from 'path'
import { logInfo, logError } from './logger'

/**
 * LUT/CDL 管理模块
 * 支持 LUT 导入、预览、应用，CDL 管理
 */

export interface LUT {
  id: string
  name: string
  format: 'cube' | '3dl' | 'csp'
  size: number  // 3D LUT 尺寸 (如 17x17x17)
  filePath: string
  tags: string[]
  createdAt: string
}

export interface CDL {
  id: string
  name: string
  slope: [number, number, number]  // RGB
  offset: [number, number, number]
  power: [number, number, number]
  saturation: number
  createdAt: string
}

export interface LUTPreview {
  lut: LUT
  previewPath: string  // 预览图路径
}

/**
 * LUT/CDL 管理器
 */
export class LUTManager {
  private lutDir: string
  private cdlDir: string

  constructor(dataDir: string) {
    this.lutDir = path.join(dataDir, 'luts')
    this.cdlDir = path.join(dataDir, 'cdls')
    this.ensureDirectories()
  }

  private async ensureDirectories() {
    await fs.promises.mkdir(this.lutDir, { recursive: true })
    await fs.promises.mkdir(this.cdlDir, { recursive: true })
  }

  /**
   * 导入 LUT 文件
   */
  async importLUT(filePath: string, name?: string, tags?: string[]): Promise<LUT> {
    const ext = path.extname(filePath).toLowerCase()
    if (!['.cube', '.3dl', '.csp'].includes(ext)) {
      throw new Error(`Unsupported LUT format: ${ext}`)
    }

    const lutName = name || path.basename(filePath, ext)
    const id = this.generateId()
    const destPath = path.join(this.lutDir, `${id}${ext}`)

    // 复制文件到 LUT 目录
    await fs.promises.copyFile(filePath, destPath)

    // 解析 LUT 尺寸
    const size = await this.parseLUTSize(destPath, ext as any)

    const lut: LUT = {
      id,
      name: lutName,
      format: ext.slice(1) as any,
      size,
      filePath: destPath,
      tags: tags || [],
      createdAt: new Date().toISOString()
    }

    // 保存元数据
    const metaPath = path.join(this.lutDir, `${id}.json`)
    await fs.promises.writeFile(metaPath, JSON.stringify(lut, null, 2))

    logInfo(`LUT imported: ${lutName} (${id})`)
    return lut
  }

  /**
   * 获取所有 LUT
   */
  async getLUTs(): Promise<LUT[]> {
    const files = await fs.promises.readdir(this.lutDir)
    const luts: LUT[] = []

    for (const file of files) {
      if (file.endsWith('.json')) {
        const content = await fs.promises.readFile(path.join(this.lutDir, file), 'utf-8')
        luts.push(JSON.parse(content))
      }
    }

    return luts
  }

  /**
   * 删除 LUT
   */
  async deleteLUT(id: string): Promise<void> {
    const metaPath = path.join(this.lutDir, `${id}.json`)
    const lut = JSON.parse(await fs.promises.readFile(metaPath, 'utf-8'))

    // 删除文件
    await fs.promises.unlink(lut.filePath)
    await fs.promises.unlink(metaPath)

    logInfo(`LUT deleted: ${lut.name} (${id})`)
  }

  /**
   * 创建 CDL
   */
  async createCDL(name: string, slope: [number, number, number], offset: [number, number, number], power: [number, number, number], saturation: number): Promise<CDL> {
    const id = this.generateId()
    const cdl: CDL = {
      id,
      name,
      slope,
      offset,
      power,
      saturation,
      createdAt: new Date().toISOString()
    }

    const filePath = path.join(this.cdlDir, `${id}.json`)
    await fs.promises.writeFile(filePath, JSON.stringify(cdl, null, 2))

    logInfo(`CDL created: ${name} (${id})`)
    return cdl
  }

  /**
   * 获取所有 CDL
   */
  async getCDLs(): Promise<CDL[]> {
    const files = await fs.promises.readdir(this.cdlDir)
    const cdls: CDL[] = []

    for (const file of files) {
      if (file.endsWith('.json')) {
        const content = await fs.promises.readFile(path.join(this.cdlDir, file), 'utf-8')
        cdls.push(JSON.parse(content))
      }
    }

    return cdls
  }

  /**
   * 删除 CDL
   */
  async deleteCDL(id: string): Promise<void> {
    const filePath = path.join(this.cdlDir, `${id}.json`)
    await fs.promises.unlink(filePath)
    logInfo(`CDL deleted: ${id}`)
  }

  /**
   * 导出 CDL 为标准格式
   */
  exportCDLToXML(cdl: CDL): string {
    return `<?xml version="1.0" encoding="UTF-8"?>
<ColorDecisionList version="1.0">
  <ColorDecision>
    <ColorCorrection name="${cdl.name}">
      <SOPNode>
        <Slope>${cdl.slope.join(' ')}</Slope>
        <Offset>${cdl.offset.join(' ')}</Offset>
        <Power>${cdl.power.join(' ')}</Power>
      </SOPNode>
      <SatNode>
        <Saturation>${cdl.saturation}</Saturation>
      </SatNode>
    </ColorCorrection>
  </ColorDecision>
</ColorDecisionList>`
  }

  /**
   * 导出 CDL 为 CCC 格式
   */
  exportCDLToCCC(cdl: CDL): string {
    return `<?xml version="1.0" encoding="UTF-8"?>
<ColorCorrectionCollection version="1.0">
  <ColorCorrection id="${cdl.id}" name="${cdl.name}">
    <SOPNode>
      <Slope>${cdl.slope.join(' ')}</Slope>
      <Offset>${cdl.offset.join(' ')}</Offset>
      <Power>${cdl.power.join(' ')}</Power>
    </SOPNode>
    <SatNode>
      <Saturation>${cdl.saturation}</Saturation>
    </SatNode>
  </ColorCorrection>
</ColorCorrectionCollection>`
  }

  /**
   * 解析 LUT 尺寸
   */
  private async parseLUTSize(filePath: string, format: 'cube' | '3dl' | 'csp'): Promise<number> {
    const content = await fs.promises.readFile(filePath, 'utf-8')
    const lines = content.split('\n')

    for (const line of lines) {
      if (line.startsWith('LUT_3D_SIZE')) {
        return parseInt(line.split(/\s+/)[1])
      }
      if (line.startsWith('3DLUTSIZE')) {
        return parseInt(line.split(/\s+/)[1])
      }
    }

    return 0  // 未知尺寸
  }

  /**
   * 生成唯一ID
   */
  private generateId(): string {
    return Date.now().toString(36) + Math.random().toString(36).substr(2)
  }
}

// 导出单例
export const lutManager = new LUTManager(
  process.env.NODE_ENV === 'development' 
    ? path.join(process.cwd(), 'data')
    : path.join(require('electron').app.getPath('userData'), 'data')
)
