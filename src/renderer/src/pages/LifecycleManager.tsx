import { useState, useEffect } from 'react'
import { 
  Database, Search, Filter, Archive, Clock, 
  CheckCircle, XCircle, AlertCircle, BarChart3
} from 'lucide-react'

interface MediaLifecycle {
  id: string
  filePath: string
  fileName: string
  status: 'raw' | 'backedup' | 'previewed' | 'transcoded' | 'editing' | 'graded' | 'output' | 'archived' | 'deleted'
  history: Array<{
    status: string
    timestamp: string
    location: string
    notes?: string
  }>
  metadata: {
    size: number
    createdAt: string
    project?: string
    tags?: string[]
  }
  createdAt: string
  updatedAt: string
}

export function LifecycleManager(): JSX.Element {
  const [lifecycles, setLifecycles] = useState<MediaLifecycle[]>([])
  const [searchQuery, setSearchQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState<string>('all')
  const [statistics, setStatistics] = useState<any>(null)

  useEffect(() => {
    loadLifecycles()
    loadStatistics()
  }, [])

  const loadLifecycles = async () => {
    try {
      const result = await window.api.lifecycleGetAll()
      if (result && Array.isArray(result)) {
        setLifecycles(result)
      }
    } catch (err) {
      console.error('Failed to load lifecycles:', err)
    }
  }

  const loadStatistics = async () => {
    try {
      const result = await window.api.lifecycleGetStatistics()
      if (result) {
        setStatistics(result)
      }
    } catch (err) {
      console.error('Failed to load statistics:', err)
    }
  }

  const handleSearch = async () => {
    if (!searchQuery.trim()) {
      await loadLifecycles()
      return
    }

    try {
      const result = await window.api.lifecycleSearch(searchQuery)
      if (result && Array.isArray(result)) {
        setLifecycles(result)
      }
    } catch (err) {
      console.error('Failed to search:', err)
    }
  }

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'completed':
      case 'archived':
        return 'text-green-400 bg-green-600/20'
      case 'raw':
      case 'backedup':
        return 'text-blue-400 bg-blue-600/20'
      case 'editing':
      case 'graded':
        return 'text-yellow-400 bg-yellow-600/20'
      case 'failed':
      case 'deleted':
        return 'text-red-400 bg-red-600/20'
      default:
        return 'text-gray-400 bg-gray-600/20'
    }
  }

  const getStatusLabel = (status: string) => {
    const labels: Record<string, string> = {
      raw: '原始',
      backedup: '已备份',
      previewed: '已预览',
      transcoded: '已转码',
      editing: '编辑中',
      graded: '已调色',
      output: '已输出',
      archived: '已归档',
      deleted: '已删除'
    }
    return labels[status] || status
  }

  const formatBytes = (bytes: number): string => {
    if (bytes === 0) return '0 B'
    const k = 1024
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB']
    const i = Math.floor(Math.log(bytes) / Math.log(k))
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i]
  }

  const filteredLifecycles = lifecycles.filter(l => {
    if (statusFilter !== 'all' && l.status !== statusFilter) return false
    return true
  })

  return (
    <div className="flex flex-col h-full bg-[#0a0a0a]">
      {/* 头部 */}
      <div className="flex items-center justify-between p-4 border-b border-[#2a2a2a]">
        <div>
          <h1 className="text-lg font-semibold text-gray-200">媒体生命周期管理</h1>
          <p className="text-sm text-gray-500">追踪素材从拍摄到归档的完整生命周期</p>
        </div>
      </div>

      {/* 统计卡片 */}
      {statistics && (
        <div className="grid grid-cols-4 gap-4 p-4 border-b border-[#2a2a2a]">
          <div className="glass-card p-3">
            <div className="flex items-center gap-2 mb-2">
              <Database size={14} className="text-blue-400" />
              <span className="text-xs text-gray-500">总素材</span>
            </div>
            <p className="text-xl font-semibold text-gray-200">{statistics.total || 0}</p>
          </div>
          <div className="glass-card p-3">
            <div className="flex items-center gap-2 mb-2">
              <CheckCircle size={14} className="text-green-400" />
              <span className="text-xs text-gray-500">已归档</span>
            </div>
            <p className="text-xl font-semibold text-gray-200">{statistics.byStatus?.archived || 0}</p>
          </div>
          <div className="glass-card p-3">
            <div className="flex items-center gap-2 mb-2">
              <Clock size={14} className="text-yellow-400" />
              <span className="text-xs text-gray-500">处理中</span>
            </div>
            <p className="text-xl font-semibold text-gray-200">
              {(statistics.byStatus?.editing || 0) + (statistics.byStatus?.transcoded || 0)}
            </p>
          </div>
          <div className="glass-card p-3">
            <div className="flex items-center gap-2 mb-2">
              <BarChart3 size={14} className="text-purple-400" />
              <span className="text-xs text-gray-500">总大小</span>
            </div>
            <p className="text-xl font-semibold text-gray-200">{formatBytes(statistics.totalSize || 0)}</p>
          </div>
        </div>
      )}

      {/* 搜索和筛选 */}
      <div className="flex items-center gap-3 p-4 border-b border-[#2a2a2a]">
        <div className="flex-1 relative">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyPress={(e) => e.key === 'Enter' && handleSearch()}
            placeholder="搜索文件名、项目、标签..."
            className="w-full pl-10 pr-4 py-2 bg-[#111] border border-[#2a2a2a] rounded-lg text-sm text-gray-200"
          />
        </div>
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="px-3 py-2 bg-[#111] border border-[#2a2a2a] rounded-lg text-sm text-gray-200"
        >
          <option value="all">所有状态</option>
          <option value="raw">原始</option>
          <option value="backedup">已备份</option>
          <option value="transcoded">已转码</option>
          <option value="editing">编辑中</option>
          <option value="archived">已归档</option>
        </select>
        <button
          onClick={handleSearch}
          className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-500"
        >
          搜索
        </button>
      </div>

      {/* 素材列表 */}
      <div className="flex-1 overflow-auto p-4">
        <div className="space-y-3">
          {filteredLifecycles.length === 0 ? (
            <div className="glass-card p-8 text-center">
              <Database size={48} className="text-gray-600 mx-auto mb-4" />
              <p className="text-gray-500 mb-4">暂无素材记录</p>
              <p className="text-xs text-gray-600">
                备份任务完成后，素材将自动记录到生命周期管理系统
              </p>
            </div>
          ) : (
            filteredLifecycles.map((lifecycle) => (
              <div key={lifecycle.id} className="glass-card p-4">
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-3">
                    <span className={`px-2 py-1 text-xs rounded ${getStatusColor(lifecycle.status)}`}>
                      {getStatusLabel(lifecycle.status)}
                    </span>
                    <span className="text-sm font-medium text-gray-200">{lifecycle.fileName}</span>
                  </div>
                  <span className="text-xs text-gray-500">
                    {new Date(lifecycle.updatedAt).toLocaleString()}
                  </span>
                </div>

                <div className="grid grid-cols-3 gap-3 mb-3 text-xs">
                  <div>
                    <span className="text-gray-500">大小:</span>
                    <span className="text-gray-300 ml-2">{formatBytes(lifecycle.metadata.size)}</span>
                  </div>
                  <div>
                    <span className="text-gray-500">项目:</span>
                    <span className="text-gray-300 ml-2">{lifecycle.metadata.project || '-'}</span>
                  </div>
                  <div>
                    <span className="text-gray-500">创建:</span>
                    <span className="text-gray-300 ml-2">
                      {new Date(lifecycle.metadata.createdAt).toLocaleDateString()}
                    </span>
                  </div>
                </div>

                {lifecycle.metadata.tags && lifecycle.metadata.tags.length > 0 && (
                  <div className="flex flex-wrap gap-1 mb-3">
                    {lifecycle.metadata.tags.map((tag) => (
                      <span key={tag} className="px-2 py-0.5 text-xs bg-blue-600/20 text-blue-400 rounded">
                        {tag}
                      </span>
                    ))}
                  </div>
                )}

                {/* 状态历史 */}
                {lifecycle.history.length > 1 && (
                  <div className="pt-3 border-t border-[#2a2a2a]">
                    <p className="text-xs text-gray-500 mb-2">状态历史</p>
                    <div className="space-y-1">
                      {lifecycle.history.slice(-3).reverse().map((entry, index) => (
                        <div key={index} className="flex items-center gap-2 text-xs">
                          <span className="text-gray-500">
                            {new Date(entry.timestamp).toLocaleString()}
                          </span>
                          <span className="text-gray-400">{getStatusLabel(entry.status)}</span>
                          {entry.notes && (
                            <span className="text-gray-600">- {entry.notes}</span>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  )
}
