export { formatBytes, formatDate, formatDuration } from './report-builder'

import * as path from 'path'

/**
 * 验证路径是否安全（不包含危险路径模式）
 */
export function isValidPath(inputPath: string): boolean {
  if (!inputPath || typeof inputPath !== 'string') {
    return false
  }

  // 规范化路径
  const normalized = path.normalize(inputPath)

  // 检查危险路径模式
  const dangerousPatterns = [
    '..',      // 父目录遍历
    '~/',      // 用户主目录
    '/etc/',   // 系统配置
    '/var/',   // 系统变量
    '/tmp/',   // 临时目录（可能不安全）
    '/proc/',  // 进程信息
    '/sys/',   // 系统信息
  ]

  // 检查是否包含危险模式
  if (dangerousPatterns.some(p => normalized.includes(p))) {
    return false
  }

  // 检查是否以危险字符开头
  const dangerousStarts = ['../', '..\\']
  if (dangerousStarts.some(p => normalized.startsWith(p))) {
    return false
  }

  return true
}

/**
 * 清理文件名中的特殊字符
 */
export function sanitizeFilename(filename: string): string {
  if (!filename || typeof filename !== 'string') {
    return 'untitled'
  }

  // 移除或替换危险字符
  const dangerousChars = /[<>:"/\\|?*\x00-\x1F]/g
  let sanitized = filename.replace(dangerousChars, '_')

  // 移除首尾空格
  sanitized = sanitized.trim()

  // 限制长度
  if (sanitized.length > 255) {
    sanitized = sanitized.substring(0, 255)
  }

  // 如果为空，返回默认名称
  if (!sanitized) {
    return 'untitled'
  }

  return sanitized
}

/**
 * 验证并清理任务名称
 */
export function validateTaskName(name: string): string {
  if (!name || typeof name !== 'string') {
    return 'Untitled'
  }

  // 清理文件名
  const sanitized = sanitizeFilename(name)

  // 如果清理后为空，返回默认名称
  if (!sanitized || sanitized === 'untitled') {
    return 'Untitled'
  }

  return sanitized
}
