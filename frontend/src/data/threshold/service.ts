import { listRows, saveRows } from '../local-store'
import type { EntryRow } from '../types'
import {
  lifecycleLabel,
  loadRegistry,
  THRESHOLD_FIELDS as F,
  THRESHOLD_KEY,
} from './registry'
import {
  LIFECYCLE_LABEL,
  SOURCE_LABEL,
} from './types'
import type {
  ThresholdLevels,
  ThresholdLifecycle,
  ThresholdSource,
  ThresholdVersion,
} from './types'

// 发布、调整、废止三个写入口的唯一通道：先在内存里把整批变更校验完，
// 最后只落一次 saveRows。任何一步不通过都不写库，另一入口正在用的旧版本原样保留。

export type ThresholdDraftInput = {
  code: string
  hazardCode: string
  monitorType: string
  source: ThresholdSource
  configuredAt: string
  effectiveFrom: string
  levels: ThresholdLevels
  operator: string
}

function dateError(value: string, label: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return `${label}无法识别（应为 YYYY-MM-DD）`
  }
  return null
}

function validateLevels(levels: ThresholdLevels): string | null {
  const { notice, warning, alert } = levels
  if (notice === null || warning === null || alert === null) {
    return '三级阈值必须全部填写为数值'
  }
  if (!(notice <= warning && warning <= alert)) {
    return '阈值级别顺序应为 注意级 ≤ 警示级 ≤ 警戒级'
  }
  return null
}

function nextId(rows: EntryRow[]): number {
  return rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
}

function buildRow(
  rows: EntryRow[],
  input: ThresholdDraftInput,
  lifecycle: ThresholdLifecycle,
  effectiveTo: string | null,
): EntryRow {
  const chainVersions = rows.filter(
    (row) =>
      String(row[F.code]) === input.code && String(row[F.monitorType]) === input.monitorType,
  ).length
  return {
    id: nextId(rows),
    status: lifecycleLabel(lifecycle),
    pending: lifecycle === 'draft',
    abnormal: false,
    [F.code]: input.code,
    [F.hazard]: input.hazardCode,
    [F.monitorType]: input.monitorType,
    [F.version]: chainVersions + 1,
    [F.source]: SOURCE_LABEL[input.source],
    [F.configuredAt]: input.configuredAt,
    [F.effectiveFrom]: input.effectiveFrom,
    [F.effectiveTo]: effectiveTo ?? '',
    [F.notice]: input.levels.notice as number,
    [F.warning]: input.levels.warning as number,
    [F.alert]: input.levels.alert as number,
    [F.operator]: input.operator,
  }
}

/** 校验拟生效版本与同配置线已有版本的区间关系的规则内联在 publishThreshold 中，
 * 保证校验始终发生在任何数据改动之前。 */

/**
 * 统一发布：草稿进入生效，同区间旧的现行版本被收口成「已调整」。
 * 人工发布可顶掉自动推荐，反之拒绝。所有校验在原始数据上完成，通过后才一次性写库。
 */
