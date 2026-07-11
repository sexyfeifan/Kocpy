import { useState, useEffect, useRef } from 'react'
import {
  Settings as SettingsIcon, Hash, FileVideo, Palette, HardDrive,
  Database, Film, Shield, Webhook, Save, RefreshCw, Check, X, Plus, Trash2,
  FolderOpen, Play, Pause, Stop
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
  const [luts, setLuts] = useState<any[]>([])
  const [cdls, setCdls] = useState<any[]>([])

  // NAS 设置
  const [nasAutoScan, setNasAutoScan] = useState(true)
  const [nasSyncInterval, setNasSyncInterval] = useState(30)
  const [nasHealthCheck, setNasHealthCheck] = useState(true)
  const [nasDevices, setNasDevices] = useState<any[]>([])
  const [scanning, setScanning] = useState(false)

  // Webhook 设置
  const [webhookUrl, setWebhookUrl] = useState('')
  const [webhookEnabled, setWebhookEnabled] = useState(false)
  const [webhookEvents, setWebhookEvents] = useState(['completed', 'failed'])

  // DaVinci Resolve 设置
  const [resolveExportFormat, setResolveExportFormat] = useState('ale')
  const [resolveAutoProject, setResolveAutoProject] = useState(false)

  // 媒体生命周期设置
  const [lifecycleEnabled, setLifecycleEnabled] = useState(false)
  const [archivePolicies, setArchivePolicies] = useState<any[]>([])

  // Loading 状态
  const [importingLUT, setImportingLUT] = useState(false)
  const [savingSettings, setSavingSettings] = useState(false)
  const [exportingCDL, setExportingCDL] = useState<string | null>(null)

  useEffect(() => {
    // 加载设置
    loadSettings()
    // 加载LUT列表
    loadLUTs()
    // 加载CDL列表
    loadCDLs()
    // 加载NAS设备
    loadNASDevices()
    // 加载归档策略
    loadArchivePolicies()
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

  const loadLUTs = async () => {
    try {
      const result = await window.api.lutGetAll()
      if (result && Array.isArray(result)) {
        setLuts(result)
      }
    } catch (err) {
      console.error('Failed to load LUTs:', err)
    }
  }

  const loadCDLs = async () => {
    try {
      const result = await window.api.lutGetCDLs()
      if (result && Array.isArray(result)) {
        setCdls(result)
      }
    } catch (err) {
      console.error('Failed to load CDLs:', err)
    }
  }

  const loadNASDevices = async () => {
    try {
      const result = await window.api.nasGetDevices()
      if (result && Array.isArray(result)) {
        setNasDevices(result)
      }
    } catch (err) {
      console.error('Failed to load NAS devices:', err)
    }
  }

  const loadArchivePolicies = async () => {
    try {
      const result = await window.api.lifecycleGetArchivePolicies()
      if (result && Array.isArray(result)) {
        setArchivePolicies(result)
      }
    } catch (err) {
      console.error('Failed to load archive policies:', err)
    }
  }

  const handleSave = async () => {
    setSavingSettings(true)
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
      alert('保存设置失败: ' + (err instanceof Error ? err.message : '未知错误'))
    } finally {
      setSavingSettings(false)
    }
  }

  const handleImportLUT = async () => {
    setImportingLUT(true)
    try {
      const filePath = await window.api.selectDirectory()
      if (filePath) {
        const result = await window.api.lutImport(filePath, selectedLUT || undefined)
        if (result && result.success) {
          await loadLUTs()
          setSelectedLUT('')
          alert('LUT 导入成功')
        } else {
          alert('LUT 导入失败: ' + (result?.error || '未知错误'))
        }
      }
    } catch (err) {
      console.error('Failed to import LUT:', err)
      alert('LUT 导入失败: ' + (err instanceof Error ? err.message : '未知错误'))
    } finally {
      setImportingLUT(false)
    }
  }

  const handleScanNAS = async () => {
    setScanning(true)
    try {
      const result = await window.api.nasScan()
      if (result && result.success) {
        await loadNASDevices()
        alert(`扫描完成，发现 ${result.devices?.length || 0} 个 NAS 设备`)
      } else {
        alert('NAS 扫描失败: ' + (result?.error || '未知错误'))
      }
    } catch (err) {
      console.error('Failed to scan NAS:', err)
      alert('NAS 扫描失败')
    } finally {
      setScanning(false)
    }
  }

  const tabs = [
    { id: 'general', label: '通用设置', icon: SettingsIcon },
    { id: 'mhl', label: 'ASC MHL', icon: Shield },
    { id: 'transcode', label: '转码设置', icon: FileVideo },
    { id: 'lut', label: 'LUT/CDL', icon: Palette },
    { id: 'nas', label: 'NAS 管理', icon: HardDrive },
    { id: 'resolve', label: 'DaVinci', icon: Film },
    { id: 'lifecycle', label: '生命周期', icon: Database },
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
              disabled={savingSettings}
              className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-500 transition-colors disabled:opacity-50"
            >
              {savingSettings ? (
                <>
                  <RefreshCw size={16} className="animate-spin" />
                  保存中...
                </>
              ) : saved ? (
                <>
                  <Check size={16} />
                  已保存
                </>
              ) : (
                <>
                  <Save size={16} />
                  保存设置
                </>
              )}
            </button>
          </div>

          {/* LUT/CDL 设置 */}
          {activeTab === 'lut' && (
            <div className="space-y-6">
              <div className="glass-card p-4">
                <h3 className="text-sm font-semibold text-gray-200 mb-4">LUT 管理</h3>
                <p className="text-xs text-gray-500 mb-4">
                  管理 LUT (Look-Up Table) 文件，用于色彩校正
                </p>
                <div className="space-y-4">
                  <div>
                    <label className="block text-xs text-gray-500 mb-2">导入 LUT 文件</label>
                    <div className="flex items-center gap-2">
                      <input
                        type="text"
                        value={selectedLUT}
                        onChange={(e) => setSelectedLUT(e.target.value)}
                        placeholder="输入 LUT 名称..."
                        className="flex-1 px-3 py-2 bg-[#111] border border-[#2a2a2a] rounded-lg text-sm text-gray-200"
                      />
                      <button
                        onClick={handleImportLUT}
                        disabled={importingLUT}
                        className="px-3 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-500 transition-colors disabled:opacity-50"
                      >
                        {importingLUT ? (
                          <>
                            <RefreshCw size={14} className="animate-spin" />
                            导入中...
                          </>
                        ) : (
                          '导入'
                        )}
                      </button>
                    </div>
                  </div>

                  <div>
                    <label className="block text-xs text-gray-500 mb-2">已导入的 LUT ({luts.length})</label>
                    <div className="space-y-2 max-h-40 overflow-auto">
                      {luts.length === 0 ? (
                        <div className="p-3 bg-[#111] border border-[#2a2a2a] rounded-lg">
                          <p className="text-xs text-gray-500">暂无已导入的 LUT 文件</p>
                        </div>
                      ) : (
                        luts.map((lut) => (
                          <div key={lut.id} className="flex items-center justify-between p-2 bg-[#111] border border-[#2a2a2a] rounded-lg">
                            <div>
                              <p className="text-sm text-gray-200">{lut.name}</p>
                              <p className="text-xs text-gray-500">{lut.format} • {lut.size}x{lut.size}x{lut.size}</p>
                            </div>
                            <button className="p-1 text-gray-500 hover:text-red-400">
                              <Trash2 size={14} />
                            </button>
                          </div>
                        ))
                      )}
                    </div>
                  </div>
                </div>
              </div>

              <div className="glass-card p-4">
                <h3 className="text-sm font-semibold text-gray-200 mb-4">CDL 管理</h3>
                <p className="text-xs text-gray-500 mb-4">
                  管理 CDL (Color Decision List) 文件
                </p>
                <div className="space-y-4">
                  <div>
                    <label className="block text-xs text-gray-500 mb-2">已创建的 CDL ({cdls.length})</label>
                    <div className="space-y-2 max-h-40 overflow-auto">
                      {cdls.length === 0 ? (
                        <div className="p-3 bg-[#111] border border-[#2a2a2a] rounded-lg">
                          <p className="text-xs text-gray-500">暂无已创建的 CDL</p>
                        </div>
                      ) : (
                        cdls.map((cdl) => (
                          <div key={cdl.id} className="flex items-center justify-between p-2 bg-[#111] border border-[#2a2a2a] rounded-lg">
                            <div>
                              <p className="text-sm text-gray-200">{cdl.name}</p>
                              <p className="text-xs text-gray-500">
                                Slope: {cdl.slope.join(', ')} • Offset: {cdl.offset.join(', ')}
                              </p>
                            </div>
                            <button className="p-1 text-gray-500 hover:text-red-400">
                              <Trash2 size={14} />
                            </button>
                          </div>
                        ))
                      )}
                    </div>
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

                  <button 
                    onClick={handleScanNAS}
                    disabled={scanning}
                    className="w-full flex items-center justify-center gap-2 px-4 py-2 bg-[#111] border border-[#2a2a2a] rounded-lg text-sm text-gray-400 hover:text-gray-200 disabled:opacity-50"
                  >
                    {scanning ? (
                      <>
                        <RefreshCw size={14} className="animate-spin" />
                        扫描中...
                      </>
                    ) : (
                      <>
                        <RefreshCw size={14} />
                        扫描 NAS 设备
                      </>
                    )}
                  </button>

                  <div>
                    <label className="block text-xs text-gray-500 mb-2">已发现的 NAS 设备 ({nasDevices.length})</label>
                    <div className="space-y-2 max-h-40 overflow-auto">
                      {nasDevices.length === 0 ? (
                        <div className="p-3 bg-[#111] border border-[#2a2a2a] rounded-lg">
                          <p className="text-xs text-gray-500">暂未发现 NAS 设备</p>
                        </div>
                      ) : (
                        nasDevices.map((device) => (
                          <div key={device.id} className="p-3 bg-[#111] border border-[#2a2a2a] rounded-lg">
                            <div className="flex items-center justify-between mb-2">
                              <p className="text-sm font-medium text-gray-200">{device.name}</p>
                              <span className={`px-2 py-1 text-xs rounded ${
                                device.health?.smart?.healthy ? 'bg-green-600/20 text-green-400' : 'bg-red-600/20 text-red-400'
                              }`}>
                                {device.health?.smart?.healthy ? '健康' : '异常'}
                              </span>
                            </div>
                            <p className="text-xs text-gray-500">{device.host} • {device.protocol.toUpperCase()}</p>
                            <div className="mt-2 grid grid-cols-3 gap-2 text-xs">
                              <div>
                                <p className="text-gray-500">总容量</p>
                                <p className="text-gray-200">{Math.round(device.health?.capacity?.total / 1024 / 1024 / 1024)} GB</p>
                              </div>
                              <div>
                                <p className="text-gray-500">已使用</p>
                                <p className="text-gray-200">{Math.round(device.health?.capacity?.used / 1024 / 1024 / 1024)} GB</p>
                              </div>
                              <div>
                                <p className="text-gray-500">可用</p>
                                <p className="text-gray-200">{Math.round(device.health?.capacity?.available / 1024 / 1024 / 1024)} GB</p>
                              </div>
                            </div>
                          </div>
                        ))
                      )}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* 生命周期设置 */}
          {activeTab === 'lifecycle' && (
            <div className="space-y-6">
              <div className="glass-card p-4">
                <h3 className="text-sm font-semibold text-gray-200 mb-4">媒体生命周期管理</h3>
                <p className="text-xs text-gray-500 mb-4">
                  管理素材从拍摄到归档的完整生命周期
                </p>
                <div className="space-y-4">
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-sm text-gray-200">启用生命周期管理</p>
                      <p className="text-xs text-gray-500">追踪素材状态和归档策略</p>
                    </div>
                    <button
                      onClick={() => setLifecycleEnabled(!lifecycleEnabled)}
                      className={`w-12 h-6 rounded-full transition-colors ${
                        lifecycleEnabled ? 'bg-blue-600' : 'bg-gray-600'
                      }`}
                    >
                      <div className={`w-5 h-5 bg-white rounded-full transition-transform ${
                        lifecycleEnabled ? 'translate-x-6' : 'translate-x-1'
                      }`} />
                    </button>
                  </div>

                  <div>
                    <label className="block text-xs text-gray-500 mb-2">归档策略 ({archivePolicies.length})</label>
                    <div className="space-y-2 max-h-40 overflow-auto">
                      {archivePolicies.length === 0 ? (
                        <div className="p-3 bg-[#111] border border-[#2a2a2a] rounded-lg">
                          <p className="text-xs text-gray-500">暂无归档策略</p>
                        </div>
                      ) : (
                        archivePolicies.map((policy) => (
                          <div key={policy.id} className="p-3 bg-[#111] border border-[#2a2a2a] rounded-lg">
                            <div className="flex items-center justify-between mb-2">
                              <p className="text-sm font-medium text-gray-200">{policy.name}</p>
                              <span className={`px-2 py-1 text-xs rounded ${
                                policy.enabled ? 'bg-green-600/20 text-green-400' : 'bg-gray-600/20 text-gray-400'
                              }`}>
                                {policy.enabled ? '启用' : '禁用'}
                              </span>
                            </div>
                            <p className="text-xs text-gray-500">{policy.description}</p>
                          </div>
                        ))
                      )}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
