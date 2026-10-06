import type { EntryRow } from '@/data/types'

import type { ThresholdVersion } from './types'

/**
 * 存量预警阈值（通用台账形态）。其中 THRE-0002 没有「生效日期」，
 * 迁移时按「设定日期」补齐；其余记录保留原始生效日期。
 */
export const LEGACY_THRESHOLD_ROWS: EntryRow[] = [
  {
    id: 1,
    status: '已生效',
    pending: false,
    abnormal: false,
    阈值编号: 'THRE-0001',
    隐患点编号: 'RAIN-0001',
    监测类型: '雨量',
    注意级阈值: '25',
    警示级阈值: '50',
    警戒级阈值: '80',
    设定人: '监测员周敏',
    设定日期: '2026-08-01',
    生效日期: '2026-08-01',
    生效状态: '已生效',
  },
  {
    id: 2,
    status: '已生效',
    pending: false,
    abnormal: false,
    阈值编号: 'THRE-0002',
    隐患点编号: 'TILT-0001',
    监测类型: '倾斜',
    注意级阈值: '5',
    警示级阈值: '10',
    警戒级阈值: '15',
    设定人: '监测员周敏',
    设定日期: '2026-08-05',
    生效状态: '已生效',
  },
  {
    id: 3,
    status: '草稿',
    pending: true,
    abnormal: false,
    阈值编号: 'THRE-0003',
    隐患点编号: 'CRAC-0001',
    监测类型: '裂缝宽度',
    注意级阈值: '3',
    警示级阈值: '8',
    警戒级阈值: '15',
    设定人: '监测员周敏',
    设定日期: '2026-09-10',
    生效状态: '草稿',
  },
  {
    id: 4,
    status: '已废止',
    pending: false,
    abnormal: true,
    阈值编号: 'THRE-0004',
    隐患点编号: 'MUDF-0001',
    监测类型: '泥位',
    注意级阈值: '1',
    警示级阈值: '2',
    警戒级阈值: '3',
    设定人: '监测员周敏',
    设定日期: '2026-07-15',
    生效日期: '2026-07-15',
    生效状态: '已废止',
  },
]

const LEGACY_STATUS: Record<string, ThresholdVersion['status']> = {
  草稿: 'draft',
  已生效: 'active',
  已调整: 'superseded',
  已废止: 'abolished',
}

/**
 * 存量配置迁移：
 * - 缺生效日期时，按设定日期补齐并标记 migrated，页面上保留迁移说明；
 * - 状态映射到版本模型；原已生效/已调整记录视为人工设定（系统上线前的人工台账）。
 */
export function migrateLegacyThreshold(row: EntryRow): ThresholdVersion {
  const setAt = String(row['设定日期'] ?? '')
  const declaredFrom = row['生效日期'] === undefined ? '' : String(row['生效日期'])
  const effectiveFrom = declaredFrom || setAt
  const status = LEGACY_STATUS[String(row.status)] ?? 'draft'
  return {
    id: Number(row.id),
    thresholdCode: String(row['阈值编号']),
    hazardCode: String(row['隐患点编号']),
    monitorType: String(row['监测类型']),
    seq: 1,
    source: 'manual',
    status,
    attention: Number(row['注意级阈值']),
    warning: Number(row['警示级阈值']),
    alarm: Number(row['警戒级阈值']),
    effectiveFrom,
    effectiveTo: null,
    setter: String(row['设定人'] ?? ''),
    setAt,
    updatedAt: effectiveFrom,
    ...(declaredFrom
      ? {}
      : {
          migrated: true,
          remark: `存量配置缺生效日期，已按设定日期 ${setAt} 迁移补齐`,
        }),
  }
}

/**
 * 在迁移后的存量版本之上，补齐版本链，覆盖：
 * 调整迭代（旧版本关闭区间不再参与计算）、自动推荐与人工并行（人工优先）、
 * 同源区间重叠（冲突需显式说明）、仅存已废止（空配置需说明原因）。
 */
