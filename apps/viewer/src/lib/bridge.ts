// The viewer's own commands (apps/viewer/src-tauri/src/commands.rs).

import { invoke } from '@tauri-apps/api/core'
import type { ExifInfo } from './exif'

export interface FileStat {
  path: string
  name: string
  size: number
  modified: number
  exists: boolean
}

export interface ImageInfo {
  stat: FileStat
  exif: ExifInfo | null
}

export interface ComicListing {
  pages: string[]
  source: string
}

export interface RecentDoc {
  path: string
  name: string
  mime: string | null
  opened: number
  size: number
}

export const storeRead = (name: string) => invoke<unknown>('store_read', { name })
export const storeWrite = (name: string, value: unknown) =>
  invoke<null>('store_write', { name, value })
export const fileStat = (path: string) => invoke<FileStat>('file_stat', { path })
export const folderImages = (path: string) => invoke<string[]>('folder_images', { path })
export const imageInfo = (path: string) => invoke<ImageInfo>('image_info', { path })
export const trashFile = (path: string) => invoke<null>('trash_file', { path })
export const openExternal = (url: string) => invoke<null>('open_external', { url })
export const setWallpaper = (path: string) => invoke<null>('set_wallpaper', { path })
export const copyImage = (path: string, mime: string) => invoke<null>('copy_image', { path, mime })
export const comicList = (path: string) => invoke<ComicListing>('comic_list', { path })
export const recentDocuments = (limit?: number) =>
  invoke<RecentDoc[]>('recent_documents', { limit: limit ?? null })

export async function comicPage(path: string, name: string, source: string): Promise<Blob> {
  const bytes = await invoke<ArrayBuffer>('comic_page', { path, name, source })
  return new Blob([bytes])
}

export async function saveBytes(path: string, bytes: Uint8Array): Promise<void> {
  await invoke<null>('save_bytes', bytes, { headers: { path: encodeURIComponent(path) } })
}
