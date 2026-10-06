import { evaluateMeasurement } from './registry'
import type { ThresholdRegistry } from './registry'
import type { ThresholdEvaluation } from './types'
import type { EntryRow } from '../types'

// 雨量、倾斜、预警发布三个读取方共用的适配层：
// 把各自的业务行翻译成同一种监测数据，判定全部走 evaluateMeasurement，
// 任何一处都不许再自己写一套阈值比较。

export type ModuleKey = 'rain_gauge' | 'tilt' | 'alarm'

const MODULE_TYPE: Record<ModuleKey, string> = {
  rain_gauge: '雨量',
  tilt: '倾斜',
  alarm: '预警',
}

function toNumber(value: unknown): number {
  return typeof value === 'number' ? value : Number(value)
}

/**
 * 从业务行提取判定输入。隐患点编号同时也是阈值配置线的阈值编号约定
 * （种子数据里两者一致；不一致时回退到同监测类型唯一选线）。
 */
export function measurementFromRow(key: ModuleKey, row: EntryRow) {
  if (key === 'rain_gauge') {
    return {
      code: String(row['站点编号'] ?? ''),
      monitorType: MODULE_TYPE.rain_gauge,
      observedAt: String(row['观测时段'] ?? ''),
      value: toNumber(row['小时最大雨强']),
    }
  }
  if (key === 'tilt') {
    return {
      code: String(row['测点编号'] ?? ''),
      monitorType: MODULE_TYPE.tilt,
      observedAt: String(row['观测日期'] ?? ''),
      value: toNumber(row['倾斜角度']),
    }
  }
  // 预警发布本身不产生数值，它读取的是拟发布时的阈值版本，见 alarmPublishContext。
  return {
    code: String(row['隐患点编号'] ?? ''),
    monitorType: '',
    observedAt: String(row['发布时间'] ?? ''),
    value: NaN,
  }
}

/** 雨量、倾斜列表行的判定结果；历史行天然按观测当天的版本解释。 */
export function evaluateRow(
  registry: ThresholdRegistry,
  key: 'rain_gauge' | 'tilt',
  row: EntryRow,
): ThresholdEvaluation {
  return evaluateMeasurement(registry, measurementFromRow(key, row))
}

/**
 * 预警发布读取上下文：发布前必须能解析到当时有效的人工/自动阈值版本。
 * 监测类型由触发条件文本识别（含「雨」按雨量、含「倾斜」按倾斜）。
 */
export function alarmPublishContext(
  registry: ThresholdRegistry,
  row: EntryRow,
): { evaluation: ThresholdEvaluation; monitorType: string } {
  const trigger = String(row['触发条件'] ?? '')
  const monitorType = trigger.includes('倾斜') ? MODULE_TYPE.tilt : MODULE_TYPE.rain_gauge
  const valueText = trigger.match(/[-+]?\d+(\.\d+)?/)
  const evaluation = evaluateMeasurement(registry, {
    code: String(row['隐患点编号'] ?? ''),
    monitorType,
    observedAt: String(row['发布时间'] ?? '').slice(0, 10),
    value: valueText ? Number(valueText[0]) : NaN,
  })
  return { evaluation, monitorType }
}
