/**
 * 预警阈值版本：列表、发布、调整三个入口共用的唯一领域模型。
 * 收拢口径：同一「阈值编号 + 监测类型」为一个阈值系列，系列内按版本序号迭代。
 */

/** 阈值来源：人工设定/调整始终高于自动推荐。 */
export type ThresholdSource = 'manual' | 'auto'

/** 草稿可发布；现行可调整/废止；已被取代、已废止为历史版本，不再参与计算。 */
export type ThresholdStatus = 'draft' | 'active' | 'superseded' | 'abolished'

/** 监测值对照阈值后的级别。 */
export type AlarmLevel = 'normal' | 'attention' | 'warning' | 'alarm'

export interface ThresholdVersion {
  id: number
  /** 阈值编号 */
  thresholdCode: string
  /** 隐患点编号（站点/测点共用该字段匹配） */
  hazardCode: string
  /** 监测类型，如 雨量、倾斜、裂缝宽度、泥位 */
  monitorType: string
  /** 同一阈值系列内的版本序号，从 1 递增 */
  seq: number
  source: ThresholdSource
  status: ThresholdStatus
  /** 注意级阈值 */
  attention: number
  /** 警示级阈值 */
  warning: number
  /** 警戒级阈值 */
  alarm: number
  /** 生效日期 YYYY-MM-DD */
  effectiveFrom: string
  /** 失效日期 YYYY-MM-DD；null 表示持续有效 */
  effectiveTo: string | null
  /** 设定人 */
  setter: string
  /** 设定日期 YYYY-MM-DD */
  setAt: string
  /** 迁移、冲突等需要向使用方说明的备注 */
  remark?: string
  /** 由存量配置迁移而来（原配置缺生效日期） */
  migrated?: boolean
  updatedAt: string
}

/** 业务入口（雨量、倾斜、预警发布）查询某时点适用阈值的条件。 */
export interface ThresholdQuery {
  thresholdCode?: string
  hazardCode?: string
  monitorType: string
  /** 解释时点：历史监测按当时阈值解释。 */
  at: string
  /** 待判定的监测值。 */
  value?: number
}

export type ThresholdResolveResult =
  | {
      kind: 'ok'
      version: ThresholdVersion
      level: AlarmLevel
      /** 选中人工版本但同时存在并行自动推荐时给出说明。 */
      note?: string
    }
  | { kind: 'empty'; reason: string }
  | { kind: 'conflict'; reason: string; versions: ThresholdVersion[] }

/** 列表/看板需要提示的问题：冲突必须阻断，并行来源仅作说明。 */
export interface ThresholdIssue {
  thresholdCode: string
  hazardCode: string
  monitorType: string
  level: 'conflict' | 'note'
  reason: string
}