export function publishThreshold(id: number): { ok: boolean; message: string } {
  const rows = listRows(THRESHOLD_KEY)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的阈值版本` }
  }
  const draft = rows[index]
  if (String(draft.status) !== LIFECYCLE_LABEL.draft) {
    return { ok: false, message: '只有草稿版本可以发布，已废止配置不能重复发布' }
  }
  const from = String(draft[F.effectiveFrom])
  if (dateError(from, '生效日期')) {
    return { ok: false, message: dateError(from, '生效日期') as string }
  }
  const levelsError = validateLevels({
    notice: parseLevel(draft[F.notice]),
    warning: parseLevel(draft[F.warning]),
    alert: parseLevel(draft[F.alert]),
  })
  if (levelsError) {
    return { ok: false, message: levelsError }
  }

  const draftSource: ThresholdSource =
    String(draft[F.source]) === SOURCE_LABEL.auto ? 'auto' : 'manual'
  const to = '9999-12-31'

  // 第一步：在完全未改动的 rows 上做区间裁决，任何重叠问题都在写库前给出原因。
  for (const row of rows) {
    if (row.id === draft.id) {
      continue
    }
    if (
      String(row[F.code]) !== String(draft[F.code]) ||
      String(row[F.monitorType]) !== String(draft[F.monitorType])
    ) {
      continue
    }
    if (String(row.status) === LIFECYCLE_LABEL.draft) {
      continue
    }
    const rowFrom = String(row[F.effectiveFrom])
    if (!rowFrom) {
      continue
    }
    const rowTo = String(row[F.effectiveTo] || '') || '9999-12-31'
    const overlap = from < rowTo && rowFrom < to
    if (!overlap) {
      continue
    }
    const rowSource: ThresholdSource =
      String(row[F.source]) === SOURCE_LABEL.auto ? 'auto' : 'manual'
    if (rowSource === 'manual' && draftSource === 'auto') {
      return {
        ok: false,
        message: `该区间已有版本（${row[F.version]}，人工调整，${rowFrom} 起）生效，自动推荐不能覆盖人工调整`,
      }
    }
    if (rowSource === 'auto' && draftSource === 'manual') {
      // 人工顶掉自动：自动版区间仍敞开（无失效日期）时允许接续，并在收口阶段闭合；
      // 自动版区间已有明确终点还包住新生效日，说明是插入历史区间，按冲突拒绝。
      if (!String(row[F.effectiveTo])) {
        continue
      }
      return {
        ok: false,
        message: `自动推荐版本 ${row[F.version]} 的生效区间（${rowFrom} 至 ${rowTo}）包住新版本生效日，无法由人工调整直接覆盖，请先处理该自动版本`,
      }
    }
    return {
      ok: false,
      message: `与版本 ${row[F.version]}（${SOURCE_LABEL[rowSource]}，${rowFrom} 起）生效区间重叠，存在版本冲突`,
    }
  }

  // 第二步：校验全部通过，才构建「旧版收口 + 草稿生效」的整批结果，一次性写库。
  const next = rows.map((row) => {
    if (
      row.id !== draft.id &&
      String(row[F.code]) === String(draft[F.code]) &&
      String(row[F.monitorType]) === String(draft[F.monitorType]) &&
      String(row.status) === LIFECYCLE_LABEL.active &&
      String(row[F.effectiveFrom]) <= from &&
      !String(row[F.effectiveTo])
    ) {
      // 与新版重叠的旧现行版（无论人工还是自动）在生效点收口：
      // 人工顶掉自动推荐时自动版同样收口，绝不留下两个并行版本。
      return { ...row, status: LIFECYCLE_LABEL.superseded, [F.effectiveTo]: from, pending: false }
    }
    return row
  })
  next[index] = { ...draft, status: LIFECYCLE_LABEL.active, pending: false }

  saveRows(THRESHOLD_KEY, next)
  return {
    ok: true,
    message: `阈值 ${draft[F.code]} / ${draft[F.monitorType]} 版本 ${draft[F.version]} 已发布生效`,
  }
}

function parseLevel(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value
  }
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
    return Number(value)
  }
  return null
}

export type AdjustInput = {
  id: number
  configuredAt: string
  effectiveFrom: string
  levels: ThresholdLevels
  operator: string
}

/**
 * 人工调整：基于一个现行版本复制出下一版草稿，原版本在新草稿发布前保持有效。
 * 调整入口与发布入口走同一份版本模型，不会出现「调整后旧版本继续参与计算」之外的双现行。
 */
export function adjustThreshold(input: AdjustInput): { ok: boolean; message: string } {
  const dateProblem = dateError(input.configuredAt, '设定日期') || dateError(input.effectiveFrom, '生效日期')
  if (dateProblem) {
    return { ok: false, message: dateProblem }
  }
  if (input.effectiveFrom < input.configuredAt) {
    return { ok: false, message: '生效日期不能早于设定日期' }
  }
  const levelsError = validateLevels(input.levels)
  if (levelsError) {
    return { ok: false, message: levelsError }
  }

  const rows = listRows(THRESHOLD_KEY)
  const base = rows.find((row) => Number(row.id) === input.id)
  if (!base) {
    return { ok: false, message: `没有找到编号为 ${input.id} 的阈值版本` }
  }
  if (String(base.status) !== LIFECYCLE_LABEL.active) {
    return { ok: false, message: '只能对当前已生效版本发起调整，草稿或已废止版本不能调整' }
  }

  const draft = buildRow(
    rows,
    {
      code: String(base[F.code]),
      hazardCode: String(base[F.hazard]),
      monitorType: String(base[F.monitorType]),
      // 从这个入口建出来的一律是人工调整，自动推荐永远翻不成人工版本以外的优先项。
      source: 'manual',
      configuredAt: input.configuredAt,
      effectiveFrom: input.effectiveFrom,
      levels: input.levels,
      operator: input.operator,
    },
    'draft',
    null,
  )
  saveRows(THRESHOLD_KEY, [...rows, draft])
  return {
    ok: true,
    message: `已基于版本 ${base[F.version]} 生成人工调整草稿（版本 ${draft[F.version]}），发布后旧版本自动收口`,
  }
}

/** 自动推荐入口：只产草稿；想压过人工，必须转人工调整后发布，规则在发布时统一校验。 */
export function recommendThreshold(input: Omit<ThresholdDraftInput, 'source'>): {
  ok: boolean
  message: string
} {
  const dateProblem =
    dateError(input.configuredAt, '设定日期') || dateError(input.effectiveFrom, '生效日期')
  if (dateProblem) {
    return { ok: false, message: dateProblem }
  }
  const levelsError = validateLevels(input.levels)
  if (levelsError) {
    return { ok: false, message: levelsError }
  }
  const rows = listRows(THRESHOLD_KEY)
  const draft = buildRow(rows, { ...input, source: 'auto' }, 'draft', null)
  saveRows(THRESHOLD_KEY, [...rows, draft])
  return {
    ok: true,
    message: `已生成自动推荐草稿（版本 ${draft[F.version]}）；与人工调整重叠时按人工调整执行`,
  }
}

/** 废止：只允许废止现行版本，生效区间在废止日闭合，历史区间仍可追溯。 */
export function revokeThreshold(id: number, revokedAt: string): { ok: boolean; message: string } {
  const dateProblem = dateError(revokedAt, '废止日期')
  if (dateProblem) {
    return { ok: false, message: dateProblem }
  }
  const rows = listRows(THRESHOLD_KEY)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的阈值版本` }
  }
  const current = rows[index]
  if (String(current.status) !== LIFECYCLE_LABEL.active) {
    return { ok: false, message: '只有已生效版本可以废止，草稿或已废止配置不能重复废止' }
  }
  if (revokedAt < String(current[F.effectiveFrom])) {
    return { ok: false, message: '废止日期不能早于该版本生效日期' }
  }
  const next = [...rows]
  next[index] = {
    ...current,
    status: LIFECYCLE_LABEL.revoked,
    [F.effectiveTo]: revokedAt,
    pending: false,
  }
  saveRows(THRESHOLD_KEY, next)
  return { ok: true, message: `版本 ${current[F.version]} 已废止，历史区间保留可追溯` }
}

/** 列表页/其他模块读取用的快照。 */
export function thresholdSnapshot() {
  return loadRegistry()
}

export function describeVersion(version: ThresholdVersion): string {
  return `${version.code} / ${version.monitorType} 版本${version.version}（${SOURCE_LABEL[version.source]}）`
}
