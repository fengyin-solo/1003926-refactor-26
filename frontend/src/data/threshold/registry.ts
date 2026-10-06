import { listRows, saveRows } from '../local-store'
import {
  LIFECYCLE_LABEL,
  SOURCE_LABEL,
} from './types'
import type {
  AlarmLevel,
  ThresholdChain,
  ThresholdEvaluation,
  ThresholdLifecycle,
  ThresholdMeasurement,
  ThresholdResolve,
  ThresholdSource,
  ThresholdVersion,
} from './types'
import type { EntryRow } from '../types'

// 阈值版本的唯一事实来源：列表、发布、调整都从这里读，写也只允许经这里落库。
// 雨量、倾斜、预警发布拿到的判定结果全部由本文件算出，杜绝各自解释。

const KEY = 'threshold'

const FIELD = {
  code: '阈值编号',
  hazard: '隐患点编号',
  monitorType: '监测类型',
  version: '版本号',
  source: '来源',
  configuredAt: '设定日期',
  effectiveFrom: '生效日期',
  effectiveTo: '失效日期',
  notice: '注意级阈值',
  warning: '警示级阈值',
  alert: '警戒级阈值',
  operator: '设定人',
} as const

const LIFECYCLE_BY_STATUS: Record<string, ThresholdLifecycle> = {
  草稿: 'draft',
  已生效: 'active',
  已调整: 'superseded',
  已废止: 'revoked',
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/

function today(): string {
  const now = new Date()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${now.getFullYear()}-${month}-${day}`
}

function isDate(value: unknown): value is string {
  return typeof value === 'string' && DATE_PATTERN.test(value)
}

function parseNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value
  }
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
    return Number(value)
  }
  return null
}

/** 存量行的判定：没带版本号/生效日期的，都是收拢前的旧配置。 */
function isLegacy(row: EntryRow): boolean {
  return row[FIELD.version] === undefined || row[FIELD.effectiveFrom] === undefined
}

/**
 * 存量迁移：缺生效日期时按设定日期落位；没有设定日期的用迁移当天。
 * 迁移直接改持久化对象，并给每个版本补齐版本号，保证只迁移一次。
 * 返回的 rows 已是最新形态，调用方在确有改动时一次性写回（原子落库）。
 */
function migrateLegacy(rows: EntryRow[]): EntryRow[] {
  let changed = false
  const next = rows.map((row) => {
    if (!isLegacy(row)) {
      return row
    }
    changed = true
    const lifecycle = LIFECYCLE_BY_STATUS[String(row.status)] ?? 'draft'
    const configuredAt = isDate(row[FIELD.configuredAt]) ? String(row[FIELD.configuredAt]) : today()
    // 存量配置缺生效日期，一律按设定日期迁移；草稿不占生效区间。
    const effectiveFrom = lifecycle === 'draft' ? '' : configuredAt
    // 已废止的存量版本在设定日期闭合：不能让废止配置继续参与计算，历史区间仍保留。
    const fallbackTo = lifecycle === 'revoked' ? configuredAt : ''
    const migrated: EntryRow = {
      ...row,
      [FIELD.configuredAt]: configuredAt,
      [FIELD.effectiveFrom]: effectiveFrom,
      [FIELD.effectiveTo]: isDate(row[FIELD.effectiveTo]) ? row[FIELD.effectiveTo] : fallbackTo,
      // 历史上的人工配置，来源明确记成人工调整。
      [FIELD.source]: SOURCE_LABEL.manual,
    }
    return migrated
  })

  // 版本号按（阈值编号 + 监测类型）内的设定日期排序补齐；旧的「已调整」行用下一版设定日期收口。
  const groups = new Map<string, EntryRow[]>()
  for (const row of next) {
    const key = `${String(row[FIELD.code])}__${String(row[FIELD.monitorType])}`
    const list = groups.get(key) ?? []
    list.push(row)
    groups.set(key, list)
  }
  for (const list of groups.values()) {
    const ordered = [...list].sort(
      (a, b) =>
        String(a[FIELD.configuredAt]).localeCompare(String(b[FIELD.configuredAt])) ||
        Number(a.id) - Number(b.id),
    )
    ordered.forEach((row, index) => {
      if (row[FIELD.version] === undefined) {
        row[FIELD.version] = index + 1
      }
    })
    ordered.forEach((row, index) => {
      const lifecycle = LIFECYCLE_BY_STATUS[String(row.status)]
      if (lifecycle === 'superseded' && !isDate(row[FIELD.effectiveTo])) {
        const following = ordered
          .slice(index + 1)
          .find((candidate) => LIFECYCLE_BY_STATUS[String(candidate.status)] !== 'draft')
        if (following) {
          row[FIELD.effectiveTo] = String(following[FIELD.configuredAt])
        }
      }
    })
  }

  if (changed) {
    // 迁移与读取共用一次写回，调用方不会看到「迁了一半」的中间态。
    saveRows(KEY, next)
  }
  return next
}

function normalizeVersion(row: EntryRow): ThresholdVersion {
  const code = String(row[FIELD.code] ?? '').trim()
  const monitorType = String(row[FIELD.monitorType] ?? '').trim()
  const version = parseNumber(row[FIELD.version]) ?? 0
  const lifecycle = LIFECYCLE_BY_STATUS[String(row.status)] ?? 'draft'
  const source: ThresholdSource =
    String(row[FIELD.source] ?? '') === SOURCE_LABEL.auto ? 'auto' : 'manual'
  const configuredAt = isDate(row[FIELD.configuredAt]) ? String(row[FIELD.configuredAt]) : ''
  const effectiveFrom = isDate(row[FIELD.effectiveFrom]) ? String(row[FIELD.effectiveFrom]) : ''
  const rawTo = row[FIELD.effectiveTo]
  const effectiveTo = isDate(rawTo) && rawTo !== '' ? String(rawTo) : null

  const issues: string[] = []
  if (!code) {
    issues.push('阈值编号缺失')
  }
  if (!monitorType) {
    issues.push('监测类型缺失')
  }
  if (lifecycle !== 'draft' && !effectiveFrom) {
    issues.push('生效日期缺失或无法识别')
  }
  if (effectiveTo !== null && effectiveFrom !== '' && effectiveTo <= effectiveFrom) {
    issues.push('失效日期不晚于生效日期')
  }
  if (!configuredAt) {
    issues.push('设定日期缺失或无法识别')
  }

  const notice = parseNumber(row[FIELD.notice])
  const warning = parseNumber(row[FIELD.warning])
  const alert = parseNumber(row[FIELD.alert])
  if (notice === null || warning === null || alert === null) {
    issues.push('三级阈值存在无法解析的数值')
  } else if (!(notice <= warning && warning <= alert)) {
    issues.push('阈值级别顺序应为 注意级 ≤ 警示级 ≤ 警戒级')
  }

  return {
    row,
    code,
    monitorType,
    version,
    lifecycle,
    source,
    configuredAt,
    effectiveFrom,
    effectiveTo,
    levels: { notice, warning, alert },
    issues,
  }
}

/** 半开区间 [from, to) 是否在某一天有效。 */
function effectiveOn(version: ThresholdVersion, date: string): boolean {
  if (version.lifecycle === 'draft' || version.effectiveFrom === '') {
    return false
  }
  if (date < version.effectiveFrom) {
    return false
  }
  return version.effectiveTo === null || date < version.effectiveTo
}

/** 区间是否重叠（半开区间）。 */
function overlaps(a: ThresholdVersion, b: ThresholdVersion): boolean {
  if (!a.effectiveFrom || !b.effectiveFrom) {
    return false
  }
  const aTo = a.effectiveTo ?? '9999-12-31'
  const bTo = b.effectiveTo ?? '9999-12-31'
  return a.effectiveFrom < bTo && b.effectiveFrom < aTo
}

export type ThresholdRegistry = {
  chains: ThresholdChain[]
  /** 全量配置问题，列表页顶部统一说明。 */
  issues: string[]
}

/**
 * 收拢全部配置线。同一生效区间里：
 * - 人工调整与自动推荐重叠：自动推荐被压制（人工高于自动），不参与计算；
 * - 同来源两版并存：版本冲突，该区间谁都不参与，必须先处理。
 */
export function loadRegistry(): ThresholdRegistry {
  const rows = migrateLegacy(listRows(KEY))
  const versions = rows.map(normalizeVersion)

  const chainMap = new Map<string, ThresholdVersion[]>()
  for (const version of versions) {
    const key = `${version.code}__${version.monitorType}`
    const list = chainMap.get(key) ?? []
    list.push(version)
    chainMap.set(key, list)
  }

  const chains: ThresholdChain[] = []
  const issues: string[] = []
  for (const [, list] of chainMap) {
    const ordered = [...list].sort((a, b) => a.version - b.version || a.row.id - b.row.id)
    const chainIssues: string[] = []
    const effective = ordered.filter((item) => item.lifecycle !== 'draft')

    for (const version of effective) {
      for (const issue of version.issues) {
        chainIssues.push(`版本 ${version.version}：${issue}`)
      }
    }

    // 自动推荐撞上人工调整：标注被人工压制，解析时直接跳过。
    for (const auto of effective.filter((item) => item.source === 'auto')) {
      const covered = effective.some(
        (manual) =>
          manual !== auto &&
          manual.source === 'manual' &&
          !manual.issues.length &&
          overlaps(auto, manual),
      )
      if (covered) {
        auto.suppressed = true
        chainIssues.push(`版本 ${auto.version}（自动推荐）与人工调整重叠，按人工调整执行`)
      }
    }

    // 同来源并存且区间重叠，就是无法裁决的版本冲突。
    for (let i = 0; i < effective.length; i += 1) {
      for (let j = i + 1; j < effective.length; j += 1) {
        const a = effective[i]
        const b = effective[j]
        if (a.source !== b.source || a.issues.length || b.issues.length) {
          continue
        }
        if (overlaps(a, b)) {
          chainIssues.push(
            `版本 ${a.version} 与版本 ${b.version} 生效区间重叠（同为${SOURCE_LABEL[a.source]}），存在版本冲突`,
          )
        }
      }
    }

    const chain: ThresholdChain = {
      code: ordered[0]?.code ?? '',
      monitorType: ordered[0]?.monitorType ?? '',
      versions: ordered,
      issues: [...new Set(chainIssues)],
    }
    chains.push(chain)
    for (const issue of chain.issues) {
      if (!issue.includes('按人工调整执行')) {
        issues.push(`${chain.code} / ${chain.monitorType}：${issue}`)
      }
    }
  }

  chains.sort((a, b) => a.code.localeCompare(b.code) || a.monitorType.localeCompare(b.monitorType))
  return { chains, issues }
}

function findChain(
  registry: ThresholdRegistry,
  code: string,
  monitorType: string,
): ThresholdChain | undefined {
  return registry.chains.find(
    (chain) => chain.code === code && chain.monitorType === monitorType,
  )
}

/**
 * 按配置线 + 日期解析当时有效的唯一版本。
 * 历史监测按当时阈值解释，取的就是 observedAt 当天的有效版本。
 */
export function resolveChain(
  registry: ThresholdRegistry,
  code: string,
  monitorType: string,
  observedAt: string,
): ThresholdResolve {
  const exact = findChain(registry, code, monitorType)
  let chain = exact
  if (!chain) {
    // 没给阈值编号时，允许在同监测类型里唯一选线；多条可选同样算冲突并说明。
    const sameType = registry.chains.filter((item) => item.monitorType === monitorType)
    if (sameType.length === 1) {
      ;[chain] = sameType
    } else if (sameType.length > 1) {
      return {
        status: 'conflict',
        reason: `监测类型「${monitorType}」存在 ${sameType.length} 条阈值配置线，未指定阈值编号，无法确定适用版本`,
        versions: [],
      }
    }
  }

  if (!chain) {
    return {
      status: 'empty',
      reason: code
        ? `阈值编号 ${code}、监测类型「${monitorType}」没有任何已登记配置`
        : `监测类型「${monitorType}」尚未配置阈值`,
    }
  }

  const candidates = chain.versions.filter(
    (version) =>
      effectiveOn(version, observedAt) &&
      !(version as ThresholdVersion & { suppressed?: boolean }).suppressed,
  )
  if (candidates.length === 0) {
    return {
      status: 'empty',
      reason: `${chain.code} / ${chain.monitorType} 在 ${observedAt} 没有有效版本（草稿、已废止或版本空窗均不参与计算）`,
    }
  }
  if (candidates.length > 1) {
    return {
      status: 'conflict',
      reason: `${chain.code} / ${chain.monitorType} 在 ${observedAt} 同时有 ${candidates.length} 个有效版本，存在版本冲突`,
      versions: candidates,
    }
  }

  const [version] = candidates
  if (version.issues.length) {
    return { status: 'invalid', reason: `${chain.code} / ${chain.monitorType}：${version.issues.join('；')}`, version }
  }
  return { status: 'resolved', version }
}

function classify(version: ThresholdVersion, value: number): AlarmLevel {
  const { notice, warning, alert } = version.levels
  if (alert !== null && value >= alert) {
    return 'alert'
  }
  if (warning !== null && value >= warning) {
    return 'warning'
  }
  if (notice !== null && value >= notice) {
    return 'notice'
  }
  return 'normal'
}

/**
 * 监测数据的统一判定入口：雨量、倾斜、预警发布读的都是这一份结果。
 */
export function evaluateMeasurement(
  registry: ThresholdRegistry,
  measurement: ThresholdMeasurement,
): ThresholdEvaluation {
  if (!isDate(measurement.observedAt)) {
    return { status: 'invalid', reason: '观测日期缺失或无法识别，无法按当时阈值解释' }
  }
  if (!Number.isFinite(measurement.value)) {
    return { status: 'invalid', reason: '监测数值无法解析，不能参与阈值判定' }
  }
  const resolved = resolveChain(registry, measurement.code ?? '', measurement.monitorType, measurement.observedAt)
  if (resolved.status === 'empty') {
    return { status: 'empty', reason: resolved.reason }
  }
  if (resolved.status === 'conflict') {
    return { status: 'conflict', reason: resolved.reason }
  }
  if (resolved.status === 'invalid') {
    return { status: 'invalid', reason: resolved.reason }
  }
  const level = classify(resolved.version, measurement.value)
  const version = resolved.version
  return {
    status: 'evaluated',
    level,
    hit: level !== 'normal',
    version,
    reason: `${version.code} / ${version.monitorType} 版本${version.version}（${SOURCE_LABEL[version.source]}，${version.effectiveFrom} 起生效）判定为「${level === 'normal' ? '未达注意级' : level}」`,
  }
}

/** 供服务层写新行时取生命周期文案。 */
export function lifecycleLabel(lifecycle: ThresholdLifecycle): string {
  return LIFECYCLE_LABEL[lifecycle]
}

export const THRESHOLD_FIELDS = FIELD
export { KEY as THRESHOLD_KEY }
