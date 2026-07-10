export interface DriveInfo { total: number; free: number; used: number }

export interface DestRow {
  id: string
  path: string
  driveInfo: DriveInfo | null
}

export type Mode = 'card' | 'mirror' | 'project'
