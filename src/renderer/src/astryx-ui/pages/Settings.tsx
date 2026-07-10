import { Card, Button, Switch, TextInput, Badge, Divider, VStack, HStack } from '@astryxdesign/core'
import { useState, useEffect, useRef } from 'react'
import type { HashAlgorithm } from '../../types'
import { t } from '../../locales'

type DuplicateStrategy = 'skip' | 'suffix'

const HASH_OPTIONS: { value: HashAlgorithm; label: string; desc: string }[] = [
  { value: 'md5',    label: 'MD5',    desc: '快速，广泛支持' },
  { value: 'sha1',   label: 'SHA1',   desc: '更安全，稍慢' },
  { value: 'sha256', label: 'SHA256', desc: '最安全，推荐' },
]

interface Props {
  themeMode?: 'dark' | 'light'
  onToggleTheme?: () => void
}

export function Settings({ themeMode, onToggleTheme }: Props): JSX.Element {
  const [defaultHash, setDefaultHash] = useState<HashAlgorithm>('md5')
  const [verifyAfterCopy, setVerifyAfterCopy] = useState(true)
  const [defaultDuplicateStrategy, setDefaultDuplicateStrategy] = useState<DuplicateStrategy>('skip')
  const [saved, setSaved] = useState(false)
  const [appVersion, setAppVersion] = useState('')
  const [webhookUrl, setWebhookUrl] = useState('')
  const [webhookEnabled, setWebhookEnabled] = useState(false)
  const [webhookTestState, setWebhookTestState] = useState<'idle' | 'loading' | 'ok' | 'error'>('idle')
  const [webhookTestMsg, setWebhookTestMsg] = useState('')
  const [updateStatus, setUpdateStatus] = useState<'idle' | 'checking' | 'available' | 'latest' | 'error'>('idle')
  const [updateInfo, setUpdateInfo] = useState<any>({})
  const loaded = useRef(false)

  useEffect(() => {
    window.api.getSettings().then((s) => {
      setDefaultHash(s.defaultHash)
      setVerifyAfterCopy(s.verifyAfterCopy)
      setWebhookUrl(s.webhookUrl ?? '')
      setWebhookEnabled(s.webhookEnabled ?? false)
      if (s.defaultDuplicateStrategy) setDefaultDuplicateStrategy(s.defaultDuplicateStrategy)
      loaded.current = true
    })
    window.api.getAppVersion().then((v) => setAppVersion(v))
  }, [])

  const showSaved = () => { setSaved(true); setTimeout(() => setSaved(false), 1500) }

  const persistHash = async (hash: HashAlgorithm) => {
    if (!loaded.current) return
    setDefaultHash(hash)
    const current = await window.api.getSettings()
    window.api.saveSettings({ ...current, defaultHash: hash })
    showSaved()
  }

  const persistVerify = async (verify: boolean) => {
    if (!loaded.current) return
    setVerifyAfterCopy(verify)
    const current = await window.api.getSettings()
    window.api.saveSettings({ ...current, verifyAfterCopy: verify })
    showSaved()
  }

  const persistDuplicate = async (strategy: DuplicateStrategy) => {
    if (!loaded.current) return
    setDefaultDuplicateStrategy(strategy)
    const current = await window.api.getSettings()
    window.api.saveSettings({ ...current, defaultDuplicateStrategy: strategy })
    showSaved()
  }

  const persistWebhook = async (url: string, enabled: boolean) => {
    if (!loaded.current) return
    setWebhookUrl(url)
    setWebhookEnabled(enabled)
    const current = await window.api.getSettings()
    window.api.saveSettings({ ...current, webhookUrl: url, webhookEnabled: enabled })
  }

  const handleWebhookTest = async () => {
    if (!webhookUrl) return
    setWebhookTestState('loading')
    const result = await window.api.testWebhook(webhookUrl)
    setWebhookTestState(result.ok ? 'ok' : 'error')
    setWebhookTestMsg(result.ok ? '发送成功' : (result.error ?? '未知错误'))
  }

  async function checkForUpdates() {
    setUpdateStatus('checking')
    try {
      const result = await window.api.checkForUpdates()
      if (result.hasUpdate) {
        setUpdateStatus('available')
        setUpdateInfo(result)
      } else {
        setUpdateStatus('latest')
        setTimeout(() => setUpdateStatus('idle'), 3000)
      }
    } catch {
      setUpdateStatus('error')
      setTimeout(() => setUpdateStatus('idle'), 3000)
    }
  }

  return (
    <div style={{ flex: 1, overflow: 'auto', padding: 24, maxWidth: 640, margin: '0 auto', width: '100%' }}>
      <VStack spacing={5}>

        {/* Hash algorithm */}
        <Card padding={5}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
            <span style={{ fontSize: 'var(--font-size-sm)', fontWeight: 'var(--font-weight-semibold)', color: 'var(--color-text-secondary)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
              {t('settings.hash')}
            </span>
            {saved && <Badge label={t('settings.saved')} variant="success" />}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 'var(--spacing-2)' }}>
            {HASH_OPTIONS.map((opt) => (
              <Button
                key={opt.value}
                label={`${opt.label} — ${opt.desc}`}
                variant={defaultHash === opt.value ? 'primary' : 'secondary'}
                onClick={() => persistHash(opt.value)}
              />
            ))}
          </div>
        </Card>

        {/* Copy options */}
        <Card padding={5}>
          <span style={{ fontSize: 'var(--font-size-sm)', fontWeight: 'var(--font-weight-semibold)', color: 'var(--color-text-secondary)', textTransform: 'uppercase', letterSpacing: '0.06em', display: 'block', marginBottom: 16 }}>
            {t('settings.copyOptions')}
          </span>
          <Switch
            label={t('settings.verifyAfterCopy')}
            description={t('settings.verifyAfterCopyDesc')}
            value={verifyAfterCopy}
            onChange={persistVerify}
          />
          <div style={{ marginTop: 'var(--spacing-3)' }}>
            <span style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)', marginBottom: 8, display: 'block' }}>{t('settings.duplicateStrategy')}</span>
            <HStack spacing={2}>
              <Button label={t('settings.skip')} variant={defaultDuplicateStrategy === 'skip' ? 'primary' : 'secondary'} size="sm" onClick={() => persistDuplicate('skip')} />
              <Button label={t('settings.rename')} variant={defaultDuplicateStrategy === 'suffix' ? 'primary' : 'secondary'} size="sm" onClick={() => persistDuplicate('suffix')} />
            </HStack>
          </div>
        </Card>

        {/* Webhook */}
        <Card padding={5}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
            <span style={{ fontSize: 'var(--font-size-sm)', fontWeight: 'var(--font-weight-semibold)', color: 'var(--color-text-secondary)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
              {t('settings.webhook')}
            </span>
            <Switch label="" isLabelHidden value={webhookEnabled} onChange={(v) => persistWebhook(webhookUrl, v)} />
          </div>
          <VStack spacing={3}>
            <TextInput
              label="Webhook URL"
              isLabelHidden
              value={webhookUrl}
              onChange={(v) => persistWebhook(v, webhookEnabled)}
              placeholder="https://open.feishu.cn/open-apis/bot/v2/hook/..."
            />
            <HStack spacing={3}>
              <Button label={webhookTestState === 'loading' ? '发送中...' : '测试'} variant="secondary" size="sm" isDisabled={!webhookUrl || webhookTestState === 'loading'} onClick={handleWebhookTest} />
              {webhookTestState === 'ok' && <span style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-success)' }}>{webhookTestMsg}</span>}
              {webhookTestState === 'error' && <span style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-error)' }}>{webhookTestMsg}</span>}
            </HStack>
            <p style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-disabled)' }}>备份完成后自动推送通知，支持飞书 / 钉钉 / 企业微信 / Discord / Slack</p>
          </VStack>
        </Card>

        {/* Update */}
        <Card padding={5}>
          <span style={{ fontSize: 'var(--font-size-sm)', fontWeight: 'var(--font-weight-semibold)', color: 'var(--color-text-secondary)', textTransform: 'uppercase', letterSpacing: '0.06em', display: 'block', marginBottom: 16 }}>
            {t('settings.checkUpdate')}
          </span>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <HStack spacing={2}>
              <span style={{ fontSize: 'var(--font-size-base)', color: 'var(--color-text-secondary)' }}>{t('settings.currentVersion')}</span>
              <span style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-disabled)', fontFamily: 'var(--font-family-code)' }}>{appVersion ? `v${appVersion}` : '…'}</span>
            </HStack>
            <Button
              label={updateStatus === 'checking' ? '检查中…' : t('settings.checkUpdate')}
              variant="secondary"
              size="sm"
              isLoading={updateStatus === 'checking'}
              onClick={checkForUpdates}
            />
          </div>
          {updateStatus === 'latest' && <Badge label="已是最新版本" variant="success" />}
          {updateStatus === 'error' && <span style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-error)' }}>检查更新失败</span>}
          {updateStatus === 'available' && updateInfo.latestVersion && (
            <div style={{ marginTop: 'var(--spacing-3)' }}>
              <Badge label={`发现新版本 v${updateInfo.latestVersion}`} variant="info" />
              {updateInfo.releaseUrl && (
                <Button label="GitHub" variant="ghost" size="sm" onClick={() => window.open(updateInfo.releaseUrl)} />
              )}
            </div>
          )}
        </Card>

        {/* Logs */}
        <Card padding={5}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span style={{ fontSize: 'var(--font-size-sm)', fontWeight: 'var(--font-weight-semibold)', color: 'var(--color-text-secondary)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
              {t('settings.logs')}
            </span>
            <Button label={t('settings.openLogs')} variant="secondary" size="sm" onClick={() => window.api.openLogsFolder()} />
          </div>
          <p style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-disabled)', marginTop: 8 }}>备份操作日志，自动保留最近 7 天</p>
        </Card>

        {/* About */}
        <Card padding={5}>
          <span style={{ fontSize: 'var(--font-size-sm)', fontWeight: 'var(--font-weight-semibold)', color: 'var(--color-text-secondary)', textTransform: 'uppercase', letterSpacing: '0.06em', display: 'block', marginBottom: 16 }}>
            {t('settings.about')}
          </span>
          <VStack spacing={2}>
            <InfoRow label="版本" value={appVersion ? `v${appVersion}` : '…'} />
            <InfoRow label="引擎" value="Electron + React + Astryx" />
            <InfoRow label="校验标准" value="MD5 / SHA1 / SHA256" />
            <Divider />
            <InfoRow label="作者" value="@我是性感的非凡" />
            <InfoRow label="联系" value="zhoufeifan@gmail.com" />
          </VStack>
        </Card>

      </VStack>
    </div>
  )
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 'var(--font-size-base)' }}>
      <span style={{ color: 'var(--color-text-disabled)' }}>{label}</span>
      <span style={{ color: 'var(--color-text-secondary)', fontFamily: 'var(--font-family-code)', fontSize: 'var(--font-size-sm)' }}>{value}</span>
    </div>
  )
}
