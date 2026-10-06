import type {
  AlarmLevel,
  ThresholdIssue,
  ThresholdQuery,
  ThresholdResolveResult,
  ThresholdVersion,
} from './types'

/** 阈值系列唯一键：阈值编号 + 监测类型（隐患点随系列登记，不参与分岔）。 */
export function seriesKey(version: Pick<ThresholdVersion, 'thresholdCode' | 'monitorType'>): string {
  return `${version.thresholdCode}@@${version.monitorType}`
}

/** 前一天（YYYY-MM-DD），新老版本衔接时使用，保证日期区间不重不漏。 */
export function dayBefore(date: string): string {
  const parsed = new Date(`${date}T00:00:00`)
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`日期格式无法识别：${date}`)
  }
  parsed.setDate(parsed.getDate() - 1)
  return formatDate(parsed)
}

export function formatDate(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/**
 * 是否为某一时点上参与计算的有效版本。
 * 现行版本当然参与；已被调整的版本在其（已封口的）历史区间内仍是「当时的阈值」，
 * 历史监测据此解释；已废止版本从任一时点剔除。
 */
export function isEffective(version: ThresholdVersion, at: string): boolean {
  if (version.status !== 'active' && version.status !== 'superseded') {
    return false
  }
  return version.effectiveFrom <= at && (version.effectiveTo === null || version.effectiveTo >= at)
}

/** 区间是否重叠：null 结尾表示开放区间。 */
function overlaps(fromA: string, toA: string | null, fromB: string, toB: string | null): boolean {
  return fromA <= (toB ?? '9999-12-31') && fromB <= (toA ?? '9999-12-31')
}

/**
 * 全量体检：同一阈值系列内
 * - 相同来源的有效版本区间重叠 => 冲突版本（必须说明原因并阻断发布/调整）
 * - 人工与自动并行有效 => 仅提示，不阻断（人工调整高于自动推荐）
 */
export function listIssues(versions: ThresholdVersion[]): ThresholdIssue[] {
  const issues: ThresholdIssue[] = []
  const bySeries = new Map<string, ThresholdVersion[]>()
  for (const version of versions) {
    const key = seriesKey(version)
    bySeries.set(key, [...(bySeries.get(key) ?? []), version])
  }
  for (const group of bySeries.values()) {
    const active = group.filter((item) => item.status === 'active')
    for (let i = 0; i < active.length; i += 1) {
      for (let j = i + 1; j < active.length; j += 1) {
        const a = active[i]
        const b = active[j]
        if (!overlaps(a.effectiveFrom, a.effectiveTo, b.effectiveFrom, b.effectiveTo)) {
          continue
        }
        const common = {
          thresholdCode: a.thresholdCode,
          hazardCode: a.hazardCode,
          monitorType: a.monitorType,
        }
        if (a.source === b.source) {
          issues.push({
            ...common,
            level: 'conflict',
            reason: `版本 v${a.seq} 与 v${b.seq} 同为${SOURCE_LABELS[a.source]}且生效区间重叠（分别自 ${a.effectiveFrom}、${b.effectiveFrom} 起），无法确定以哪份为准，请人工保留其一`,
          })
        } else {
          const manual = a.source === 'manual' ? a : b
          const auto = a.source === 'auto' ? a : b
          issues.push({
            ...common,
            level: 'note',
            reason: `自动推荐 v${auto.seq} 与人工设定 v${manual.seq} 并行有效，按「人工调整高于自动推荐」以 v${manual.seq} 为准`,
          })
        }
      }
    }
  }
  return issues
}

/** 监测值对照级别：达到哪一级阈值就归入哪一级。 */
export function classify(version: ThresholdVersion, value: number): AlarmLevel {
  if (value >= version.alarm) {
    return 'alarm'
  }
  if (value >= version.warning) {
    return 'warning'
  }
  if (value >= version.attention) {
    return 'attention'
  }
  return 'normal'
}

/**
 * 唯一的阈值解释口径。雨量、倾斜、预警发布都通过它取得「当时」的阈值。
 * 优先级：阈值编号命中 > 隐患点编号命中 > 仅监测类型兜底；同候选项人工高于自动，
 * 同源多版本冲突直接返回 conflict，不猜一个版本参与计算。
 */
export function resolveThreshold(
  versions: ThresholdVersion[],
  query: ThresholdQuery,
): ThresholdResolveResult {
  const scoped = versions.filter((item) => item.monitorType === query.monitorType)
  const conflicts = listIssues(versions).filter(
    (issue) =>
      issue.level === 'conflict' &&
      issue.monitorType === query.monitorType &&
      (!query.thresholdCode || issue.thresholdCode === query.thresholdCode),
  )
  const inType = scoped.filter((item) => isEffective(item, query.at))
  if (inType.length === 0) {
    return { kind: 'empty', reason: emptyReason(versions, query) }
  }

  let candidates = inType
  if (query.thresholdCode) {
    const byCode = candidates.filter((item) => item.thresholdCode === query.thresholdCode)
    if (byCode.length > 0) {
      candidates = byCode
    }
  }
  if (query.hazardCode) {
    const byHazard = candidates.filter((item) => item.hazardCode === query.hazardCode)
    if (byHazard.length > 0) {
      candidates = byHazard
    }
  }

  // 候选集合自身存在同源冲突：必须显式说明，绝不挑一个参与计算。
  const manual = candidates.filter((item) => item.source === 'manual')
  const auto = candidates.filter((item) => item.source === 'auto')
  const chosenPool = manual.length > 0 ? manual : auto
  if (chosenPool.length > 1 || conflicts.length > 0) {
    const clash = chosenPool.length > 1 ? chosenPool : inType
    const reason =
      chosenPool.length > 1
        ? `「${query.monitorType}」在 ${query.at} 命中 ${chosenPool.length} 份同源有效阈值（${chosenPool
            .map((item) => `v${item.seq}`)
            .join('、')}），生效区间重叠，无法确定以哪份为准`
        : conflicts.map((item) => item.reason).join('；')
    return { kind: 'conflict', reason, versions: clash }
  }
  if (chosenPool.length === 0) {
    return { kind: 'empty', reason: emptyReason(versions, query) }
  }

  const version = chosenPool[0]
  const level = query.value === undefined ? 'normal' : classify(version, query.value)
  let note: string | undefined
  if (manual.length > 0 && auto.length > 0) {
    const autoSeqs = auto.map((item) => `v${item.seq}`).join('、')
    note = `并行存在自动推荐 ${autoSeqs}，按人工调整高于自动推荐，采用人工版本 v${version.seq}`
  }
  return { kind: 'ok', version, level, note }
}

function emptyReason(versions: ThresholdVersion[], query: ThresholdQuery): string {
  const known = versions.filter((item) => item.monitorType === query.monitorType)
  if (known.length === 0) {
    return `「${query.monitorType}」从未配置过阈值，空配置无法判定，请先登记并发布阈值`
  }
  if (known.every((item) => item.status === 'abolished' || item.status === 'superseded')) {
    const abolished = known.filter((item) => item.status === 'abolished')
    const tail = abolished.length ? '，原版本均已废止' : '，原版本已被新版本取代'
    return `「${query.monitorType}」在 ${query.at} 没有生效中的阈值${tail}，请发布新版本后再计算`
  }
  if (
    known.every(
      (item) => item.effectiveFrom > query.at || (item.effectiveTo !== null && item.effectiveTo < query.at),
    )
  ) {
    return `「${query.monitorType}」已配置的阈值均不覆盖 ${query.at}，历史监测只能按当时阈值解释，该时点无适用版本`
  }
  const draft = known.filter((item) => item.status === 'draft')
  if (draft.length > 0) {
    return `「${query.monitorType}」仅有草稿（v${draft
      .map((item) => item.seq)
      .join('、')}）尚未发布生效，不能参与计算`
  }
  return `「${query.monitorType}」在 ${query.at} 没有可适用的阈值版本，请核对监测类型与生效日期`
}

export const SOURCE_LABELS: Record<ThresholdVersion['source'], string> = {
  manual: '人工设定',
  auto: '自动推荐',
}

export const STATUS_LABELS: Record<ThresholdVersion['status'], string> = {
  draft: '草稿',
  active: '已生效',
  superseded: '已调整',
  abolished: '已废止',
}

export const LEVEL_LABELS: Record<AlarmLevel, string> = {
  normal: '正常',
  attention: '注意级',
  warning: '警示级',
  alarm: '警戒级',
}

export function sourceLabel(source: ThresholdVersion['source']): string {
  return SOURCE_LABELS[source]
}

export function nextSeq(versions: ThresholdVersion[], code: string, monitorType: string): number {
  const used = versions
    .filter((item) => item.thresholdCode === code && item.monitorType === monitorType)
    .reduce((max, item) => Math.max(max, item.seq), 0)
  return used + 1
}

/** 同系列是否已存在同源冲突；冲突未解决前拒绝再发布/调整。 */
export function findSeriesConflict(
  versions: ThresholdVersion[],
  code: string,
  monitorType: string,
): ThresholdIssue | undefined {
  return listIssues(versions).find(
    (issue) =>
      issue.level === 'conflict' &&
      issue.thresholdCode === code &&
      issue.monitorType === monitorType,
  )
}
