// 端到端行为校验：在 Node 里用内存版 localStorage 跑真实模块，不依赖浏览器。
// 校验：存量迁移、人工>自动、历史按当时阈值、废止不能再发布、冲突/空配置给原因、失败不回写旧版本。
const store = new Map<string, string>()
;(globalThis as any).window = {
  localStorage: {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  },
}

import assert from 'node:assert'
import { listRows, resetRows, saveRows } from '../src/data/local-store'
import { loadRegistry, evaluateMeasurement } from '../src/data/threshold/registry'
import {
  adjustThreshold,
  publishThreshold,
  recommendThreshold,
  revokeThreshold,
} from '../src/data/threshold/service'
import { runAction } from '../src/api/local-service'

let passed = 0
function check(name: string, fn: () => void) {
  fn()
  passed += 1
  console.log(`  ✓ ${name}`)
}

resetRows('threshold')
resetRows('rain_gauge')
resetRows('tilt')
resetRows('alarm')

const snapshot1 = loadRegistry()
check('存量缺生效日期的配置按设定日期迁移', () => {
  const rain = snapshot1.chains.find((c) => c.code === 'RAIN-0001' && c.monitorType === '雨量')!
  const v1 = rain.versions.find((v) => v.version === 1)!
  assert.equal(v1.effectiveFrom, '2026-05-01')
  assert.equal(v1.effectiveTo, '2026-08-01')
  assert.equal(v1.source, 'manual')
  const v2 = rain.versions.find((v) => v.version === 2)!
  assert.equal(v2.effectiveFrom, '2026-08-01')
  assert.equal(v2.effectiveTo, null)
})

check('已废止存量版本在设定日闭合、不再参与计算，但历史区间保留', () => {
  const tilt = snapshot1.chains.find((c) => c.code === 'TILT-0001' && c.monitorType === '倾斜')!
  const revoked = tilt.versions.find((v) => v.lifecycle === 'revoked')!
  assert.equal(revoked.effectiveTo, '2026-04-01')
  const now = evaluateMeasurement(snapshot1, {
    code: 'TILT-0001',
    monitorType: '倾斜',
    observedAt: '2026-09-15',
    value: 4,
  })
  assert.equal(now.status, 'evaluated')
  if (now.status === 'evaluated') assert.equal(now.version.version, 1)
})

check('历史监测按当时阈值解释（6 月用旧版，9 月用新版）', () => {
  const old = evaluateMeasurement(snapshot1, {
    code: 'RAIN-0001',
    monitorType: '雨量',
    observedAt: '2026-06-15',
    value: 45,
  })
  assert.equal(old.status, 'evaluated')
  if (old.status === 'evaluated') {
    assert.equal(old.version.version, 1)
    assert.equal(old.level, 'notice') // 旧版 30/50/80：45 为注意级
  }
  const now = evaluateMeasurement(snapshot1, {
    code: 'RAIN-0001',
    monitorType: '雨量',
    observedAt: '2026-09-02',
    value: 45,
  })
  if (now.status === 'evaluated') {
    assert.equal(now.version.version, 2)
    assert.equal(now.level, 'warning') // 新版 20/40/60：45 为警示级
  }
})

check('空配置必须说明原因', () => {
  const result = evaluateMeasurement(snapshot1, {
    monitorType: '裂缝',
    observedAt: '2026-09-02',
    value: 100,
  })
  assert.equal(result.status, 'empty')
  assert.match((result as { reason: string }).reason, /尚未配置阈值/)
})

check('同来源版本区间重叠报版本冲突并给原因，冲突区间不计算', () => {
  const conflict = evaluateMeasurement(snapshot1, {
    code: 'TILT-0002',
    monitorType: '倾斜',
    observedAt: '2026-09-11',
    value: 3,
  })
  assert.equal(conflict.status, 'conflict')
})

check('自动推荐撞上人工调整时被压制，人工优先（自动发布被拒）', () => {
  // RAIN-0001 v3 是自动推荐草稿，生效 2026-10-06；与人工现行版区间重叠
  const draft = listRows('threshold').find(
    (r) => String(r['阈值编号']) === 'RAIN-0001' && Number(r['版本号']) === 3,
  )!
  const result = publishThreshold(Number(draft.id))
  assert.equal(result.ok, false)
  assert.match(result.message, /人工调整/)
})

