import {
  LEVEL_LABELS,
  STATUS_LABELS,
  abolishThreshold,
  adjustThreshold,
  explainAlarm,
  explainRain,
  explainTilt,
  listThresholdIssues,
  listThresholdVersions,
  publishThreshold,
} from '@/domain/threshold'
import type { UsageExplanation } from '@/domain/threshold'
import { MODULE_BY_KEY } from '@/data/modules'
import { allRows, listRows, resetRows, saveRows } from '@/data/local-store'
import type { ActionResult, EntryRow, ModuleMeta, OverviewResult, PageResult } from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

/** 读阈值的业务入口与其解释口径，全部来自同一份版本结果，不再各自维护。 */
const THRESHOLD_USAGE: Record<
  string,
  { explain: (row: EntryRow) => UsageExplanation; gateLabel: string }
> = {
  rain_gauge: { explain: explainRain, gateLabel: '预警' },
  tilt: { explain: explainTilt, gateLabel: '报警' },
  alarm: { explain: explainAlarm, gateLabel: '发布' },
}

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

export function filterRows(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  if (key === 'threshold') {
    // 阈值列表直接读版本库，与雨量/倾斜/预警发布同源
    const versions = listThresholdVersions()
    const rows: EntryRow[] = versions.map((version) => ({
      id: version.id,
      status: version.status,
      pending: version.status === 'draft',
      abnormal: version.status === 'abolished',
      阈值编号: version.thresholdCode,
      版本: `v${version.seq}`,
      隐患点编号: version.hazardCode,
      监测类型: version.monitorType,
      来源: version.source === 'manual' ? '人工设定' : '自动推荐',
      注意级阈值: version.attention,
      警示级阈值: version.warning,
      警戒级阈值: version.alarm,
      生效日期: version.effectiveFrom,
      失效日期: version.effectiveTo ?? '—',
      设定人: version.setter,
      设定日期: version.setAt,
      备注: version.remark ?? '',
    }))
    const matched = filterRows(rows, filters)
    return { items: matched, total: matched.length, page: 1, size: matched.length }
  }
  const matched = filterRows(listRows(key), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

export function runAction(key: string, id: number, action: string, payload?: unknown): ActionResult {
  // 阈值模块的发布/调整/废止是独立版本流，统一走领域服务，绝不落到通用状态翻转。
  if (key === 'threshold') {
    return runThresholdAction(id, action, payload)
  }
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  // 雨量「触发预警」、倾斜「触发报警」、预警发布「确认发布」：先读当时阈值，
  // 空配置/冲突/未达级都要说明原因并阻断，不能脱离阈值直接改状态。
  const gated = THRESHOLD_USAGE[key]
  if (
    gated &&
    ((key === 'rain_gauge' && action === '触发预警') ||
      (key === 'tilt' && action === '触发报警') ||
      (key === 'alarm' && action === '确认发布'))
  ) {
    const explanation = gated.explain(rows[index])
    if (explanation.result.kind !== 'ok' || !explanation.triggered) {
      return {
        ok: false,
        message:
          explanation.result.kind === 'ok'
            ? `未达到注意级阈值，不能${gated.gateLabel}：${explanation.text}`
            : `不能${gated.gateLabel}：${explanation.text}`,
      }
    }
  }
  const current = String(rows[index].status)
  if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }
  const lastStatus = meta.statuses[meta.statuses.length - 1]
  const updated: EntryRow = {
    ...rows[index],
    status: target,
    pending: target !== lastStatus,
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
  }
  const next = [...rows]
  next[index] = updated
  saveRows(key, next)

  // 确认发布成功后，把依据的版本追加进触发条件，发布记录也读同一份结果。
  if (key === 'alarm' && action === '确认发布') {
    const explanation = gated!.explain(next[index])
    next[index] = {
      ...next[index],
      预警等级:
        explanation.result.kind === 'ok'
          ? LEVEL_LABELS[explanation.result.level]
          : next[index]['预警等级'],
      触发条件: `${next[index]['触发条件'] ?? ''}【发布依据：${explanation.text}】`,
    }
    saveRows(key, next)
  }
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

type ThresholdActionPayload = {
  effectiveFrom?: string
  setter?: string
  values?: { attention: number; warning: number; alarm: number }
}

function runThresholdAction(id: number, action: string, payload?: unknown): ActionResult {
  const input = (payload ?? {}) as ThresholdActionPayload
  if (action === '发布生效') {
    return publishThreshold(id, input.effectiveFrom)
  }
  if (action === '废止配置') {
    return abolishThreshold(id)
  }
  if (action === '调整阈值') {
    if (!input.values) {
      return { ok: false, message: '调整必须提供新的注意级、警示级、警戒级阈值' }
    }
    return adjustThreshold(id, {
      ...input.values,
      effectiveFrom: input.effectiveFrom,
      setter: input.setter,
      source: 'manual',
    })
  }
  return { ok: false, message: `预警阈值没有登记「${action}」这个动作` }
}

/** 雨量/倾斜/预警发布页面取某条记录的阈值解释（同一份结果）。 */
export function explainThresholdUsage(key: string, row: EntryRow): string {
  const usage = THRESHOLD_USAGE[key]
  if (!usage) {
    return ''
  }
  return usage.explain(row).text
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  // 阈值模块没有独立台账，导出与列表读同一份版本投影
  const rows = listEntries(key).items
  for (const row of rows) {
    const statusText =
      key === 'threshold'
        ? STATUS_LABELS[String(row.status) as keyof typeof STATUS_LABELS]
        : row.status
    lines.push([row.id, ...meta.fields.map((field) => row[field] ?? ''), statusText].join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `\uFEFF${lines.join('\n')}` }
}

export function downloadEntries(key: string): void {
  const { filename, content } = exportEntries(key)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export function loadOverview(): OverviewResult {
  const rows = allRows()
  const versions = listThresholdVersions()
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    if (meta.key === 'threshold') {
      return {
        name: meta.name,
        created: versions.length,
        pending: versions.filter((row) => row.status === 'draft').length,
        abnormal: listThresholdIssues().filter((issue) => issue.level === 'conflict').length,
      }
    }
    const entries = rows[meta.key] ?? []
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => row.pending).length,
      abnormal: entries.filter((row) => row.abnormal).length,
    }
  })
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]
  return { cards, modules }
}
