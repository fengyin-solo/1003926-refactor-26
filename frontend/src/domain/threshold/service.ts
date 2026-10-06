import type { ActionResult } from '@/data/types'

import {
  STATUS_LABELS,
  dayBefore,
  findSeriesConflict,
  formatDate,
  listIssues,
  nextSeq,
  seriesKey,
} from './logic'
import type { ThresholdVersion } from './types'
import { cloneVersions, commitVersions, listVersions, resetVersions } from './store'

/** 统一返回结构与既有业务动作保持一致，页面层不用分叉。 */
export type ThresholdActionResult = ActionResult

function fail(message: string): ThresholdActionResult {
  return { ok: false, message }
}

function today(): string {
  return formatDate(new Date())
}

function validateValues(input: {
  attention: number
  warning: number
  alarm: number
}): string | null {
  const { attention, warning, alarm } = input
  if ([attention, warning, alarm].some((value) => !Number.isFinite(value))) {
    return '三级阈值都必须是数字'
  }
  if (!(attention < warning && warning < alarm)) {
    return '阈值需满足 注意级 < 警示级 < 警戒级'
  }
  return null
}

function validDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(new Date(`${value}T00:00:00`).getTime())
}

/** 列表入口：所有版本按系列、版本序号排列，状态原样呈现（含草稿/已废止）。 */
export function listThresholdVersions(): ThresholdVersion[] {
  return [...listVersions()].sort((a, b) => {
    const key = seriesKey(a).localeCompare(seriesKey(b))
    if (key !== 0) {
      return key
    }
    return a.seq - b.seq
  })
}

/** 看板入口：冲突与并行来源都在此说明，调用方不用各自再扫一遍。 */
export function listThresholdIssues() {
  return listIssues(listVersions())
}

/**
 * 发布入口（仅草稿可发布）：
 * 已废止配置不允许再发布；系列存在未解决的同源冲突时阻断，防止再加一份并行版本。
 */
export function publishThreshold(
  id: number,
  effectiveFrom: string = today(),
): ThresholdActionResult {
  if (!validDate(effectiveFrom)) {
    return fail(`生效日期 ${effectiveFrom} 格式不正确，应为 YYYY-MM-DD`)
  }
  const versions = listVersions()
  const draft = versions.find((item) => item.id === id)
  if (!draft) {
    return fail(`没有找到编号为 ${id} 的阈值版本`)
  }
  if (draft.status === 'abolished') {
    return fail('该配置已废止，不能重新发布；如需恢复请基于现行配置调整出新版本')
  }
  if (draft.status !== 'draft') {
    return fail(`版本当前为「${STATUS_LABELS[draft.status]}」，只有草稿才能发布`)
  }
  const conflict = findSeriesConflict(versions, draft.thresholdCode, draft.monitorType)
  if (conflict) {
    return fail(`存在冲突版本，发布已阻断：${conflict.reason}`)
  }

  const candidate: ThresholdVersion = {
    ...draft,
    status: 'active',
    effectiveFrom,
    effectiveTo: null,
    updatedAt: today(),
  }
  // 发布后先在内存里验证是否与现行同来源版本区间重叠，不重叠才落盘。
  const trial = versions.map((item) => (item.id === id ? candidate : item))
  const overlap = findSeriesConflict(trial, draft.thresholdCode, draft.monitorType)
  if (overlap) {
    return fail(`发布后会与现行版本区间重叠，已拒绝：${overlap.reason}`)
  }
  commitVersions(trial)
  return {
    ok: true,
    message: `${draft.thresholdCode}（${draft.monitorType}）v${draft.seq} 已发布，自 ${effectiveFrom} 起生效`,
  }
}

export interface AdjustThresholdInput {
  attention: number
  warning: number
  alarm: number
  /** 新生效日期；默认次日，避免与现行版本产生同日重叠。 */
  effectiveFrom?: string
  /** 人工调整还是自动推荐，缺省按人工调整（人工高于自动）。 */
  source?: ThresholdVersion['source']
  setter?: string
}

/**
 * 调整入口（仅现行版本可调整）：
 * 生成同系列下一个版本，旧版本关闭到生效日前一天并转为「已调整」，不再参与计算；
 * 人工调整直接现行；自动推荐落为草稿，经发布入口生效，保证两个入口写同一份数据。
 */
