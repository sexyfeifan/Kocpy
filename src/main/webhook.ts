import * as https from 'https'
import * as http from 'http'
import { URL } from 'url'

export type WebhookPlatform = 'feishu' | 'dingtalk' | 'wecom' | 'discord' | 'slack'

export function detectPlatform(url: string): WebhookPlatform {
  if (url.includes('open.feishu.cn')) return 'feishu'
  if (url.includes('oapi.dingtalk.com')) return 'dingtalk'
  if (url.includes('qyapi.weixin.qq.com')) return 'wecom'
  if (url.includes('discord.com/api/webhooks')) return 'discord'
  return 'slack'
}

function buildPayload(platform: WebhookPlatform, text: string): object {
  switch (platform) {
    case 'feishu':
      return { msg_type: 'text', content: { text } }
    case 'dingtalk':
    case 'wecom':
      return { msgtype: 'text', text: { content: text } }
    case 'discord':
      return { content: text }
    case 'slack':
    default:
      return { text }
  }
}

export function sendWebhook(webhookUrl: string, text: string, retries = 3): Promise<void> {
  const attempt = async (n: number): Promise<void> => {
    let parsed: URL
    try {
      parsed = new URL(webhookUrl)
    } catch {
      throw new Error('Webhook URL 格式无效')
    }

    const platform = detectPlatform(webhookUrl)
    const payload = buildPayload(platform, text)
    const body = JSON.stringify(payload)

    const options = {
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    }

    return new Promise<void>((resolve, reject) => {
      const lib = parsed.protocol === 'https:' ? https : http
      const req = lib.request(options, (res) => {
        let data = ''
        res.on('data', (chunk) => { data += chunk })
        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            resolve()
          } else {
            reject(new Error(`Webhook 返回状态 ${res.statusCode}: ${data}`))
          }
        })
      })

      req.on('error', reject)
      req.setTimeout(10000, () => {
        req.destroy()
        reject(new Error('Webhook 请求超时'))
      })
      req.write(body)
      req.end()
    }).catch(async (err) => {
      if (n < retries) {
        await new Promise(r => setTimeout(r, 1000 * n))
        return attempt(n + 1)
      }
      throw err
    })
  }
  return attempt(1)
}
