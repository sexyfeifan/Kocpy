import { useState, useEffect } from 'react'
import { 
  LayoutDashboard, Film, BarChart3, Download, Trash2, 
  RefreshCw, CheckCircle, XCircle, Clock, HardDrive
} from 'lucide-react'
import { useTaskStore } from '../store/taskStore'
import { TaskCard } from '../components/TaskCard'
import { MediaBrowser } from '../components/MediaBrowser'
import { formatBytes, formatDuration } from '../utils'

export function Dashboard(): JSX.Element {
  const { tasks, refreshTasks, deleteTask, setPriority } = useTaskStore()
  const [activeTab, setActiveTab] = useState<'tasks' | 'media' | 'stats'>('tasks')
  const [selectedTasks, setSelectedTasks] = useState<Set<string>>(new Set())
  const [isDeleting, setIsDeleting] = useState(false)

  // 统计数据
  const stats = {
    totalTasks: tasks.length,
    completedTasks: tasks.filter(t => t.status === 'completed').length,
    failedTasks: tasks.filter(t => t.status === 'failed').length,
    totalBytes: tasks.reduce((sum, t) => sum + t.totalBytes, 0),
    transferredBytes: tasks.reduce((sum, t) => sum + t.transferredBytes, 0)
  }

  // 批量选择
  const toggleTaskSelection = (taskId: string) => {
    setSelectedTasks(prev => {
      const newSet = new Set(prev)
      if (newSet.has(taskId)) {
        newSet.delete(taskId)
      } else {
        newSet.add(taskId)
      }
      return newSet
    })
  }

  const selectAllTasks = () => {
    if (selectedTasks.size === tasks.length) {
      setSelectedTasks(new Set())
    } else {
      setSelectedTasks(new Set(tasks.map(t => t.id)))
    }
  }

  // 批量删除
  const handleBatchDelete = async () => {
    if (selectedTasks.size === 0) return
    
    const confirmed = window.confirm(`确定要删除选中的 ${selectedTasks.size} 个任务吗？`)
    if (!confirmed) return

    setIsDeleting(true)
    try {
      for (const taskId of selectedTasks) {
        await deleteTask(taskId)
      }
      setSelectedTasks(new Set())
    } catch (err) {
      console.error('Failed to delete tasks:', err)
      alert('删除失败')
    } finally {
      setIsDeleting(false)
    }
  }

  // 批量导出
  const handleBatchExport = async () => {
    if (selectedTasks.size === 0) return

    const selectedTaskList = tasks.filter(t => selectedTasks.has(t.id))
    
    // 导出为JSON
    const data = JSON.stringify(selectedTaskList, null, 2)
    const blob = new Blob([data], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `kocpy-tasks-${new Date().toISOString().slice(0, 10)}.json`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }

  // 刷新任务
  useEffect(() => {
    refreshTasks()
  }, [refreshTasks])

  const tabs = [
    { id: 'tasks', label: '任务列表', icon: LayoutDashboard },
    { id: 'media', label: '素材浏览', icon: Film },
    { id: 'stats', label: '统计分析', icon: BarChart3 }
  ]

  return (
    <div className="flex flex-col h-full bg-[#0a0a0a]">
      {/* 头部统计 */}
      <div className="p-4 border-b border-[#2a2a2a]">
        <div className="grid grid-cols-4 gap-4">
          <div className="glass-card p-3">
            <div className="flex items-center gap-2 mb-2">
              <Clock size={14} className="text-blue-400" />
              <span className="text-xs text-gray-500">总任务</span>
            </div>
            <p className="text-xl font-semibold text-gray-200">{stats.totalTasks}</p>
          </div>
          <div className="glass-card p-3">
            <div className="flex items-center gap-2 mb-2">
              <CheckCircle size={14} className="text-green-400" />
              <span className="text-xs text-gray-500">已完成</span>
            </div>
            <p className="text-xl font-semibold text-gray-200">{stats.completedTasks}</p>
          </div>
          <div className="glass-card p-3">
            <div className="flex items-center gap-2 mb-2">
              <XCircle size={14} className="text-red-400" />
              <span className="text-xs text-gray-500">失败</span>
            </div>
            <p className="text-xl font-semibold text-gray-200">{stats.failedTasks}</p>
          </div>
          <div className="glass-card p-3">
            <div className="flex items-center gap-2 mb-2">
              <HardDrive size={14} className="text-purple-400" />
              <span className="text-xs text-gray-500">总数据</span>
            </div>
            <p className="text-xl font-semibold text-gray-200">{formatBytes(stats.totalBytes)}</p>
          </div>
        </div>
      </div>

      {/* 标签页切换 */}
      <div className="flex items-center gap-1 p-2 border-b border-[#2a2a2a]">
        {tabs.map((tab) => {
          const Icon = tab.icon
          return (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id as any)}
              className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm transition-colors ${
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
      </div>

      {/* 内容区域 */}
      <div className="flex-1 overflow-auto p-4">
        {/* 任务列表 */}
        {activeTab === 'tasks' && (
          <div>
            {/* 批量操作工具栏 */}
            {selectedTasks.size > 0 && (
              <div className="flex items-center gap-3 p-3 mb-4 bg-blue-600/10 border border-blue-500/30 rounded-lg">
                <span className="text-sm text-blue-300">
                  已选择 {selectedTasks.size} 个任务
                </span>
                <button
                  onClick={handleBatchDelete}
                  disabled={isDeleting}
                  className="flex items-center gap-2 px-3 py-1.5 bg-red-600 text-white rounded-lg hover:bg-red-500 disabled:opacity-50"
                >
                  <Trash2 size={14} />
                  {isDeleting ? '删除中...' : '批量删除'}
                </button>
                <button
                  onClick={handleBatchExport}
                  className="flex items-center gap-2 px-3 py-1.5 bg-green-600 text-white rounded-lg hover:bg-green-500"
                >
                  <Download size={14} />
                  批量导出
                </button>
                <button
                  onClick={selectAllTasks}
                  className="px-3 py-1.5 text-sm text-gray-400 hover:text-gray-200"
                >
                  {selectedTasks.size === tasks.length ? '取消全选' : '全选'}
                </button>
              </div>
            )}

            {/* 任务列表 */}
            <div className="space-y-3">
              {tasks.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-64 gap-4">
                  <LayoutDashboard size={48} className="text-gray-600" />
                  <p className="text-gray-500">暂无任务</p>
                  <button
                    onClick={() => window.location.hash = '#/new'}
                    className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-500"
                  >
                    创建新任务
                  </button>
                </div>
              ) : (
                tasks.map((task) => (
                  <div key={task.id} className="flex items-start gap-3">
                    <input
                      type="checkbox"
                      checked={selectedTasks.has(task.id)}
                      onChange={() => toggleTaskSelection(task.id)}
                      className="mt-4 w-4 h-4 rounded border-gray-600 text-blue-600 focus:ring-blue-500"
                    />
                    <div className="flex-1">
                      <TaskCard task={task} />
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        )}

        {/* 素材浏览 */}
        {activeTab === 'media' && (
          <MediaBrowser />
        )}

        {/* 统计分析 */}
        {activeTab === 'stats' && (
          <div className="space-y-6">
            <div className="glass-card p-6">
              <h3 className="text-lg font-semibold text-gray-200 mb-4">备份统计</h3>
              <div className="grid grid-cols-2 gap-6">
                <div>
                  <p className="text-sm text-gray-500 mb-2">成功率</p>
                  <div className="flex items-center gap-3">
                    <div className="flex-1 h-2 bg-[#2a2a2a] rounded-full overflow-hidden">
                      <div 
                        className="h-full bg-green-500 rounded-full"
                        style={{ width: `${stats.totalTasks > 0 ? (stats.completedTasks / stats.totalTasks) * 100 : 0}%` }}
                      />
                    </div>
                    <span className="text-sm font-medium text-gray-200">
                      {stats.totalTasks > 0 ? Math.round((stats.completedTasks / stats.totalTasks) * 100) : 0}%
                    </span>
                  </div>
                </div>
                <div>
                  <p className="text-sm text-gray-500 mb-2">数据传输</p>
                  <div className="flex items-center gap-3">
                    <div className="flex-1 h-2 bg-[#2a2a2a] rounded-full overflow-hidden">
                      <div 
                        className="h-full bg-blue-500 rounded-full"
                        style={{ width: `${stats.totalBytes > 0 ? (stats.transferredBytes / stats.totalBytes) * 100 : 0}%` }}
                      />
                    </div>
                    <span className="text-sm font-medium text-gray-200">
                      {formatBytes(stats.transferredBytes)} / {formatBytes(stats.totalBytes)}
                    </span>
                  </div>
                </div>
              </div>
            </div>

            <div className="glass-card p-6">
              <h3 className="text-lg font-semibold text-gray-200 mb-4">任务分布</h3>
              <div className="space-y-3">
                {[
                  { label: '已完成', count: stats.completedTasks, color: 'bg-green-500' },
                  { label: '失败', count: stats.failedTasks, color: 'bg-red-500' },
                  { label: '其他', count: stats.totalTasks - stats.completedTasks - stats.failedTasks, color: 'bg-gray-500' }
                ].map((item) => (
                  <div key={item.label} className="flex items-center gap-3">
                    <div className={`w-3 h-3 rounded-full ${item.color}`} />
                    <span className="text-sm text-gray-400 flex-1">{item.label}</span>
                    <span className="text-sm font-medium text-gray-200">{item.count}</span>
                    <div className="w-32 h-2 bg-[#2a2a2a] rounded-full overflow-hidden">
                      <div 
                        className={`h-full ${item.color} rounded-full`}
                        style={{ width: `${stats.totalTasks > 0 ? (item.count / stats.totalTasks) * 100 : 0}%` }}
                      />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
