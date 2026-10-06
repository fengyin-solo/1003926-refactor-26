import { MODULE_BY_KEY } from '@/data/modules'
import { allRows, listRows, resetRows, saveRows } from '@/data/local-store'
import { alarmPublishContext, evaluateRow } from '@/data/threshold/eval'
import { loadRegistry, THRESHOLD_FIELDS } from '@/data/threshold/registry'
import { adjustThreshold, publishThreshold, revokeThreshold } from '@/data/threshold/service'
import { LEVEL_LABEL } from '@/data/threshold/types'
import type { ActionResult, EntryRow, ModuleMeta, OverviewResult, PageResult } from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

// 预警类动作必须先过统一阈值判定：空配置/版本冲突/阈值不可用都直接挡下，绝不写状态。
const THRESHOLD_GUARDED_ACTIONS: Record<string, 'rain_gauge' | 'tilt'> = {
  'rain_gauge:触发预警': 'rain_gauge',
  'tilt:触发报警': 'tilt',
}

function guardThresholdAction(key: string, id: number, action: string): ActionResult | null {
  const module = THRESHOLD_GUARDED_ACTIONS[`${key}:${action}`]
  if (!module) {
    return null
  }
  const rows = listRows(key)
  const row = rows.find((item) => Number(item.id) === id)
  if (!row) {
    return { ok: false, message: '没有找到对应的监测记录' }
  }
  const evaluation = evaluateRow(loadRegistry(), module, row)
  if (evaluation.status !== 'evaluated' || !evaluation.hit) {
    // 空配置 / 冲突 / 阈值异常 / 未达级别：统一返回原因，状态不落地。
    return { ok: false, message: `不能${action}：${evaluation.reason}` }
  }
  return null
}

function publishAlarm(row: EntryRow): ActionResult {
  const { evaluation } = alarmPublishContext(loadRegistry(), row)
  if (evaluation.status !== 'evaluated') {
    return { ok: false, message: `预警不能发布：${evaluation.reason}` }
  }
  if (!evaluation.hit) {
    return { ok: false, message: `预警不能发布：${evaluation.reason}` }
  }
  const basis = `${evaluation.version.code}/${evaluation.version.monitorType}版本${evaluation.version.version}`
  const next: EntryRow = {
    ...row,
    预警等级: LEVEL_LABEL[evaluation.level],
    触发条件: `${String(row['触发条件'] ?? '')}（依据${basis}）`,
  }
  return { ok: true, message: `已按${basis}发布${LEVEL_LABEL[evaluation.level]}预警`, updated: next }
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
  const matched = filterRows(listRows(key), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

export function runAction(key: string, id: number, action: string): ActionResult {
  const meta = moduleMeta(key)

  // 预警阈值模块的写动作全部走统一版本服务，不允许走通用的改 status 老路。
  if (key === 'threshold') {
    return thresholdAction(id, action)
  }

  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }

  // 雨量/倾斜的触发动作、预警发布动作先过统一阈值判定。
  if (key === 'alarm' && action === '确认发布') {
    const guarded = publishAlarm(rows[index])
    if (!guarded.ok) {
      return guarded
    }
    const updated: EntryRow = {
      ...(guarded.updated ?? rows[index]),
      status: target,
      pending: target !== meta.statuses[meta.statuses.length - 1],
      abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
    }
    const next = [...rows]
    next[index] = updated
    saveRows(key, next)
    return { ok: true, message: guarded.message }
  }

  const blocked = guardThresholdAction(key, id, action)
  if (blocked) {
    return blocked
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
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

// 阈值模块动作到统一服务的映射；废止日期取当天，废止后历史区间仍保留。
function thresholdAction(id: number, action: string): ActionResult {
  const today = new Date().toISOString().slice(0, 10)
  if (action === '发布生效') {
    return publishThreshold(id)
  }
  if (action === '废止配置') {
    return revokeThreshold(id, today)
  }
  return quickAdjust(id, today)
}

// 列表上的快捷调整：沿用现行三级阈值生成人工调整草稿，精确数值在阈值页表单里改。
function quickAdjust(id: number, today: string): ActionResult {
  const rows = listRows('threshold')
  const base = rows.find((row) => Number(row.id) === id)
  if (!base) {
    return { ok: false, message: `没有找到编号为 ${id} 的阈值版本` }
  }
  const numberOrNull = (value: unknown) =>
    typeof value === 'number' && Number.isFinite(value)
      ? value
      : typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))
        ? Number(value)
        : null
  const levels = {
    notice: numberOrNull(base[THRESHOLD_FIELDS.notice]),
    warning: numberOrNull(base[THRESHOLD_FIELDS.warning]),
    alert: numberOrNull(base[THRESHOLD_FIELDS.alert]),
  }
  return adjustThreshold({
    id,
    configuredAt: today,
    effectiveFrom: today,
    levels: levels as { notice: number; warning: number; alert: number },
    operator: String(base[THRESHOLD_FIELDS.operator] ?? '值班员'),
  })
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  for (const row of listRows(key)) {
    lines.push([row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status].join(','))
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
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
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
