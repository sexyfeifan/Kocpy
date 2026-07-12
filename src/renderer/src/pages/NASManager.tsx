import { useState, useEffect } from 'react'
import {
  HardDrive, RefreshCw, Plus, Trash2, Play, Pause,
  CheckCircle, XCircle, Clock, ArrowRight, Settings
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
  const [scanning, setScanning] = useState(false)
  const [selectedDevice, setSelectedDevice] = useState<string | null>(null)
  const [showAddModal, setShowAddModal] = useState(false)
  const [showSyncModal, setShowSyncModal] = useState(false)
  const [syncSource, setSyncSource] = useState('')
  const [syncDestination, setSyncDestination] = useState('')

  // 手动添加 NAS
  const [newNASName, setNewNASName] = useState('')
  const [newNASHost, setNewNASHost] = useState('')
  const [newNASProtocol, setNewNASProtocol] = useState<'smb' | 'nfs' | 'afp'>('smb')

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

  const handleScan = async () => {
    setScanning(true)
    try {
      const result = await window.api.nasScan()
      if (result && result.success) {
        await loadDevices()
        alert(`扫描完成，发现 ${result.devices?.length || 0} 个 NAS 设备\n\n提示：如果没有发现设备，请尝试手动添加 NAS`)
      } else {
        alert('NAS 扫描失败: ' + (result?.error || '未知错误'))
      }
    } catch (err) {
      console.error('Failed to scan:', err)
      alert('NAS 扫描失败')
    } finally {
      setScanning(false)
    }
  }

  const handleAddManual = async () => {
    if (!newNASName || !newNASHost) {
      alert('请填写 NAS 名称和主机地址')
      return
    }

    // 创建手动添加的设备
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
    alert(`已添加 NAS: ${newNASName}\n\n注意：手动添加的设备需要先连接后才能获取详细信息`)
  }

  const handleCreateSyncJob = async () => {
    if (!syncSource || !syncDestination) {
      alert('请选择源路径和目标路径')
      return
    }

    try {
      const result = await window.api.nasCreateSyncJob(syncSource, syncDestination)
      if (result && result.success) {
        await loadSyncJobs()
        setShowSyncModal(false)
        setSyncSource('')
        setSyncDestination('')
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

  return (
    <div className="flex flex-col h-full bg-[#0a0a0a]">
      {/* 头部 */}
      <div className="flex items-center justify-between p-4 border-b border-[#2a2a2a]">
        <div>
          <h1 className="text-lg font-semibold text-gray-200">NAS 管理</h1>
          <p className="text-sm text-gray-500">管理 NAS 设备、监控健康状态、同步数据</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={handleScan}
            disabled={scanning}
            className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-500 disabled:opacity-50"
          >
            {scanning ? (
              <>
                <RefreshCw size={16} className="animate-spin" />
                扫描中...
              </>
            ) : (
              <>
                <RefreshCw size={16} />
                扫描 NAS
              </>
            )}
          </button>
          <button
            onClick={() => setShowAddModal(true)}
            className="flex items-center gap-2 px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-500"
          >
            <Plus size={16} />
            手动添加
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
                  <p className="text-gray-500 mb-4">暂未发现 NAS 设备</p>
                  <div className="space-y-2">
                    <button
                      onClick={handleScan}
                      className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-500"
                    >
                      扫描局域网
                    </button>
                    <p className="text-xs text-gray-600">
                      提示：如果扫描未发现设备，请使用"手动添加"
                    </p>
                  </div>
                </div>
              ) : (
                devices.map((device) => (
                  <div
                    key={device.id}
                    onClick={() => setSelectedDevice(device.id === selectedDevice ? null : device.id)}
                    className={`glass-card p-4 cursor-pointer transition-all ${
                      selectedDevice === device.id ? 'ring-2 ring-blue-500' : ''
                    }`}
                  >
                    <div className="flex items-center justify-between mb-3">
                      <div className="flex items-center gap-3">
                        <HardDrive size={20} className="text-blue-400" />
                        <div>
                          <p className="text-sm font-medium text-gray-200">{device.name}</p>
                          <p className="text-xs text-gray-500">{device.host} • {device.protocol.toUpperCase()}</p>
                        </div>
                      </div>
                      <span className={`px-2 py-1 text-xs rounded ${
                        device.health?.smart?.healthy ? 'bg-green-600/20 text-green-400' : 'bg-red-600/20 text-red-400'
                      }`}>
                        {device.health?.smart?.healthy ? '健康' : '异常'}
                      </span>
                    </div>

                    {/* 容量信息 */}
                    {device.health?.capacity?.total > 0 && (
                      <div className="grid grid-cols-3 gap-3 mb-3">
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

                    {/* RAID 状态 */}
                    {device.health?.raid && (
                      <div className="flex items-center gap-2 text-xs">
                        <span className="text-gray-500">RAID:</span>
                        <span className="text-gray-300">{device.health.raid.type}</span>
                        <span className={`px-1.5 py-0.5 rounded ${
                          device.health.raid.status === 'healthy'
                            ? 'bg-green-600/20 text-green-400'
                            : 'bg-yellow-600/20 text-yellow-400'
                        }`}>
                          {device.health.raid.status}
                        </span>
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
                          {job.status === 'completed' ? '已完成' :
                           job.status === 'running' ? '同步中' :
                           job.status === 'failed' ? '失败' : '等待中'}
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

                    {/* 进度条 */}
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
                        {job.progress.currentFile && (
                          <p className="text-xs text-gray-500 mt-1 truncate">
                            当前: {job.progress.currentFile}
                          </p>
                        )}
                      </div>
                    )}

                    {/* 错误信息 */}
                    {job.status === 'failed' && job.error && (
                      <div className="p-2 bg-red-600/10 border border-red-500/20 rounded">
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
            <h3 className="text-lg font-semibold text-gray-200 mb-4">手动添加 NAS</h3>
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
          <div className="w-full max-w-md bg-[#111] border border-[#2a2a2a] rounded-xl p-6">
            <h3 className="text-lg font-semibold text-gray-200 mb-4">创建同步任务</h3>
            <div className="space-y-4">
              <div>
                <label className="block text-sm text-gray-400 mb-2">源路径</label>
                <input
                  type="text"
                  value={syncSource}
                  onChange={(e) => setSyncSource(e.target.value)}
                  placeholder="/Volumes/Source"
                  className="w-full px-3 py-2 bg-[#0a0a0a] border border-[#2a2a2a] rounded-lg text-sm text-gray-200"
                />
              </div>
              <div>
                <label className="block text-sm text-gray-400 mb-2">目标路径 (NAS)</label>
                <input
                  type="text"
                  value={syncDestination}
                  onChange={(e) => setSyncDestination(e.target.value)}
                  placeholder="smb://nas/share/backup"
                  className="w-full px-3 py-2 bg-[#0a0a0a] border border-[#2a2a2a] rounded-lg text-sm text-gray-200"
                />
              </div>
              <div className="flex items-center gap-3 pt-4">
                <button
                  onClick={handleCreateSyncJob}
                  className="flex-1 px-4 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-500"
                >
                  创建
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
