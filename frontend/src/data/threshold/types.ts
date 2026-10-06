import type { EntryRow } from '../types'

// 预警阈值按「阈值编号 + 监测类型」收拢成一条条配置线，线上每个版本只对一段生效区间负责。
// 列表、发布、调整三个入口都不许再各自维护版本，统一走这份模型。

/** 阈值生命周期：草稿不占生效区间；现行/历史/已废止都属于已登记版本。 */
export type ThresholdLifecycle = 'draft' | 'active' | 'superseded' | 'revoked'

/** 版本来源：人工调整永远压过自动推荐。 */
export type ThresholdSource = 'manual' | 'auto'

/** 三级预警阈值，原始字段解析不出来就记成 null，由配置问题统一报原因。 */
export type ThresholdLevels = {
  notice: number | null
  warning: number | null
  alert: number | null
}

/** 一次判定命中的级别。 */
export type AlarmLevel = 'normal' | 'notice' | 'warning' | 'alert'

export const LEVEL_LABEL: Record<AlarmLevel, string> = {
  normal: '未达注意级',
  notice: '注意级',
  warning: '警示级',
  alert: '警戒级',
}

export const SOURCE_LABEL: Record<ThresholdSource, string> = {
  manual: '人工调整',
  auto: '自动推荐',
}

/** 生命周期在页面与旧 status 字段上的统一文案。 */
export const LIFECYCLE_LABEL: Record<ThresholdLifecycle, string> = {
  draft: '草稿',
  active: '已生效',
  superseded: '已调整',
  revoked: '已废止',
}

/** 归一化后的阈值版本，是所有入口读写的唯一形态。 */
export type ThresholdVersion = {
  row: EntryRow
  /** 配置线主键之一：阈值编号。 */
  code: string
  /** 配置线主键之一：监测类型（雨量/倾斜…）。 */
  monitorType: string
  version: number
  lifecycle: ThresholdLifecycle
  source: ThresholdSource
  /** 设定日期：存量记录缺生效日期时，生效日期迁移到这一天。 */
  configuredAt: string
  /** 生效起点，闭区间。 */
  effectiveFrom: string
  /** 生效终点，开区间；现行版本为 null。 */
  effectiveTo: string | null
  levels: ThresholdLevels
  /** 归一化时发现的配置问题（阈值不可解析等），空数组代表版本本身可用。 */
  issues: string[]
  /** 自动推荐与同区间人工调整重叠时被压制：人工调整高于自动推荐，该版本不参与计算。 */
  suppressed?: boolean
}

/** 一条配置线（阈值编号 + 监测类型）下的全部版本。 */
export type ThresholdChain = {
  code: string
  monitorType: string
  versions: ThresholdVersion[]
  /** 该配置线自身的问题：版本冲突、阈值不可解析等。 */
  issues: string[]
}

/** 解析某条配置线时的统一结果：空配置、冲突都必须给出原因。 */
export type ThresholdResolve =
  | { status: 'resolved'; version: ThresholdVersion }
  | { status: 'empty'; reason: string }
  | { status: 'conflict'; reason: string; versions: ThresholdVersion[] }
  | { status: 'invalid'; reason: string; version: ThresholdVersion }

/** 参与判定的一条监测数据。历史监测必须带上观测日期，按当时的阈值解释。 */
export type ThresholdMeasurement = {
  /** 该数据所属的配置线：阈值编号（可空，空则在同监测类型里唯一选线）。 */
  code?: string
  monitorType: string
  /** 观测时间（YYYY-MM-DD）：取这一天有效的版本，历史记录按当时阈值解释。 */
  observedAt: string
  value: number
}

/** 一次监测判定的统一结果，雨量、倾斜、预警发布读同一份结构。 */
export type ThresholdEvaluation =
  | {
      status: 'evaluated'
      level: AlarmLevel
      hit: boolean
      version: ThresholdVersion
      reason: string
    }
  | { status: 'empty'; reason: string }
  | { status: 'conflict'; reason: string }
  | { status: 'invalid'; reason: string }