check('人工调整生成草稿并发布：旧现行版本收口为已调整，区间闭合', () => {
  const active = listRows('threshold').find(
    (r) =>
      String(r['阈值编号']) === 'RAIN-0002' &&
      String(r['监测类型']) === '雨量' &&
      r.status === '已生效',
  )!
  const adjusted = adjustThreshold({
    id: Number(active.id),
    configuredAt: '2026-09-15',
    effectiveFrom: '2026-09-15',
    levels: { notice: 20, warning: 45, alert: 70 },
    operator: '测试员',
  })
  assert.equal(adjusted.ok, true)
  const draft = listRows('threshold').filter(
    (r) => String(r['阈值编号']) === 'RAIN-0002' && r.status === '草稿',
  )[0]
  const published = publishThreshold(Number(draft.id))
  assert.equal(published.ok, true)
  const reg = loadRegistry()
  const chain = reg.chains.find((c) => c.code === 'RAIN-0002')!
  const auto = chain.versions.find((v) => v.source === 'auto')!
  // 人工发布时自动现行版被收口，不再并行参与计算
  assert.equal(auto.lifecycle, 'superseded')
  assert.equal(auto.effectiveTo, '2026-09-15')
  const manual = chain.versions.find((v) => v.source === 'manual' && v.lifecycle === 'active')!
  assert.equal(manual.effectiveFrom, '2026-09-15')
  const atOld = evaluateMeasurement(reg, {
    code: 'RAIN-0002',
    monitorType: '雨量',
    observedAt: '2026-09-10',
    value: 30,
  })
  if (atOld.status === 'evaluated') assert.equal(atOld.level, 'notice')
  const atNew = evaluateMeasurement(reg, {
    code: 'RAIN-0002',
    monitorType: '雨量',
    observedAt: '2026-09-16',
    value: 30,
  })
  if (atNew.status === 'evaluated') assert.equal(atNew.level, 'notice')
})

check('废止后不能再次发布（已废止配置不可发布）', () => {
  const active = listRows('threshold').find(
    (r) =>
      String(r['阈值编号']) === 'TILT-0001' &&
      String(r['监测类型']) === '倾斜' &&
      r.status === '已生效',
  )!
  const revoked = revokeThreshold(Number(active.id), '2026-09-20')
  assert.equal(revoked.ok, true)
  const again = publishThreshold(Number(active.id))
  assert.equal(again.ok, false)
  assert.match(again.message, /只有草稿版本可以发布/)
})

check('预警发布读同一份判定：冲突配置线禁止发布且不落状态', () => {
  const alarmRows = listRows('alarm')
  const conflictAlarm = alarmRows.find((r) => String(r['隐患点编号']) === 'TILT-0002')!
  const before = conflictAlarm.status
  const result = runAction('alarm', Number(conflictAlarm.id), '确认发布')
  assert.equal(result.ok, false)
  assert.match(result.message, /版本冲突/)
  assert.equal(listRows('alarm').find((r) => r.id === conflictAlarm.id)!.status, before)
})

check('预警发布成功时写入核定级别与阈值依据', () => {
  const alarmRows = listRows('alarm')
  const rainAlarm = alarmRows.find((r) => String(r['隐患点编号']) === 'RAIN-0001')!
  const result = runAction('alarm', Number(rainAlarm.id), '确认发布')
  assert.equal(result.ok, true, result.message)
  const updated = listRows('alarm').find((r) => r.id === rainAlarm.id)!
  assert.equal(updated['预警等级'], '警戒级')
  assert.match(String(updated['触发条件']), /版本2/)
})

check('达阈值的监测行可以触发预警，未达阈值被同一入口挡下', () => {
  const hitRow = listRows('rain_gauge').find((r) => String(r['记录编号']) === 'RAIN-0001')!
  // 2026-06-15, 45mm/h 对旧版（注意 30）命中注意级
  assert.equal(runAction('rain_gauge', Number(hitRow.id), '触发预警').ok, true)

  const rows = listRows('rain_gauge')
  const below = {
    id: 999,
    status: '已采集',
    pending: true,
    abnormal: false,
    记录编号: 'RAIN-TEST',
    站点编号: 'RAIN-0002',
    观测时段: '2026-09-02',
    时段雨量: 5,
    日累计雨量: 8,
    小时最大雨强: 10,
    是否触发预警: '否',
    记录状态: '已采集',
  }
  saveRows('rain_gauge', [...rows, below])
  const blocked = runAction('rain_gauge', 999, '触发预警')
  assert.equal(blocked.ok, false)
  assert.match(blocked.message, /未达注意级/)
})

check('任一步失败不改动数据（非法阈值级别顺序被拒，旧版本原样）', () => {
  const active = listRows('threshold').find(
    (r) =>
      String(r['阈值编号']) === 'RAIN-0001' &&
      String(r['监测类型']) === '雨量' &&
      r.status === '已生效',
  )
  // 前面人工草稿还没发布，当前现行是 v2
  const beforeCount = listRows('threshold').length
  const result = recommendThreshold({
    code: 'RAIN-0001',
    hazardCode: 'RAIN-0001',
    monitorType: '雨量',
    configuredAt: '2026-10-06',
    effectiveFrom: '2026-10-06',
    levels: { notice: 90, warning: 50, alert: 30 },
    operator: '系统推荐',
  })
  assert.equal(result.ok, false)
  assert.equal(listRows('threshold').length, beforeCount)
  assert.ok(active)
})

console.log(`\n全部 ${passed} 项校验通过`)
