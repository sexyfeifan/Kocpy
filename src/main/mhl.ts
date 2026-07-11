import * as crypto from 'crypto'
import * as fs from 'fs'
import * as path from 'path'

/**
 * ASC MHL (Media Hash List) V1 实现
 * 基于美国电影摄影师协会 (ASC) 开放标准
 */

export interface ASCMHLFile {
  version: '1.0'
  xmlns: 'http://www.aasc.org/mhl/v1.0'
  hashAlgorithm: string
  files: MHLFileEntry[]
  metadata: {
    software: string
    softwareVersion: string
    operator: string
    createdAt: string  // ISO 8601
    notes?: string
  }
}

export interface MHLFileEntry {
  path: string  // 相对路径
  hash: string
  size: number
  modified: string  // ISO 8601
  hashDate: string
}

export type MHLHashAlgorithm = 'md5' | 'sha1' | 'sha256' | 'xxhash64'

/**
 * 计算文件哈希
 */
export async function calculateFileHash(
  filePath: string,
  algorithm: MHLHashAlgorithm
): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash(algorithm === 'xxhash64' ? 'sha256' : algorithm)
    const stream = fs.createReadStream(filePath)

    stream.on('data', (data) => hash.update(data))
    stream.on('end', () => resolve(hash.digest('hex')))
    stream.on('error', reject)
  })
}

/**
 * 获取文件元数据
 */
export async function getFileMetadata(filePath: string): Promise<{
  size: number
  modified: string
}> {
  const stat = await fs.promises.stat(filePath)
  return {
    size: stat.size,
    modified: stat.mtime.toISOString()
  }
}

/**
 * 扫描目录获取所有文件
 */
export async function scanDirectory(dirPath: string): Promise<string[]> {
  const files: string[] = []

  async function scan(currentPath: string) {
    const entries = await fs.promises.readdir(currentPath, { withFileTypes: true })

    for (const entry of entries) {
      const fullPath = path.join(currentPath, entry.name)

      if (entry.isDirectory()) {
        await scan(fullPath)
      } else if (entry.isFile()) {
        files.push(fullPath)
      }
    }
  }

  await scan(dirPath)
  return files
}

/**
 * 生成 ASC MHL 文件
 */
export async function generateMHL(
  sourcePath: string,
  algorithm: MHLHashAlgorithm = 'sha256',
  operator: string = 'Kocpy',
  notes?: string
): Promise<ASCMHLFile> {
  const files = await scanDirectory(sourcePath)
  const mhlFiles: MHLFileEntry[] = []

  console.log(`开始扫描目录: ${sourcePath}`)
  console.log(`找到 ${files.length} 个文件`)

  for (let i = 0; i < files.length; i++) {
    const filePath = files[i]
    const relativePath = path.relative(sourcePath, filePath)

    console.log(`处理文件 ${i + 1}/${files.length}: ${relativePath}`)

    const [hash, metadata] = await Promise.all([
      calculateFileHash(filePath, algorithm),
      getFileMetadata(filePath)
    ])

    mhlFiles.push({
      path: relativePath,
      hash,
      size: metadata.size,
      modified: metadata.modified,
      hashDate: new Date().toISOString()
    })
  }

  return {
    version: '1.0',
    xmlns: 'http://www.aasc.org/mhl/v1.0',
    hashAlgorithm: algorithm,
    files: mhlFiles,
    metadata: {
      software: 'Kocpy',
      softwareVersion: '1.11.0',
      operator,
      createdAt: new Date().toISOString(),
      notes
    }
  }
}

/**
 * 将 MHL 对象转换为 XML 字符串
 */
export function mhlToXML(mhl: ASCMHLFile): string {
  const filesXML = mhl.files.map(file => `
    <file>
      <path>${escapeXML(file.path)}</path>
      <hash>${file.hash}</hash>
      <size>${file.size}</size>
      <modified>${file.modified}</modified>
      <hashDate>${file.hashDate}</hashDate>
    </file>`
  ).join('\n')

  return `<?xml version="1.0" encoding="UTF-8"?>
<hashlist version="${mhl.version}" xmlns="${mhl.xmlns}">
  <software>${escapeXML(mhl.metadata.software)}</software>
  <softwareVersion>${escapeXML(mhl.metadata.softwareVersion)}</softwareVersion>
  <operator>${escapeXML(mhl.metadata.operator)}</operator>
  <created>${mhl.metadata.createdAt}</created>
  ${mhl.metadata.notes ? `<notes>${escapeXML(mhl.metadata.notes)}</notes>` : ''}
  <hashalgorithm>${mhl.hashAlgorithm}</hashalgorithm>
  <files>${filesXML}
  </files>
</hashlist>`
}

/**
 * 将 MHL 对象转换为 JSON 字符串
 */
export function mhlToJSON(mhl: ASCMHLFile): string {
  return JSON.stringify(mhl, null, 2)
}

/**
 * 保存 MHL 文件
 */
export async function saveMHLFile(
  mhl: ASCMHLFile,
  outputPath: string,
  format: 'xml' | 'json' = 'xml'
): Promise<void> {
  const content = format === 'xml' ? mhlToXML(mhl) : mhlToJSON(mhl)
  await fs.promises.writeFile(outputPath, content, 'utf-8')
  console.log(`MHL 文件已保存: ${outputPath}`)
}

/**
 * 读取 MHL 文件
 */
export async function loadMHLFile(filePath: string): Promise<ASCMHLFile> {
  const content = await fs.promises.readFile(filePath, 'utf-8')

  if (filePath.endsWith('.json')) {
    return JSON.parse(content) as ASCMHLFile
  }

  // XML 解析（简化版，实际应使用 XML 解析库）
  // 这里返回一个简化的解析结果
  throw new Error('XML 解析需要完整的 XML 解析器实现')
}

/**
 * 验证 MHL 文件
 */
export interface MHLVerificationResult {
  totalFiles: number
  verifiedFiles: number
  failedFiles: Array<{
    path: string
    expected: string
    actual: string
  }>
  missingFiles: string[]
  passed: boolean
}

export async function verifyMHL(
  mhlPath: string,
  targetPath: string
): Promise<MHLVerificationResult> {
  const mhl = await loadMHLFile(mhlPath)
  const result: MHLVerificationResult = {
    totalFiles: mhl.files.length,
    verifiedFiles: 0,
    failedFiles: [],
    missingFiles: [],
    passed: false
  }

  console.log(`开始验证 MHL: ${mhlPath}`)
  console.log(`目标路径: ${targetPath}`)

  for (let i = 0; i < mhl.files.length; i++) {
    const file = mhl.files[i]
    const filePath = path.join(targetPath, file.path)

    console.log(`验证文件 ${i + 1}/${mhl.files.length}: ${file.path}`)

    try {
      await fs.promises.access(filePath)
    } catch {
      result.missingFiles.push(file.path)
      continue
    }

    const actualHash = await calculateFileHash(filePath, mhl.hashAlgorithm as MHLHashAlgorithm)

    if (actualHash === file.hash) {
      result.verifiedFiles++
    } else {
      result.failedFiles.push({
        path: file.path,
        expected: file.hash,
        actual: actualHash
      })
    }
  }

  result.passed = result.failedFiles.length === 0 && result.missingFiles.length === 0

  console.log(`验证完成:`)
  console.log(`  ✅ 通过: ${result.verifiedFiles}/${result.totalFiles}`)
  console.log(`  ❌ 失败: ${result.failedFiles.length}`)
  console.log(`  ⏭️ 缺失: ${result.missingFiles.length}`)

  return result
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
