import type { EntryRow } from '@/data/types'

import { LEVEL_LABELS, resolveThreshold } from './logic'
import { listVersions } from './store'
import type { ThresholdResolveResult } from './types'

/** 三个业务入口共用的解释说明；空配置/冲突必须带原因，不允许静默放行。 */
export interface UsageExplanation {
  result: ThresholdResolveResult
  /** 页面与导出直接使用的整句说明 */
  text: string
  /** 是否达到注意级及以上（业务动作据此放行/阻断） */
  triggered: boolean
}

function toNumber(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined
  }
  const num = Number(String(value).replace(/[^\d.-]/g, ''))
  return Number.isFinite(num) ? num : undefined
}

function firstDate(...values: unknown[]): string {
  for (const value of values) {
    const text = String(value ?? '')
    const match = text.match(/\d{4}-\d{2}-\d{2}/)
    if (match) {
      return match[0]
    }
  }
  return ''
}

function render(result: ThresholdResolveResult, valueLabel: string, value?: number): UsageExplanation {
  if (result.kind === 'empty') {
    return { result, text: `无适用阈值：${result.reason}`, triggered: false }
  }
  if (result.kind === 'conflict') {
    return { result, text: `阈值冲突：${result.reason}`, triggered: false }
  }
  const v = result.version
  const levelText =
    value === undefined
      ? '仅引用阈值'
      : `${valueLabel} ${value} → ${LEVEL_LABELS[result.level]}`
  const basis = `适用 ${v.thresholdCode} v${v.seq}（${
    v.source === 'manual' ? '人工' : '自动'
  }，${v.effectiveFrom} 起生效，注意/警示/警戒 ${v.attention}/${v.warning}/${v.alarm}）：${levelText}`
  return {
    result,
    text: result.note ? `${basis}；${result.note}` : basis,
    triggered: result.level !== 'normal',
  }
}

/** 雨量：按观测时段所在日期解释当时阈值，监测值取时段雨量（缺则用小时最大雨强）。 */
export function explainRain(row: EntryRow): UsageExplanation {
  const value = toNumber(row['时段雨量']) ?? toNumber(row['小时最大雨强'])
  const at = firstDate(row['观测时段'], row['记录状态'])
  const result = resolveThreshold(listVersions(), {
    hazardCode: String(row['站点编号'] ?? ''),
    monitorType: '雨量',
    at: at || '1970-01-01',
    value,
  })
  return render(result, '时段雨量(mm)', value)
}

/** 倾斜：历史观测按观测日期对应的当时阈值解释，监测值取倾斜角度。 */
export function explainTilt(row: EntryRow): UsageExplanation {
  const value = toNumber(row['倾斜角度'])
  const at = firstDate(row['观测日期'])
  const result = resolveThreshold(listVersions(), {
    hazardCode: String(row['测点编号'] ?? ''),
    monitorType: '倾斜',
    at: at || '1970-01-01',
    value,
  })
  return render(result, '倾斜角度(°)', value)
}

const TYPE_KEYWORDS: Array<{ type: string; words: string[] }> = [
  { type: '雨量', words: ['雨量', '降雨', '雨强', '降水'] },
  { type: '倾斜', words: ['倾斜', '倾角'] },
  { type: '裂缝宽度', words: ['裂缝', '缝宽', '宽度'] },
  { type: '泥位', words: ['泥位', '泥石流'] },
]

/** 从预警触发条件文本中识别监测类型，识别不到时按原文兜底并给出空配置原因。 */
export function detectMonitorType(text: string): string {
  for (const item of TYPE_KEYWORDS) {
    if (item.words.some((word) => text.includes(word))) {
      return item.type
    }
  }
  return text.slice(0, 12) || '未识别监测类型'
}

/**
 * 预警发布：确认发布必须读到当时阈值且达到注意级及以上；
 * 空配置或冲突版本时说明原因并阻断，避免无依据发布。
 */
export function explainAlarm(row: EntryRow): UsageExplanation {
  const condition = String(row['触发条件'] ?? '')
  const type = detectMonitorType(condition)
  const at = firstDate(row['发布时间'], condition)
  // 触发条件形如「2026-10-02 时段雨量 65mm」：跳过日期，取带单位的测量值
  const withoutDate = condition.replace(/\d{4}-\d{2}-\d{2}/g, '')
  const value = toNumber(withoutDate.match(/\d+(?:\.\d+)?/)?.[0])
  const result = resolveThreshold(listVersions(), {
    hazardCode: String(row['隐患点编号'] ?? ''),
    monitorType: type,
    at: at || '1970-01-01',
    value,
  })
  const explanation = render(result, '触发值', value)
  if (result.kind === 'ok' && value === undefined) {
    // 触发条件里没有数值时只能引用阈值版本，不能声称已达级
    return { ...explanation, triggered: false }
  }
  return explanation
}