export function adjustThreshold(id: number, input: AdjustThresholdInput): ThresholdActionResult {
  const invalid = validateValues(input)
  if (invalid) {
    return fail(invalid)
  }
  const versions = listVersions()
  const current = versions.find((item) => item.id === id)
  if (!current) {
    return fail(`没有找到编号为 ${id} 的阈值版本`)
  }
  if (current.status !== 'active') {
    return fail(`版本当前为「${STATUS_LABELS[current.status]}」，只有已生效版本才能调整`)
  }
  const conflict = findSeriesConflict(versions, current.thresholdCode, current.monitorType)
  if (conflict) {
    return fail(`存在冲突版本，调整已阻断：${conflict.reason}`)
  }

  const source = input.source ?? 'manual'
  // 人工调整默认次日生效，避免与现行版本产生同日重叠
  const defaultFrom = formatDate(new Date(Date.now() + 24 * 60 * 60 * 1000))
  const effectiveFrom = input.effectiveFrom ?? defaultFrom
  if (!validDate(effectiveFrom)) {
    return fail(`新生效日期 ${effectiveFrom} 格式不正确，应为 YYYY-MM-DD`)
  }
  if (effectiveFrom <= current.effectiveFrom) {
    return fail(`新版本生效日期（${effectiveFrom}）必须晚于被调整版本的生效日期（${current.effectiveFrom}）`)
  }

  const seq = nextSeq(versions, current.thresholdCode, current.monitorType)
  const nextId = versions.reduce((max, item) => Math.max(max, item.id), 0) + 1
  const becomingActive = source === 'manual'
  const trial = cloneVersions(versions)
  if (becomingActive) {
    // 先关旧版本，再开新版本，区间衔接为 [旧起, 生效日前一天] + [生效日, ∞)。
    const old = trial.find((item) => item.id === id)
    if (old) {
      old.status = 'superseded'
      old.effectiveTo = dayBefore(effectiveFrom)
      old.updatedAt = today()
    }
  }
  const candidate: ThresholdVersion = {
    id: nextId,
    thresholdCode: current.thresholdCode,
    hazardCode: current.hazardCode,
    monitorType: current.monitorType,
    seq,
    source,
    // 人工调整直接现行；自动推荐只落草稿，须经发布入口人工放行
    status: becomingActive ? 'active' : 'draft',
    attention: input.attention,
    warning: input.warning,
    alarm: input.alarm,
    effectiveFrom,
    effectiveTo: null,
    setter: input.setter ?? (source === 'manual' ? '人工调整' : '系统自动推荐'),
    setAt: today(),
    updatedAt: today(),
    ...(source === 'auto'
      ? { remark: '自动推荐草稿，需人工发布；发布后人工设定仍优先于并行的自动推荐' }
      : {}),
  }
  trial.push(candidate)
  const overlap = findSeriesConflict(trial, current.thresholdCode, current.monitorType)
  if (overlap) {
    return fail(`调整后会产生冲突版本，已拒绝：${overlap.reason}`)
  }
  commitVersions(trial)
  return {
    ok: true,
    message:
      source === 'manual'
        ? `${current.thresholdCode}（${current.monitorType}）已调整为 v${seq}，自 ${effectiveFrom} 起生效；旧版本 v${current.seq} 同步关闭，不再参与计算`
        : `${current.thresholdCode}（${current.monitorType}）自动推荐 v${seq} 已存为草稿，须人工发布后才生效`,
  }
}

/**
 * 废止入口（仅现行版本可废止）：已废止配置不能再发布，也不会被调整出新分支。
 */
export function abolishThreshold(id: number): ThresholdActionResult {
  const versions = listVersions()
  const current = versions.find((item) => item.id === id)
  if (!current) {
    return fail(`没有找到编号为 ${id} 的阈值版本`)
  }
  if (current.status === 'abolished') {
    return fail('该配置已经是废止状态')
  }
  if (current.status !== 'active') {
    return fail(`版本当前为「${STATUS_LABELS[current.status]}」，只有已生效版本才能废止`)
  }
  const trial = cloneVersions(versions)
  const target = trial.find((item) => item.id === id)
  if (target) {
    target.status = 'abolished'
    target.effectiveTo = dayBefore(today())
    target.updatedAt = today()
  }
  commitVersions(trial)
  return {
    ok: true,
    message: `${current.thresholdCode}（${current.monitorType}）v${current.seq} 已废止，废止日起不再参与雨量、倾斜与预警发布计算`,
  }
}

export function resetThresholds(): ThresholdVersion[] {
  return resetVersions()
}
