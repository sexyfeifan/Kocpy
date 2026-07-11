import { useState, useEffect, useCallback } from 'react'
import { Search, Grid, List, Film, Image, FileVideo, Folder, X, Play, Info } from 'lucide-react'
import type { MediaMetadata } from '../types'

interface MediaBrowserProps {
  sourcePath?: string
  onSelect?: (file: MediaMetadata) => void
  onPreview?: (file: MediaMetadata) => void
}

export function MediaBrowser({ sourcePath, onSelect, onPreview }: MediaBrowserProps) {
  const [files, setFiles] = useState<MediaMetadata[]>([])
  const [filteredFiles, setFilteredFiles] = useState<MediaMetadata[]>([])
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid')
  const [searchQuery, setSearchQuery] = useState('')
  const [selectedFile, setSelectedFile] = useState<MediaMetadata | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [showPreview, setShowPreview] = useState(false)

  // 加载文件列表
  useEffect(() => {
    if (!sourcePath) return

    const loadFiles = async () => {
      setIsLoading(true)
      try {
        // 这里应该调用 IPC 获取文件列表
        // const result = await window.api.listMediaFiles(sourcePath)
        // if (result.success) {
        //   setFiles(result.files)
        //   setFilteredFiles(result.files)
        // }
        
        // 临时使用模拟数据
        const mockFiles: MediaMetadata[] = [
          {
            fileName: 'A001_C001_0101.mov',
            filePath: '/Volumes/TestCard/DCIM/A001_C001_0101.mov',
            fileSize: 1073741824,
            fileType: 'QuickTime Movie',
            mimeType: 'video/quicktime',
            duration: 120.5,
            frameRate: 23.976,
            resolution: { width: 4096, height: 2160 },
            codec: 'ProRes 422 HQ',
            camera: {
              manufacturer: 'ARRI',
              model: 'ALEXA 35',
              serialNumber: 'K1.0000001'
            },
            exposure: {
              iso: 800,
              shutter: '1/48',
              aperture: '2.8'
            },
            metadata: {}
          },
          // 更多模拟文件...
        ]
        
        setFiles(mockFiles)
        setFilteredFiles(mockFiles)
      } catch (err) {
        console.error('Failed to load files:', err)
      } finally {
        setIsLoading(false)
      }
    }

    loadFiles()
  }, [sourcePath])

  // 搜索过滤
  useEffect(() => {
    if (!searchQuery.trim()) {
      setFilteredFiles(files)
      return
    }

    const query = searchQuery.toLowerCase()
    const filtered = files.filter(file =>
      file.fileName.toLowerCase().includes(query) ||
      file.camera?.model?.toLowerCase().includes(query) ||
      file.camera?.manufacturer?.toLowerCase().includes(query)
    )
    setFilteredFiles(filtered)
  }, [searchQuery, files])

  // 处理文件选择
  const handleFileSelect = useCallback((file: MediaMetadata) => {
    setSelectedFile(file)
    onSelect?.(file)
  }, [onSelect])

  // 处理预览
  const handlePreview = useCallback((file: MediaMetadata) => {
    setSelectedFile(file)
    setShowPreview(true)
    onPreview?.(file)
  }, [onPreview])

  // 格式化文件大小
  const formatFileSize = (bytes: number): string => {
    const units = ['B', 'KB', 'MB', 'GB', 'TB']
    let unitIndex = 0
    let size = bytes

    while (size >= 1024 && unitIndex < units.length - 1) {
      size /= 1024
      unitIndex++
    }

    return `${size.toFixed(2)} ${units[unitIndex]}`
  }

  // 格式化时长
  const formatDuration = (seconds: number): string => {
    const hours = Math.floor(seconds / 3600)
    const minutes = Math.floor((seconds % 3600) / 60)
    const secs = Math.floor(seconds % 60)

    if (hours > 0) {
      return `${hours}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`
    }
    return `${minutes}:${secs.toString().padStart(2, '0')}`
  }

  // 获取文件图标
  const getFileIcon = (file: MediaMetadata) => {
    if (file.mimeType?.startsWith('video/')) {
      return <FileVideo size={20} className="text-blue-400" />
    }
    if (file.mimeType?.startsWith('image/')) {
      return <Image size={20} className="text-green-400" />
    }
    return <FileVideo size={20} className="text-gray-400" />
  }

  return (
    <div className="flex flex-col h-full bg-[#0a0a0a]">
      {/* 工具栏 */}
      <div className="flex items-center gap-3 p-4 border-b border-[#2a2a2a]">
        {/* 搜索框 */}
        <div className="flex-1 relative">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="搜索文件名、摄影机型号..."
            className="w-full pl-10 pr-4 py-2 bg-[#111] border border-[#2a2a2a] rounded-lg text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-blue-500"
          />
          {searchQuery && (
            <button
              onClick={() => setSearchQuery('')}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-300"
            >
              <X size={14} />
            </button>
          )}
        </div>

        {/* 视图切换 */}
        <div className="flex gap-1 p-1 bg-[#111] rounded-lg">
          <button
            onClick={() => setViewMode('grid')}
            className={`p-2 rounded ${viewMode === 'grid' ? 'bg-blue-600 text-white' : 'text-gray-500 hover:text-gray-300'}`}
          >
            <Grid size={16} />
          </button>
          <button
            onClick={() => setViewMode('list')}
            className={`p-2 rounded ${viewMode === 'list' ? 'bg-blue-600 text-white' : 'text-gray-500 hover:text-gray-300'}`}
          >
            <List size={16} />
          </button>
        </div>

        {/* 文件计数 */}
        <span className="text-xs text-gray-500">
          {filteredFiles.length} / {files.length} 个文件
        </span>
      </div>

      {/* 文件列表 */}
      <div className="flex-1 overflow-auto p-4">
        {isLoading ? (
          <div className="flex items-center justify-center h-full">
            <div className="text-gray-500">加载中...</div>
          </div>
        ) : filteredFiles.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full gap-2">
            <Folder size={48} className="text-gray-600" />
            <p className="text-gray-500">暂无文件</p>
          </div>
        ) : viewMode === 'grid' ? (
          /* 网格视图 */
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4">
            {filteredFiles.map((file) => (
              <div
                key={file.filePath}
                onClick={() => handleFileSelect(file)}
                onDoubleClick={() => handlePreview(file)}
                className={`group relative bg-[#111] border rounded-xl overflow-hidden cursor-pointer transition-all hover:border-blue-500 ${
                  selectedFile?.filePath === file.filePath ? 'border-blue-500 ring-2 ring-blue-500/20' : 'border-[#2a2a2a]'
                }`}
              >
                {/* 缩略图区域 */}
                <div className="aspect-video bg-[#0d0d0d] flex items-center justify-center">
                  {getFileIcon(file)}
                </div>

                {/* 文件信息 */}
                <div className="p-3">
                  <p className="text-xs font-medium text-gray-200 truncate">{file.fileName}</p>
                  <p className="text-[10px] text-gray-500 mt-1">{formatFileSize(file.fileSize)}</p>
                  {file.duration && (
                    <p className="text-[10px] text-gray-500">{formatDuration(file.duration)}</p>
                  )}
                </div>

                {/* 悬浮操作 */}
                <div className="absolute inset-0 bg-black/60 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center gap-2">
                  <button
                    onClick={(e) => { e.stopPropagation(); handlePreview(file) }}
                    className="p-2 bg-blue-600 rounded-lg text-white hover:bg-blue-500 transition-colors"
                  >
                    <Play size={16} />
                  </button>
                  <button
                    onClick={(e) => { e.stopPropagation(); handleFileSelect(file) }}
                    className="p-2 bg-gray-700 rounded-lg text-white hover:bg-gray-600 transition-colors"
                  >
                    <Info size={16} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        ) : (
          /* 列表视图 */
          <div className="space-y-2">
            {filteredFiles.map((file) => (
              <div
                key={file.filePath}
                onClick={() => handleFileSelect(file)}
                onDoubleClick={() => handlePreview(file)}
                className={`flex items-center gap-4 p-3 bg-[#111] border rounded-lg cursor-pointer transition-all hover:border-blue-500 ${
                  selectedFile?.filePath === file.filePath ? 'border-blue-500 ring-2 ring-blue-500/20' : 'border-[#2a2a2a]'
                }`}
              >
                {getFileIcon(file)}
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-gray-200 truncate">{file.fileName}</p>
                  <p className="text-xs text-gray-500">{file.camera?.manufacturer} {file.camera?.model}</p>
                </div>
                <div className="text-right">
                  <p className="text-xs text-gray-400">{formatFileSize(file.fileSize)}</p>
                  {file.duration && (
                    <p className="text-xs text-gray-500">{formatDuration(file.duration)}</p>
                  )}
                </div>
                {file.resolution && (
                  <span className="px-2 py-1 text-[10px] bg-blue-600/20 text-blue-400 rounded">
                    {file.resolution.width}x{file.resolution.height}
                  </span>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 文件详情面板 */}
      {selectedFile && (
        <div className="w-80 border-l border-[#2a2a2a] p-4 overflow-auto">
          <h3 className="text-sm font-semibold text-gray-200 mb-4">文件详情</h3>
          
          <div className="space-y-4">
            {/* 基础信息 */}
            <div>
              <h4 className="text-xs font-medium text-gray-500 uppercase mb-2">基础信息</h4>
              <div className="space-y-2 text-xs">
                <div className="flex justify-between">
                  <span className="text-gray-500">文件名</span>
                  <span className="text-gray-200">{selectedFile.fileName}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-500">大小</span>
                  <span className="text-gray-200">{formatFileSize(selectedFile.fileSize)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-500">类型</span>
                  <span className="text-gray-200">{selectedFile.fileType}</span>
                </div>
                {selectedFile.duration && (
                  <div className="flex justify-between">
                    <span className="text-gray-500">时长</span>
                    <span className="text-gray-200">{formatDuration(selectedFile.duration)}</span>
                  </div>
                )}
              </div>
            </div>

            {/* 摄影机信息 */}
            {selectedFile.camera && (
              <div>
                <h4 className="text-xs font-medium text-gray-500 uppercase mb-2">摄影机</h4>
                <div className="space-y-2 text-xs">
                  <div className="flex justify-between">
                    <span className="text-gray-500">厂商</span>
                    <span className="text-gray-200">{selectedFile.camera.manufacturer}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-500">型号</span>
                    <span className="text-gray-200">{selectedFile.camera.model}</span>
                  </div>
                  {selectedFile.camera.serialNumber && (
                    <div className="flex justify-between">
                      <span className="text-gray-500">序列号</span>
                      <span className="text-gray-200">{selectedFile.camera.serialNumber}</span>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* 拍摄参数 */}
            {selectedFile.exposure && (
              <div>
                <h4 className="text-xs font-medium text-gray-500 uppercase mb-2">拍摄参数</h4>
                <div className="space-y-2 text-xs">
                  {selectedFile.exposure.iso && (
                    <div className="flex justify-between">
                      <span className="text-gray-500">ISO</span>
                      <span className="text-gray-200">{selectedFile.exposure.iso}</span>
                    </div>
                  )}
                  {selectedFile.exposure.aperture && (
                    <div className="flex justify-between">
                      <span className="text-gray-500">光圈</span>
                      <span className="text-gray-200">{selectedFile.exposure.aperture}</span>
                    </div>
                  )}
                  {selectedFile.exposure.shutter && (
                    <div className="flex justify-between">
                      <span className="text-gray-500">快门</span>
                      <span className="text-gray-200">{selectedFile.exposure.shutter}</span>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* 预览模态框 */}
      {showPreview && selectedFile && (
        <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50">
          <div className="relative w-full max-w-4xl bg-[#111] rounded-xl overflow-hidden">
            <button
              onClick={() => setShowPreview(false)}
              className="absolute top-4 right-4 p-2 bg-gray-800 rounded-lg text-gray-400 hover:text-white z-10"
            >
              <X size={20} />
            </button>
            
            <div className="aspect-video bg-black flex items-center justify-center">
              <Play size={64} className="text-gray-600" />
            </div>
            
            <div className="p-4">
              <h3 className="text-lg font-semibold text-gray-200">{selectedFile.fileName}</h3>
              <p className="text-sm text-gray-500">{selectedFile.camera?.manufacturer} {selectedFile.camera?.model}</p>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
