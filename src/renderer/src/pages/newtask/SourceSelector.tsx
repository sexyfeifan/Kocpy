import { FolderOpen, CheckCircle, Zap, HardDrive, RefreshCw } from 'lucide-react'
import type { VolumeInfo } from '../../types'
import type { DestRow, Mode } from './shared'
import { formatBytes } from '../../utils'

interface Props {
  mode: Mode
  sourcePath: string
  setSourcePath: (p: string) => void
  sourceTab: 'card' | 'custom'
  setSourceTab: (t: 'card' | 'custom') => void
  detectedSources: VolumeInfo[]
  autoDetected: boolean
  setAutoDetected: (v: boolean) => void
  setVolumePrefix: (v: string) => void
  fx3Rename: boolean
  setFx3Rename: (v: (prev: boolean) => boolean) => void
}

export function SourceSelector({
  mode, sourcePath, setSourcePath, sourceTab, setSourceTab,
  detectedSources, autoDetected, setAutoDetected,
  setVolumePrefix, fx3Rename, setFx3Rename
}: Props): JSX.Element {
  const isMirror = mode === 'mirror'

  const pickVolume = async (vol: VolumeInfo) => {
    const picked = await window.api.selectDirectory(vol.path)
    if (!picked) return
    setSourcePath(picked)
    const m = picked.match(/^\/Volumes\/([^/]+)/)
    const n = (m ? m[1] : (picked.split('/').pop() || 'Untitled')).replace(/_\d{12}$/, '')
    setVolumePrefix(n)
    setAutoDetected(true)
  }

  const selectSource = async () => {
    const p = await window.api.selectDirectory()
    if (!p) return
    setSourcePath(p)
    setAutoDetected(false)
    const volumeMatch = p.match(/^\/Volumes\/([^/]+)/)
    const volName = (volumeMatch ? volumeMatch[1] : (p.split('/').pop() || 'Untitled'))
      .replace(/_\d{12}$/, '')
    setVolumePrefix(volName)
  }

  return (
    <div className="glass-card p-5">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <HardDrive size={14} className="text-gray-400" />
          <label className="text-xs font-semibold text-gray-400 uppercase tracking-wider">数据源</label>
          {autoDetected && sourcePath && (
            <span className="flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-400 border border-amber-500/25 font-semibold">
              <Zap size={9} />自动识别
            </span>
          )}
        </div>
        {sourcePath && (
          <button
            onClick={() => { setSourcePath(''); setAutoDetected(false); setVolumePrefix('Untitled') }}
            className="text-xs text-gray-600 hover:text-gray-300 transition-colors px-2 py-0.5 rounded-lg hover:bg-white/5"
          >清除</button>
        )}
      </div>

      <div className="flex gap-0 mb-4 border-b border-[#2a2a2a]">
        {(['card', 'custom'] as const).map((tab) => (
          <button
            key={tab}
            onClick={() => setSourceTab(tab)}
            className={`px-4 py-2 text-xs font-medium transition-all border-b-2 -mb-px ${
              sourceTab === tab
                ? isMirror
                  ? 'border-purple-500 text-purple-400'
                  : 'border-blue-500 text-blue-400'
                : 'border-transparent text-gray-500 hover:text-gray-300'
            }`}
          >{tab === 'card' ? '素材卡' : '自定义'}</button>
        ))}
      </div>

      {sourceTab === 'card' ? (
        <div>
          {detectedSources.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-2 py-6 rounded-xl border border-dashed border-[#2a2a2a] text-center">
              <HardDrive size={22} className="text-gray-700" />
              <p className="text-xs text-gray-600">未检测到素材卡</p>
              <p className="text-[11px] text-gray-700">支持 SD · CFexpress Type A/B · CFast · CF · SxS · XQD</p>
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              {detectedSources.map((vol) => {
                const isSelected = sourcePath === vol.path
                return (
                  <button
                    key={vol.path}
                    onClick={() => pickVolume(vol)}
                    className={`w-full text-left flex items-center gap-3 px-4 py-3.5 rounded-xl border transition-all ${
                      isSelected
                        ? isMirror
                          ? 'bg-purple-600/10 border-purple-500/30'
                          : 'bg-blue-600/10 border-blue-500/30'
                        : 'bg-[#111] border-[#2a2a2a] hover:border-[#3a3a3a] hover:bg-white/[0.03]'
                    }`}
                  >
                    <div className={`w-10 h-10 rounded-lg flex items-center justify-center shrink-0 ${
                      isSelected ? isMirror ? 'bg-purple-600/20' : 'bg-blue-600/20' : 'bg-[#1a1a1a]'
                    }`}>
                      <FolderOpen size={18} className={isSelected ? isMirror ? 'text-purple-400' : 'text-blue-400' : 'text-gray-500'} />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className={`text-sm font-semibold truncate ${isSelected ? isMirror ? 'text-purple-200' : 'text-blue-200' : 'text-gray-200'}`}>
                        {vol.name}
                      </p>
                      {vol.total != null && vol.total > 0 && (
                        <p className="text-xs text-gray-500 mt-0.5">{formatBytes(vol.total)}</p>
                      )}
                    </div>
                    {isSelected && (
                      <CheckCircle size={15} className={isMirror ? 'text-purple-400 shrink-0' : 'text-blue-400 shrink-0'} />
                    )}
                  </button>
                )
              })}
            </div>
          )}
          {sourcePath && !detectedSources.find((v) => v.path === sourcePath) && (
            <div className={`mt-2 px-3 py-2.5 rounded-xl border ${isMirror ? 'bg-purple-600/8 border-purple-500/20' : 'bg-blue-600/8 border-blue-500/20'}`}>
              <p className={`text-xs font-mono break-all ${isMirror ? 'text-purple-300/70' : 'text-blue-300/70'}`}>{sourcePath}</p>
            </div>
          )}
        </div>
      ) : (
        <div>
          <button
            onClick={selectSource}
            className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl border transition-all text-sm ${
              sourcePath
                ? isMirror ? 'bg-purple-600/10 border-purple-500/30 text-purple-300' : 'bg-blue-600/10 border-blue-500/30 text-blue-300'
                : 'bg-[#111] border-[#2a2a2a] text-gray-500 hover:border-[#444] hover:text-gray-400 border-dashed'
            }`}
          >
            <FolderOpen size={16} className="shrink-0" />
            <span className="truncate text-left flex-1">{sourcePath || '点击选择文件夹...'}</span>
          </button>
          {sourcePath && <p className="text-xs text-gray-600 mt-1.5 font-mono break-all">{sourcePath}</p>}
        </div>
      )}

      {mode === 'card' && (
        <label className="flex items-center justify-between cursor-pointer mt-3 pt-3 border-t border-[#1e1e1e]">
          <div>
            <p className="text-xs text-gray-300">FX3 备份重命名</p>
            <p className="text-[11px] text-gray-600 mt-0.5">备份前将 Untitled 文件夹按视频前缀重命名</p>
          </div>
          <div
            onClick={() => setFx3Rename((v) => !v)}
            className={`relative w-9 h-5 rounded-full transition-colors shrink-0 ${fx3Rename ? 'bg-blue-600' : 'bg-[#2a2a2a]'}`}
          >
            <div className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-all ${fx3Rename ? 'left-4' : 'left-0.5'}`} />
          </div>
        </label>
      )}
    </div>
  )
}
