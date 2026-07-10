import { describe, it, expect, vi, beforeEach } from 'vitest'
import { detectPlatform, isValidWebhookUrl, sendWebhook } from '../main/webhook'

describe('Webhook Module', () => {
  describe('detectPlatform', () => {
    it('should detect feishu platform', () => {
      expect(detectPlatform('https://open.feishu.cn/webhook/xxx')).toBe('feishu')
    })

    it('should detect dingtalk platform', () => {
      expect(detectPlatform('https://oapi.dingtalk.com/robot/send')).toBe('dingtalk')
    })

    it('should detect wecom platform', () => {
      expect(detectPlatform('https://qyapi.weixin.qq.com/cgi-bin/webhook/send')).toBe('wecom')
    })

    it('should detect discord platform', () => {
      expect(detectPlatform('https://discord.com/api/webhooks/xxx')).toBe('discord')
    })

    it('should default to slack for unknown platforms', () => {
      expect(detectPlatform('https://hooks.slack.com/services/xxx')).toBe('slack')
    })
  })

  describe('isValidWebhookUrl', () => {
    it('should accept valid https URL', () => {
      expect(isValidWebhookUrl('https://hooks.slack.com/services/xxx')).toBe(true)
    })

    it('should accept valid http URL', () => {
      expect(isValidWebhookUrl('http://example.com/webhook')).toBe(true)
    })

    it('should reject javascript protocol', () => {
      expect(isValidWebhookUrl('javascript:alert(1)')).toBe(false)
    })

    it('should reject data protocol', () => {
      expect(isValidWebhookUrl('data:text/html,<script>alert(1)</script>')).toBe(false)
    })

    it('should reject vbscript protocol', () => {
      expect(isValidWebhookUrl('vbscript:MsgBox("test")')).toBe(false)
    })

    it('should reject invalid URLs', () => {
      expect(isValidWebhookUrl('not-a-url')).toBe(false)
      expect(isValidWebhookUrl('')).toBe(false)
      expect(isValidWebhookUrl('://missing-protocol')).toBe(false)
    })
  })

  describe('sendWebhook', () => {
    it('should reject invalid URLs', async () => {
      await expect(sendWebhook('invalid-url', 'test')).rejects.toThrow('Webhook URL 格式无效或不安全')
    })

    it('should reject dangerous protocols', async () => {
      await expect(sendWebhook('javascript:alert(1)', 'test')).rejects.toThrow('Webhook URL 格式无效或不安全')
    })
  })
})
