import { listRows } from '@/data/local-store'

import { buildSeedThresholdVersions, migrateLegacyThreshold } from './seed'
import type { ThresholdVersion } from './types'

// 阈值版本独立存放：列表、发布、调整以及雨量/倾斜/预警发布只读这一份结果。
const STORAGE_KEY = 'geohazard-monitor-prevention:threshold-versions:v1'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

/**
 * 首次装载时的种子：
 * 新版示例数据自带「缺生效日期」的存量记录，直接走迁移并补齐版本链；
 * 老浏览器里残留的台账形态阈值同样按存量配置迁移。
 */
function seedVersions(): ThresholdVersion[] {
  const legacy = listRows('threshold')
  const migrated = legacy.map(migrateLegacyThreshold)
  const codes = migrated.map((item) => item.thresholdCode).sort()
  const isBundledLegacy = JSON.stringify(codes) === JSON.stringify(['THRE-0001', 'THRE-0002', 'THRE-0003', 'THRE-0004'])
  if (isBundledLegacy) {
    return buildSeedThresholdVersions()
  }
  return migrated
}

function readStorage(): ThresholdVersion[] {
  if (typeof window === 'undefined' || !window.localStorage) {
    return seedVersions()
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    const seeded = seedVersions()
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(seeded))
    return seeded
  }
  try {
    return JSON.parse(raw) as ThresholdVersion[]
  } catch {
    const seeded = seedVersions()
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(seeded))
    return seeded
  }
}

let cache: ThresholdVersion[] | null = null

export function listVersions(): ThresholdVersion[] {
  if (cache === null) {
    cache = readStorage()
  }
  return cache
}

/**
 * 唯一写入点：服务层先在内存里完成「关闭旧版本 + 写入新版本 + 冲突校验」整套变更，
 * 校验通过才整体落盘；任一步失败都不会写，任何入口都不可能留下半截旧版本。
 */
export function commitVersions(next: ThresholdVersion[]): void {
  cache = next
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  }
}

export function resetVersions(): ThresholdVersion[] {
  const seeded = buildSeedThresholdVersions()
  commitVersions(seeded)
  return seeded
}

export function versionsStorageKey(): string {
  return STORAGE_KEY
}

export function cloneVersions(versions: ThresholdVersion[] = listVersions()): ThresholdVersion[] {
  return clone(versions)
}
