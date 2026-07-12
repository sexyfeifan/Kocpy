import { useState, useEffect } from 'react'
import {
  HardDrive, RefreshCw, Plus, Trash2, Play, Pause,
  CheckCircle, XCircle, Clock, ArrowRight, Settings, FolderOpen
} from 'lucide-react'

interface NASDevice {
  id: string
  name: string
  host: string
  protocol: 'smb' | 'nfs' | 'afp'
  shares: Array<{
    name: string
    path: string
    permissions: { read: boolean; write: boolean }
  }>
  health: {
    smart: { healthy: boolean; temperature: number; powerOnHours: number }
    capacity: { total: number; used: number; available: number }
    raid: { type: string; status: string; disks: number; activeDisks: number }
  }
  discoveredAt: string
}

interface SyncJob {
  id: string
  source: string
  destination: string
  nasDevice?: string
  status: 'pending' | 'running' | 'completed' | 'failed'
  progress: {
    totalFiles: number
    syncedFiles: number
    totalBytes: number
    syncedBytes: number
    currentFile?: string
  }
  startedAt?: string
  completedAt?: string
  error?: string
}

export function NASManager(): JSX.Element {
  const [devices, setDevices] = useState<NASDevice[]>([])
  const [syncJobs, setSyncJobs] = useState<SyncJob[]>([])
  const [selectedDevice, setSelectedDevice] = useState<string | null>(null)

  // 模态框状态
  const [showAddModal, setShowAddModal] = useState(false)
  const [showSyncModal, setShowSyncModal] = useState(false)

  // 手动添加 NAS
  const [newNASName, setNewNASName] = useState('')
  const [newNASHost, setNewNASHost] = useState('')
  const [newNASProtocol, setNewNASProtocol] = useState<'smb' | 'nfs' | 'afp'>('smb')

  // 同步任务创建
  const [syncSource, setSyncSource] = useState('')
  const [syncDestination, setSyncDestination] = useState('')
  const [syncNASDevice, setSyncNASDevice] = useState('')
  const [syncNASPath, setSyncNASPath] = useState('')

  useEffect(() => {
    loadDevices()
    loadSyncJobs()
  }, [])

  const loadDevices = async () => {
    try {
      const result = await window.api.nasGetDevices()
      if (result && Array.isArray(result)) {
        setDevices(result)
      }
    } catch (err) {
      console.error('Failed to load NAS devices:', err)
    }
  }

  const loadSyncJobs = async () => {
    try {
      const result = await window.api.nasGetSyncJobs()
      if (result && Array.isArray(result)) {
        setSyncJobs(result)
      }
    } catch (err) {
      console.error('Failed to load sync jobs:', err)
    }
  }

  const handleAddManual = async () => {
    if (!newNASName || !newNASHost) {
      alert('请填写 NAS 名称和主机地址')
      return
    }

    const newDevice: NASDevice = {
      id: `manual-${Date.now()}`,
      name: newNASName,
      host: newNASHost,
      protocol: newNASProtocol,
      shares: [],
      health: {
        smart: { healthy: true, temperature: 0, powerOnHours: 0 },
        capacity: { total: 0, used: 0, available: 0 },
        raid: { type: 'Unknown', status: 'unknown', disks: 0, activeDisks: 0 }
      },
      discoveredAt: new Date().toISOString()
    }

    setDevices(prev => [...prev, newDevice])
    setShowAddModal(false)
    setNewNASName('')
    setNewNASHost('')
    alert(`已添加 NAS: ${newNASName}\n\n现在可以创建同步任务了`)
  }

  const handleSelectSource = async () => {
    const path = await window.api.selectDirectory()
    if (path) {
      setSyncSource(path)
    }
  }

  const handleSelectDestination = async () => {
    const path = await window.api.selectDirectory()
    if (path) {
      setSyncDestination(path)
      setSyncNASDevice('')
      setSyncNASPath('')
    }
  }

  const handleSelectNASDevice = (deviceId: string) => {
    setSyncNASDevice(deviceId)
    setSyncSource('')
    setSyncDestination('')
  }

  const handleCreateSyncJob = async () => {
    let source = syncSource
    let destination = syncDestination

    if (syncNASDevice) {
      const device = devices.find(d => d.id === syncNASDevice)
      if (device) {
        destination = `${device.protocol}://${device.host}/${syncNASPath || 'backup'}`
      }
    }

    if (!source || !destination) {
      alert('请选择源路径和目标路径')
      return
    }

    try {
      const result = await window.api.nasCreateSyncJob(source, destination)
      if (result && result.success) {
        await loadSyncJobs()
        setShowSyncModal(false)
        setSyncSource('')
        setSyncDestination('')
        setSyncNASDevice('')
        setSyncNASPath('')
        alert('同步任务创建成功')
      } else {
        alert('创建失败: ' + (result?.error || '未知错误'))
      }
    } catch (err) {
      console.error('Failed to create sync job:', err)
      alert('创建失败')
    }
  }

  const handleStartSync = async (jobId: string) => {
    try {
      const result = await window.api.nasStartSync(jobId)
      if (result && result.success) {
        await loadSyncJobs()
        alert('同步已开始')
      } else {
        alert('启动失败: ' + (result?.error || '未知错误'))
      }
    } catch (err) {
      console.error('Failed to start sync:', err)
      alert('启动失败')
    }
  }

  const handleDeleteDevice = (deviceId: string) => {
    if (confirm('确定要删除这个 NAS 设备吗？')) {
      setDevices(prev => prev.filter(d => d.id !== deviceId))
      if (selectedDevice === deviceId) {
        setSelectedDevice(null)
      }
    }
  }

  const formatBytes = (bytes: number): string => {
    if (bytes === 0) return '0 B'
    const k = 1024
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB']
    const i = Math.floor(Math.log(bytes) / Math.log(k))
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i]
  }

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'completed': return 'text-green-400 bg-green-600/20'
      case 'running': return 'text-blue-400 bg-blue-600/20'
      case 'failed': return 'text-red-400 bg-red-600/20'
      default: return 'text-gray-400 bg-gray-600/20'
    }
  }

  const getStatusLabel = (status: string) => {
    switch (status) {
      case 'completed': return '已完成'
      case 'running': return '同步中'
      case 'failed': return '失败'
      case 'pending': return '等待中'
      default: return status
    }
  }

  return (
    <div className="flex flex-col h-full bg-[#0a0a0a]">
      {/* 头部 */}
      <div className="flex items-center justify-between p-4 border-b border-[#2a2a2a]">
        <div>
          <h1 className="text-lg font-semibold text-gray-200">NAS 管理</h1>
          <p className="text-sm text-gray-500">管理 NAS 设备、同步数据</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowAddModal(true)}
            className="flex items-center gap-2 px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-500"
          >
            <Plus size={16} />
            添加 NAS
          </button>
          <button
            onClick={() => setShowSyncModal(true)}
            className="flex items-center gap-2 px-4 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-500"
          >
            <ArrowRight size={16} />
            创建同步任务
          </button>
        </div>
      </div>

      {/* 内容区域 */}
      <div className="flex-1 overflow-auto p-4">
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* NAS 设备列表 */}
          <div>
            <h2 className="text-sm font-semibold text-gray-200 mb-4">NAS 设备 ({devices.length})</h2>
            <div className="space-y-3">
              {devices.length === 0 ? (
                <div className="glass-card p-8 text-center">
                  <HardDrive size={48} className="text-gray-600 mx-auto mb-4" />
                  <p className="text-gray-500 mb-4">暂无 NAS 设备</p>
                  <button
                    onClick={() => setShowAddModal(true)}
                    className="px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-500"
                  >
                    添加 NAS
                  </button>
                  <p className="text-xs text-gray-600 mt-3">
                    点击上方按钮手动添加您的 NAS 设备
                  </p>
                </div>
              ) : (
                devices.map((device) => (
                  <div
                    key={device.id}
                    className={`glass-card p-4 cursor-pointer transition-all ${
                      selectedDevice === device.id ? 'ring-2 ring-blue-500' : ''
                    }`}
                  >
                    <div className="flex items-center justify-between mb-3">
                      <div
                        className="flex items-center gap-3 flex-1"
                        onClick={() => setSelectedDevice(device.id === selectedDevice ? null : device.id)}
                      >
                        <HardDrive size={20} className="text-blue-400" />
                        <div>
                          <p className="text-sm font-medium text-gray-200">{device.name}</p>
                          <p className="text-xs text-gray-500">{device.host} • {device.protocol.toUpperCase()}</p>
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className={`px-2 py-1 text-xs rounded ${
                          device.health?.smart?.healthy ? 'bg-green-600/20 text-green-400' : 'bg-red-600/20 text-red-400'
                        }`}>
                          {device.health?.smart?.healthy ? '健康' : '异常'}
                        </span>
                        <button
                          onClick={() => handleDeleteDevice(device.id)}
                          className="p-1 text-gray-500 hover:text-red-400"
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                    </div>

                    {device.health?.capacity?.total > 0 && (
                      <div className="grid grid-cols-3 gap-3 mt-3 pt-3 border-t border-[#2a2a2a]">
                        <div>
                          <p className="text-xs text-gray-500">总容量</p>
                          <p className="text-sm font-medium text-gray-200">
                            {formatBytes(device.health.capacity.total)}
                          </p>
                        </div>
                        <div>
                          <p className="text-xs text-gray-500">已使用</p>
                          <p className="text-sm font-medium text-gray-200">
                            {formatBytes(device.health.capacity.used)}
                          </p>
                        </div>
                        <div>
                          <p className="text-xs text-gray-500">可用</p>
                          <p className="text-sm font-medium text-gray-200">
                            {formatBytes(device.health.capacity.available)}
                          </p>
                        </div>
                      </div>
                    )}
                  </div>
                ))
              )}
            </div>
          </div>

          {/* 同步任务列表 */}
          <div>
            <h2 className="text-sm font-semibold text-gray-200 mb-4">同步任务 ({syncJobs.length})</h2>
            <div className="space-y-3">
              {syncJobs.length === 0 ? (
                <div className="glass-card p-8 text-center">
                  <ArrowRight size={48} className="text-gray-600 mx-auto mb-4" />
                  <p className="text-gray-500 mb-4">暂无同步任务</p>
                  <button
                    onClick={() => setShowSyncModal(true)}
                    className="px-4 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-500"
                  >
                    创建同步任务
                  </button>
                </div>
              ) : (
                syncJobs.map((job) => (
                  <div key={job.id} className="glass-card p-4">
                    <div className="flex items-center justify-between mb-3">
                      <div className="flex items-center gap-2">
                        <span className={`px-2 py-1 text-xs rounded ${getStatusColor(job.status)}`}>
                          {getStatusLabel(job.status)}
                        </span>
                      </div>
                      {job.status === 'pending' && (
                        <button
                          onClick={() => handleStartSync(job.id)}
                          className="px-3 py-1.5 bg-green-600 text-white rounded-lg hover:bg-green-500"
                        >
                          <Play size={14} />
                        </button>
                      )}
                    </div>

                    <div className="space-y-2 mb-3">
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-gray-500 w-12">源:</span>
                        <span className="text-xs text-gray-300 font-mono truncate">{job.source}</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-gray-500 w-12">目标:</span>
                        <span className="text-xs text-gray-300 font-mono truncate">{job.destination}</span>
                      </div>
                    </div>

                    {job.status === 'running' && job.progress && (
                      <div>
                        <div className="flex items-center justify-between mb-1">
                          <span className="text-xs text-gray-500">
                            {job.progress.syncedFiles}/{job.progress.totalFiles} 文件
                          </span>
                          <span className="text-xs text-gray-500">
                            {formatBytes(job.progress.syncedBytes)}/{formatBytes(job.progress.totalBytes)}
                          </span>
                        </div>
                        <div className="h-2 bg-[#2a2a2a] rounded-full overflow-hidden">
                          <div
                            className="h-full bg-green-500 rounded-full transition-all"
                            style={{
                              width: `${job.progress.totalBytes > 0
                                ? (job.progress.syncedBytes / job.progress.totalBytes) * 100
                                : 0}%`
                            }}
                          />
                        </div>
                      </div>
                    )}

                    {job.status === 'failed' && job.error && (
                      <div className="p-2 bg-red-600/10 border border-red-500/20 rounded mt-2">
                        <p className="text-xs text-red-400">{job.error}</p>
                      </div>
                    )}
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      </div>

      {/* 手动添加 NAS 模态框 */}
      {showAddModal && (
        <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50">
          <div className="w-full max-w-md bg-[#111] border border-[#2a2a2a] rounded-xl p-6">
            <h3 className="text-lg font-semibold text-gray-200 mb-4">添加 NAS 设备</h3>
            <div className="space-y-4">
              <div>
                <label className="block text-sm text-gray-400 mb-2">NAS 名称</label>
                <input
                  type="text"
                  value={newNASName}
                  onChange={(e) => setNewNASName(e.target.value)}
                  placeholder="例如: Synology NAS"
                  className="w-full px-3 py-2 bg-[#0a0a0a] border border-[#2a2a2a] rounded-lg text-sm text-gray-200"
                />
              </div>
              <div>
                <label className="block text-sm text-gray-400 mb-2">主机地址</label>
                <input
                  type="text"
                  value={newNASHost}
                  onChange={(e) => setNewNASHost(e.target.value)}
                  placeholder="192.168.1.100 或 nas.local"
                  className="w-full px-3 py-2 bg-[#0a0a0a] border border-[#2a2a2a] rounded-lg text-sm text-gray-200"
                />
              </div>
              <div>
                <label className="block text-sm text-gray-400 mb-2">协议</label>
                <select
                  value={newNASProtocol}
                  onChange={(e) => setNewNASProtocol(e.target.value as any)}
                  className="w-full px-3 py-2 bg-[#0a0a0a] border border-[#2a2a2a] rounded-lg text-sm text-gray-200"
                >
                  <option value="smb">SMB (推荐)</option>
                  <option value="nfs">NFS</option>
                  <option value="afp">AFP</option>
                </select>
              </div>
              <div className="flex items-center gap-3 pt-4">
                <button
                  onClick={handleAddManual}
                  className="flex-1 px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-500"
                >
                  添加
                </button>
                <button
                  onClick={() => setShowAddModal(false)}
                  className="flex-1 px-4 py-2 bg-gray-600 text-white rounded-lg hover:bg-gray-500"
                >
                  取消
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 创建同步任务模态框 */}
      {showSyncModal && (
        <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50">
          <div className="w-full max-w-lg bg-[#111] border border-[#2a2a2a] rounded-xl p-6">
            <h3 className="text-lg font-semibold text-gray-200 mb-4">创建同步任务</h3>
            <div className="space-y-4">
              <div>
                <label className="block text-sm text-gray-400 mb-2">同步方式</label>
                <div className="flex gap-2">
                  <button
                    onClick={() => {
                      setSyncNASDevice('')
                      setSyncSource('')
                      setSyncDestination('')
                    }}
                    className={`flex-1 px-3 py-2 rounded-lg text-sm ${
                      !syncNASDevice
                        ? 'bg-blue-600 text-white'
                        : 'bg-[#0a0a0a] text-gray-400 border border-[#2a2a2a]'
                    }`}
                  >
                    自定义路径
                  </button>
                  <button
                    onClick={() => {
                      setSyncSource('')
                      setSyncDestination('')
                    }}
                    className={`flex-1 px-3 py-2 rounded-lg text-sm ${
                      syncNASDevice
                        ? 'bg-blue-600 text-white'
                        : 'bg-[#0a0a0a] text-gray-400 border border-[#2a2a2a]'
                    }`}
                  >
                    选择 NAS 设备
                  </button>
                </div>
              </div>

              {devices.length > 0 && (
                <div>
                  <label className="block text-sm text-gray-400 mb-2">NAS 设备</label>
                  <select
                    value={syncNASDevice}
                    onChange={(e) => handleSelectNASDevice(e.target.value)}
                    className="w-full px-3 py-2 bg-[#0a0a0a] border border-[#2a2a2a] rounded-lg text-sm text-gray-200"
                  >
                    <option value="">选择 NAS 设备...</option>
                    {devices.map((device) => (
                      <option key={device.id} value={device.id}>
                        {device.name} ({device.host})
                      </option>
                    ))}
                  </select>
                </div>
              )}

              {syncNASDevice && (
                <div>
                  <label className="block text-sm text-gray-400 mb-2">NAS 上的目标路径</label>
                  <input
                    type="text"
                    value={syncNASPath}
                    onChange={(e) => setSyncNASPath(e.target.value)}
                    placeholder="backup/2026"
                    className="w-full px-3 py-2 bg-[#0a0a0a] border border-[#2a2a2a] rounded-lg text-sm text-gray-200"
                  />
                </div>
              )}

              <div>
                <label className="block text-sm text-gray-400 mb-2">源路径（本地文件夹）</label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={syncSource}
                    onChange={(e) => setSyncSource(e.target.value)}
                    placeholder="/Volumes/Source"
                    className="flex-1 px-3 py-2 bg-[#0a0a0a] border border-[#2a2a2a] rounded-lg text-sm text-gray-200"
                    disabled={!!syncNASDevice}
                  />
                  <button
                    onClick={handleSelectSource}
                    disabled={!!syncNASDevice}
                    className="px-3 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-500 disabled:opacity-50"
                  >
                    <FolderOpen size={16} />
                  </button>
                </div>
              </div>

              {!syncNASDevice && (
                <div>
                  <label className="block text-sm text-gray-400 mb-2">目标路径</label>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={syncDestination}
                      onChange={(e) => setSyncDestination(e.target.value)}
                      placeholder="smb://nas/share/backup"
                      className="flex-1 px-3 py-2 bg-[#0a0a0a] border border-[#2a2a2a] rounded-lg text-sm text-gray-200"
                    />
                    <button
                      onClick={handleSelectDestination}
                      className="px-3 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-500"
                    >
                      <FolderOpen size={16} />
                    </button>
                  </div>
                </div>
              )}

              {(syncSource || syncNASDevice) && (
                <div className="p-3 bg-[#0a0a0a] border border-[#2a2a2a] rounded-lg">
                  <p className="text-xs text-gray-500 mb-2">同步预览:</p>
                  <div className="space-y-1">
                    <p className="text-xs text-gray-300">
                      <span className="text-gray-500">源: </span>
                      {syncSource || '(选择源路径)'}
                    </p>
                    <p className="text-xs text-gray-300">
                      <span className="text-gray-500">目标: </span>
                      {syncNASDevice
                        ? `${devices.find(d => d.id === syncNASDevice)?.protocol}://${devices.find(d => d.id === syncNASDevice)?.host}/${syncNASPath || 'backup'}`
                        : syncDestination || '(选择目标路径)'
                      }
                    </p>
                  </div>
                </div>
              )}

              <div className="flex items-center gap-3 pt-4">
                <button
                  onClick={handleCreateSyncJob}
                  disabled={!syncSource && !syncNASDevice}
                  className="flex-1 px-4 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-500 disabled:opacity-50"
                >
                  创建同步任务
                </button>
                <button
                  onClick={() => setShowSyncModal(false)}
                  className="flex-1 px-4 py-2 bg-gray-600 text-white rounded-lg hover:bg-gray-500"
                >
                  取消
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