export function buildSeedThresholdVersions(): ThresholdVersion[] {
  const versions = LEGACY_THRESHOLD_ROWS.map(migrateLegacyThreshold)

  // THRE-0001 雨量：存量 v1 在 v2 生效前一日关闭，避免旧版本继续参与计算
  const rainV1 = versions.find((item) => item.id === 1)
  if (rainV1) {
    rainV1.status = 'superseded'
    rainV1.effectiveTo = '2026-09-14'
    rainV1.updatedAt = '2026-09-14'
  }
  // THRE-0003 裂缝宽度：存量草稿已发布为 v1，与后续补录的 v2 区间重叠形成冲突
  const crackV1 = versions.find((item) => item.id === 3)
  if (crackV1) {
    crackV1.status = 'active'
    crackV1.effectiveFrom = '2026-09-12'
    crackV1.updatedAt = '2026-09-12'
  }
  // THRE-0004 泥位：仅有的版本已废止，使用方应收到「空配置」原因
  const mudV1 = versions.find((item) => item.id === 4)
  if (mudV1) {
    mudV1.effectiveTo = '2026-08-31'
  }

  const extra: ThresholdVersion[] = [
    // THRE-0001 雨量：v2 已被 v3 调整取代；v3 人工版本与自动推荐 v5 并行（人工优先）
    {
      id: 5,
      thresholdCode: 'THRE-0001',
      hazardCode: 'RAIN-0001',
      monitorType: '雨量',
      seq: 2,
      source: 'manual',
      status: 'superseded',
      attention: 20,
      warning: 40,
      alarm: 70,
      effectiveFrom: '2026-09-15',
      effectiveTo: '2026-09-30',
      setter: '值班负责人李萍',
      setAt: '2026-09-14',
      updatedAt: '2026-10-01',
    },
    {
      id: 6,
      thresholdCode: 'THRE-0001',
      hazardCode: 'RAIN-0001',
      monitorType: '雨量',
      seq: 3,
      source: 'manual',
      status: 'active',
      attention: 30,
      warning: 60,
      alarm: 100,
      effectiveFrom: '2026-10-01',
      effectiveTo: null,
      setter: '值班负责人李萍',
      setAt: '2026-09-28',
      updatedAt: '2026-09-28',
    },
    {
      id: 7,
      thresholdCode: 'THRE-0001',
      hazardCode: 'RAIN-0001',
      monitorType: '雨量',
      seq: 4,
      source: 'auto',
      status: 'draft',
      attention: 18,
      warning: 38,
      alarm: 65,
      effectiveFrom: '2026-10-10',
      effectiveTo: null,
      setter: '系统自动推荐',
      setAt: '2026-10-05',
      updatedAt: '2026-10-05',
      remark: '自动推荐尚未发布，不参与计算',
    },
    {
      id: 8,
      thresholdCode: 'THRE-0001',
      hazardCode: 'RAIN-0001',
      monitorType: '雨量',
      seq: 5,
      source: 'auto',
      status: 'active',
      attention: 22,
      warning: 45,
      alarm: 80,
      effectiveFrom: '2026-10-01',
      effectiveTo: null,
      setter: '系统自动推荐',
      setAt: '2026-09-30',
      updatedAt: '2026-09-30',
    },
    // THRE-0002 倾斜：存量人工 v1 现行，自动 v2 并行 -> 人工优先
    {
      id: 9,
      thresholdCode: 'THRE-0002',
      hazardCode: 'TILT-0001',
      monitorType: '倾斜',
      seq: 2,
      source: 'auto',
      status: 'active',
      attention: 7,
      warning: 12,
      alarm: 20,
      effectiveFrom: '2026-10-01',
      effectiveTo: null,
      setter: '系统自动推荐',
      setAt: '2026-09-30',
      updatedAt: '2026-09-30',
    },
    // THRE-0003 裂缝宽度：人工补录 v2 与已发布 v1 同源区间重叠 -> 冲突，需说明并阻断
    {
      id: 10,
      thresholdCode: 'THRE-0003',
      hazardCode: 'CRAC-0001',
      monitorType: '裂缝宽度',
      seq: 2,
      source: 'manual',
      status: 'active',
      attention: 4,
      warning: 9,
      alarm: 16,
      effectiveFrom: '2026-09-20',
      effectiveTo: null,
      setter: '值班负责人李萍',
      setAt: '2026-09-19',
      updatedAt: '2026-09-19',
      remark: '人工补录版本，与 v1 区间重叠，待人工取舍',
    },
  ]
  return [...versions, ...extra]
}
