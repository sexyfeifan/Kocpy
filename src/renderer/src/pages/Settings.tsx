import { useState, useEffect } from 'react'
import {
  Settings as SettingsIcon, Hash, FileVideo, Palette, HardDrive,
  Database, Film, Shield, Webhook, Save, RefreshCw, Check, X, Plus, Trash2
} from 'lucide-react'

interface SettingsProps {
  // 可以添加 props
}

export function Settings(): JSX.Element {
  const [activeTab, setActiveTab] = useState('general')
  const [saved, setSaved] = useState(false)

  // 通用设置
  const [defaultHash, setDefaultHash] = useState('md5')
  const [verifyAfterCopy, setVerifyAfterCopy] = useState(true)
  const [autoBackup, setAutoBackup] = useState(false)

  // ASC MHL 设置
  const [mhlEnabled, setMhlEnabled] = useState(false)
  const [mhlAlgorithm, setMhlAlgorithm] = useState('sha256')
  const [mhlAutoVerify, setMhlAutoVerify] = useState(true)

  // 转码设置
  const [transcodeFormat, setTranscodeFormat] = useState('h264')
  const [transcodeResolution, setTranscodeResolution] = useState('1080p')
  const [transcodeQuality, setTranscodeQuality] = useState('medium')
  const [applyLUT, setApplyLUT] = useState(false)
  const [selectedLUT, setSelectedLUT] = useState('')

  // NAS 设置
  const [nasAutoScan, setNasAutoScan] = useState(true)
  const [nasSyncInterval, setNasSyncInterval] = useState(30)
  const [nasHealthCheck, setNasHealthCheck] = useState(true)

  // Webhook 设置
  const [webhookUrl, setWebhookUrl] = useState('')
  const [webhookEnabled, setWebhookEnabled] = useState(false)
  const [webhookEvents, setWebhookEvents] = useState(['completed', 'failed'])

  // DaVinci Resolve 设置
  const [resolveExportFormat, setResolveExportFormat] = useState('ale')
  const [resolveAutoProject, setResolveAutoProject] = useState(false)

  useEffect(() => {
    // 加载设置
    loadSettings()
  }, [])

  const loadSettings = async () => {
    try {
      const settings = await window.api.getSettings()
      if (settings) {
        setDefaultHash(settings.defaultHash || 'md5')
        setVerifyAfterCopy(settings.verifyAfterCopy ?? true)
        setWebhookUrl(settings.webhookUrl || '')
        setWebhookEnabled(settings.webhookEnabled ?? false)
      }
    } catch (err) {
      console.error('Failed to load settings:', err)
    }
  }

  const handleSave = async () => {
    try {
      await window.api.saveSettings({
        defaultHash: defaultHash as any,
        verifyAfterCopy,
        webhookUrl,
        webhookEnabled,
        devices: []
      })
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    } catch (err) {
      console.error('Failed to save settings:', err)
    }
  }

  const tabs = [
    { id: 'general', label: '通用设置', icon: SettingsIcon },
    { id: 'mhl', label: 'ASC MHL', icon: Shield },
    { id: 'transcode', label: '转码设置', icon: FileVideo },
    { id: 'lut', label: 'LUT/CDL', icon: Palette },
    { id: 'nas', label: 'NAS 管理', icon: HardDrive },
    { id: 'resolve', label: 'DaVinci', icon: Film },
    { id: 'webhook', label: 'Webhook', icon: Webhook }
  ]

  return (
    <div className="flex h-full bg-[#0a0a0a]">
      {/* 侧边栏 */}
      <div className="w-48 border-r border-[#2a2a2a] p-4">
        <h2 className="text-sm font-semibold text-gray-200 mb-4">设置</h2>
        <nav className="space-y-1">
          {tabs.map((tab) => {
            const Icon = tab.icon
            return (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm transition-colors ${
                  activeTab === tab.id
                    ? 'bg-blue-600 text-white'
                    : 'text-gray-400 hover:text-gray-200 hover:bg-[#111]'
                }`}
              >
                <Icon size={16} />
                {tab.label}
              </button>
            )
          })}
        </nav>
      </div>

      {/* 内容区域 */}
      <div className="flex-1 overflow-auto p-6">
        <div className="max-w-2xl">
          {/* 保存按钮 */}
          <div className="flex items-center justify-between mb-6">
            <h1 className="text-lg font-semibold text-gray-200">
              {tabs.find(t => t.id === activeTab)?.label}
            </h1>
            <button
              onClick={handleSave}
              className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-500 transition-colors"
            >
              {saved ? <Check size={16} /> : <Save size={16} />}
              {saved ? '已保存' : '保存设置'}
            </button>
          </div>

          {/* 通用设置 */}
          {activeTab === 'general' && (
            <div className="space-y-6">
              <div className="glass-card p-4">
                <h3 className="text-sm font-semibold text-gray-200 mb-4">备份设置</h3>
                <div className="space-y-4">
                  <div>
                    <label className="block text-xs text-gray-500 mb-2">默认哈希算法</label>
                    <select
                      value={defaultHash}
                      onChange={(e) => setDefaultHash(e.target.value)}
                      className="w-full px-3 py-2 bg-[#111] border border-[#2a2a2a] rounded-lg text-sm text-gray-200"
                    >
                      <option value="md5">MD5 (快速)</option>
                      <option value="sha1">SHA-1 (常用)</option>
                      <option value="sha256">SHA-256 (安全)</option>
                      <option value="xxhash64">xxHash64 (极速)</option>
                      <option value="xxhash3-64">xxHash3-64 (最新)</option>
                    </select>
                  </div>

                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-sm text-gray-200">备份后自动校验</p>
                      <p className="text-xs text-gray-500">备份完成后自动验证文件完整性</p>
                    </div>
                    <button
                      onClick={() => setVerifyAfterCopy(!verifyAfterCopy)}
                      className={`w-12 h-6 rounded-full transition-colors ${
                        verifyAfterCopy ? 'bg-blue-600' : 'bg-gray-600'
                      }`}
                    >
                      <div className={`w-5 h-5 bg-white rounded-full transition-transform ${
                        verifyAfterCopy ? 'translate-x-6' : 'translate-x-1'
                      }`} />
                    </button>
                  </div>

                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-sm text-gray-200">自动备份</p>
                      <p className="text-xs text-gray-500">插入摄影机卡时自动开始备份</p>
                    </div>
                    <button
                      onClick={() => setAutoBackup(!autoBackup)}
                      className={`w-12 h-6 rounded-full transition-colors ${
                        autoBackup ? 'bg-blue-600' : 'bg-gray-600'
                      }`}
                    >
                      <div className={`w-5 h-5 bg-white rounded-full transition-transform ${
                        autoBackup ? 'translate-x-6' : 'translate-x-1'
                      }`} />
                    </button>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* ASC MHL 设置 */}
          {activeTab === 'mhl' && (
            <div className="space-y-6">
              <div className="glass-card p-4">
                <h3 className="text-sm font-semibold text-gray-200 mb-4">ASC MHL 配置</h3>
                <p className="text-xs text-gray-500 mb-4">
                  ASC MHL (Media Hash List) 是行业标准，用于记录和验证媒体文件的完整性。
                  Netflix 等平台要求使用 ASC MHL。
                </p>
                <div className="space-y-4">
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-sm text-gray-200">启用 ASC MHL</p>
                      <p className="text-xs text-gray-500">备份时自动生成 MHL 文件</p>
                    </div>
                    <button
                      onClick={() => setMhlEnabled(!mhlEnabled)}
                      className={`w-12 h-6 rounded-full transition-colors ${
                        mhlEnabled ? 'bg-blue-600' : 'bg-gray-600'
                      }`}
                    >
                      <div className={`w-5 h-5 bg-white rounded-full transition-transform ${
                        mhlEnabled ? 'translate-x-6' : 'translate-x-1'
                      }`} />
                    </button>
                  </div>

                  {mhlEnabled && (
                    <>
                      <div>
                        <label className="block text-xs text-gray-500 mb-2">MHL 哈希算法</label>
                        <select
                          value={mhlAlgorithm}
                          onChange={(e) => setMhlAlgorithm(e.target.value)}
                          className="w-full px-3 py-2 bg-[#111] border border-[#2a2a2a] rounded-lg text-sm text-gray-200"
                        >
                          <option value="md5">MD5</option>
                          <option value="sha1">SHA-1</option>
                          <option value="sha256">SHA-256 (推荐)</option>
                        </select>
                      </div>

                      <div className="flex items-center justify-between">
                        <div>
                          <p className="text-sm text-gray-200">自动验证 MHL</p>
                          <p className="text-xs text-gray-500">备份完成后自动验证 MHL 文件</p>
                        </div>
                        <button
                          onClick={() => setMhlAutoVerify(!mhlAutoVerify)}
                          className={`w-12 h-6 rounded-full transition-colors ${
                            mhlAutoVerify ? 'bg-blue-600' : 'bg-gray-600'
                          }`}
                        >
                          <div className={`w-5 h-5 bg-white rounded-full transition-transform ${
                            mhlAutoVerify ? 'translate-x-6' : 'translate-x-1'
                          }`} />
                        </button>
                      </div>
                    </>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* 转码设置 */}
          {activeTab === 'transcode' && (
            <div className="space-y-6">
              <div className="glass-card p-4">
                <h3 className="text-sm font-semibold text-gray-200 mb-4">转码配置</h3>
                <div className="space-y-4">
                  <div>
                    <label className="block text-xs text-gray-500 mb-2">输出格式</label>
                    <select
                      value={transcodeFormat}
                      onChange={(e) => setTranscodeFormat(e.target.value)}
                      className="w-full px-3 py-2 bg-[#111] border border-[#2a2a2a] rounded-lg text-sm text-gray-200"
                    >
                      <option value="prores">Apple ProRes (高质量)</option>
                      <option value="h264">H.264/AVC (兼容性好)</option>
                      <option value="h265">H.265/HEVC (压缩率高)</option>
                    </select>
                  </div>

                  <div>
                    <label className="block text-xs text-gray-500 mb-2">分辨率</label>
                    <select
                      value={transcodeResolution}
                      onChange={(e) => setTranscodeResolution(e.target.value)}
                      className="w-full px-3 py-2 bg-[#111] border border-[#2a2a2a] rounded-lg text-sm text-gray-200"
                    >
                      <option value="4k">4K (3840x2160)</option>
                      <option value="1080p">1080p (1920x1080)</option>
                      <option value="720p">720p (1280x720)</option>
                      <option value="480p">480p (854x480)</option>
                    </select>
                  </div>

                  <div>
                    <label className="block text-xs text-gray-500 mb-2">质量</label>
                    <select
                      value={transcodeQuality}
                      onChange={(e) => setTranscodeQuality(e.target.value)}
                      className="w-full px-3 py-2 bg-[#111] border border-[#2a2a2a] rounded-lg text-sm text-gray-200"
                    >
                      <option value="low">低质量 (文件小)</option>
                      <option value="medium">中等质量 (平衡)</option>
                      <option value="high">高质量 (文件大)</option>
                    </select>
                  </div>

                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-sm text-gray-200">应用 LUT</p>
                      <p className="text-xs text-gray-500">转码时应用 LUT 文件</p>
                    </div>
                    <button
                      onClick={() => setApplyLUT(!applyLUT)}
                      className={`w-12 h-6 rounded-full transition-colors ${
                        applyLUT ? 'bg-blue-600' : 'bg-gray-600'
                      }`}
                    >
                      <div className={`w-5 h-5 bg-white rounded-full transition-transform ${
                        applyLUT ? 'translate-x-6' : 'translate-x-1'
                      }`} />
                    </button>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* LUT/CDL 设置 */}
          {activeTab === 'lut' && (
            <div className="space-y-6">
              <div className="glass-card p-4">
                <h3 className="text-sm font-semibold text-gray-200 mb-4">LUT/CDL 管理</h3>
                <p className="text-xs text-gray-500 mb-4">
                  管理 LUT (Look-Up Table) 和 CDL (Color Decision List) 文件
                </p>
                <div className="space-y-4">
                  <div>
                    <label className="block text-xs text-gray-500 mb-2">已导入的 LUT</label>
                    <div className="flex items-center gap-2">
                      <input
                        type="text"
                        value={selectedLUT}
                        onChange={(e) => setSelectedLUT(e.target.value)}
                        placeholder="选择 LUT 文件..."
                        className="flex-1 px-3 py-2 bg-[#111] border border-[#2a2a2a] rounded-lg text-sm text-gray-200"
                      />
                      <button className="px-3 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-500">
                        导入
                      </button>
                    </div>
                  </div>

                  <div className="p-3 bg-[#111] border border-[#2a2a2a] rounded-lg">
                    <p className="text-xs text-gray-500">暂无已导入的 LUT 文件</p>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* NAS 设置 */}
          {activeTab === 'nas' && (
            <div className="space-y-6">
              <div className="glass-card p-4">
                <h3 className="text-sm font-semibold text-gray-200 mb-4">NAS 管理</h3>
                <div className="space-y-4">
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-sm text-gray-200">自动扫描 NAS</p>
                      <p className="text-xs text-gray-500">启动时自动扫描局域网 NAS 设备</p>
                    </div>
                    <button
                      onClick={() => setNasAutoScan(!nasAutoScan)}
                      className={`w-12 h-6 rounded-full transition-colors ${
                        nasAutoScan ? 'bg-blue-600' : 'bg-gray-600'
                      }`}
                    >
                      <div className={`w-5 h-5 bg-white rounded-full transition-transform ${
                        nasAutoScan ? 'translate-x-6' : 'translate-x-1'
                      }`} />
                    </button>
                  </div>

                  <div>
                    <label className="block text-xs text-gray-500 mb-2">同步间隔（分钟）</label>
                    <input
                      type="number"
                      value={nasSyncInterval}
                      onChange={(e) => setNasSyncInterval(parseInt(e.target.value))}
                      min="5"
                      max="1440"
                      className="w-full px-3 py-2 bg-[#111] border border-[#2a2a2a] rounded-lg text-sm text-gray-200"
                    />
                  </div>

                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-sm text-gray-200">健康监控</p>
                      <p className="text-xs text-gray-500">监控 NAS 的 SMART、容量和 RAID 状态</p>
                    </div>
                    <button
                      onClick={() => setNasHealthCheck(!nasHealthCheck)}
                      className={`w-12 h-6 rounded-full transition-colors ${
                        nasHealthCheck ? 'bg-blue-600' : 'bg-gray-600'
                      }`}
                    >
                      <div className={`w-5 h-5 bg-white rounded-full transition-transform ${
                        nasHealthCheck ? 'translate-x-6' : 'translate-x-1'
                      }`} />
                    </button>
                  </div>

                  <button className="w-full flex items-center justify-center gap-2 px-4 py-2 bg-[#111] border border-[#2a2a2a] rounded-lg text-sm text-gray-400 hover:text-gray-200">
                    <RefreshCw size={14} />
                    扫描 NAS 设备
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* DaVinci Resolve 设置 */}
          {activeTab === 'resolve' && (
            <div className="space-y-6">
              <div className="glass-card p-4">
                <h3 className="text-sm font-semibold text-gray-200 mb-4">DaVinci Resolve 集成</h3>
                <div className="space-y-4">
                  <div>
                    <label className="block text-xs text-gray-500 mb-2">默认导出格式</label>
                    <select
                      value={resolveExportFormat}
                      onChange={(e) => setResolveExportFormat(e.target.value)}
                      className="w-full px-3 py-2 bg-[#111] border border-[#2a2a2a] rounded-lg text-sm text-gray-200"
                    >
                      <option value="ale">ALE (Avid Log Exchange)</option>
                      <option value="xml">FCP XML (Final Cut Pro)</option>
                      <option value="edl">EDL (Edit Decision List)</option>
                      <option value="cdl">CDL (Color Decision List)</option>
                    </select>
                  </div>

                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-sm text-gray-200">自动创建项目</p>
                      <p className="text-xs text-gray-500">导出时自动创建 DaVinci Resolve 项目结构</p>
                    </div>
                    <button
                      onClick={() => setResolveAutoProject(!resolveAutoProject)}
                      className={`w-12 h-6 rounded-full transition-colors ${
                        resolveAutoProject ? 'bg-blue-600' : 'bg-gray-600'
                      }`}
                    >
                      <div className={`w-5 h-5 bg-white rounded-full transition-transform ${
                        resolveAutoProject ? 'translate-x-6' : 'translate-x-1'
                      }`} />
                    </button>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Webhook 设置 */}
          {activeTab === 'webhook' && (
            <div className="space-y-6">
              <div className="glass-card p-4">
                <h3 className="text-sm font-semibold text-gray-200 mb-4">Webhook 通知</h3>
                <div className="space-y-4">
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-sm text-gray-200">启用 Webhook</p>
                      <p className="text-xs text-gray-500">备份事件推送到钉钉/飞书/企微</p>
                    </div>
                    <button
                      onClick={() => setWebhookEnabled(!webhookEnabled)}
                      className={`w-12 h-6 rounded-full transition-colors ${
                        webhookEnabled ? 'bg-blue-600' : 'bg-gray-600'
                      }`}
                    >
                      <div className={`w-5 h-5 bg-white rounded-full transition-transform ${
                        webhookEnabled ? 'translate-x-6' : 'translate-x-1'
                      }`} />
                    </button>
                  </div>

                  {webhookEnabled && (
                    <div>
                      <label className="block text-xs text-gray-500 mb-2">Webhook URL</label>
                      <input
                        type="text"
                        value={webhookUrl}
                        onChange={(e) => setWebhookUrl(e.target.value)}
                        placeholder="https://..."
                        className="w-full px-3 py-2 bg-[#111] border border-[#2a2a2a] rounded-lg text-sm text-gray-200"
                      />
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
