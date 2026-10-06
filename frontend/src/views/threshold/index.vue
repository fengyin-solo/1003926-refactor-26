<template>
  <section class="page" data-module="threshold">
    <header class="page-head">
      <div>
        <h2>预警阈值管理</h2>
        <p class="page-desc">
          按「阈值编号 + 监测类型」收拢配置线，列表、发布、调整共用一套生效版本；
          人工调整高于自动推荐，历史监测按当时阈值解释。
        </p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openRecommend">生成自动推荐</button>
        <button class="btn" type="button" @click="exportRows">导出预警阈值清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <div v-if="registry.issues.length" class="issue-banner">
      <strong>配置问题（空配置与版本冲突在此统一说明，冲突区间不参与计算）：</strong>
      <ul>
        <li v-for="(issue, index) in registry.issues" :key="index">{{ issue }}</li>
      </ul>
    </div>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <template v-for="chain in visibleChains" :key="`${chain.code}__${chain.monitorType}`">
          <tr v-if="chain.issues.length" class="issue-row">
            <td :colspan="columns.length + 2">
              ⚠ {{ chain.code }} / {{ chain.monitorType }}：{{ chain.issues.join('；') }}
            </td>
          </tr>
          <tr v-for="version in chain.versions" :key="String(version.row.id)">
            <td>{{ version.code }}</td>
            <td>{{ chainHint(version) }}</td>
            <td>{{ version.monitorType }}</td>
            <td>v{{ version.version }}</td>
            <td>{{ sourceText(version) }}</td>
            <td>{{ version.configuredAt }}</td>
            <td>{{ version.effectiveFrom || '—' }}</td>
            <td>{{ version.effectiveTo ?? '（现行）' }}</td>
            <td>{{ formatLevel(version.levels.notice) }}</td>
            <td>{{ formatLevel(version.levels.warning) }}</td>
            <td>{{ formatLevel(version.levels.alert) }}</td>
            <td>{{ version.row[operatorField] }}</td>
            <td>{{ lifecycleText(version) }}</td>
            <td class="row-actions">
              <button
                v-if="version.lifecycle === 'draft'"
                class="link"
                type="button"
                @click="runAction('发布生效', version.row.id)"
              >
                发布生效
              </button>
              <button
                v-if="version.lifecycle === 'active'"
                class="link"
                type="button"
                @click="openAdjust(version)"
              >
                调整阈值
              </button>
              <button
                v-if="version.lifecycle === 'active'"
                class="link danger"
                type="button"
                @click="runAction('废止配置', version.row.id)"
              >
                废止配置
              </button>
              <span v-if="version.lifecycle !== 'draft' && version.lifecycle !== 'active'" class="muted-text">
                历史版本只读
              </span>
            </td>
          </tr>
        </template>
        <tr v-if="!visibleChains.length">
          <td :colspan="columns.length + 2" class="empty-state">
            暂无匹配的阈值配置，可点击「生成自动推荐」或在人工调整表单中登记
          </td>
        </tr>
      </tbody>
    </table>

    <div v-if="formVisible" class="threshold-form">
      <h3>{{ formMode === 'adjust' ? '人工调整阈值' : '生成自动推荐草稿' }}</h3>
      <p class="muted-text">
        {{ formMode === 'adjust'
          ? '人工调整发布后，同区间自动推荐被压制，旧现行版本自动收口为「已调整」。'
          : '自动推荐只生成草稿；与人工调整区间重叠时无法发布，必须以人工调整为准。' }}
      </p>
      <div class="form-grid">
        <label v-for="field in textFields" :key="field" class="filter-item">
          <span>{{ field }}</span>
          <input v-model="form[field]" :disabled="formMode === 'adjust' && (field === '阈值编号' || field === '监测类型')" />
        </label>
      </div>
      <div class="form-actions">
        <button class="btn primary" type="button" @click="submitForm">
          {{ formMode === 'adjust' ? '生成人工调整草稿' : '生成自动推荐草稿' }}
        </button>
        <button class="btn ghost" type="button" @click="formVisible = false">取消</button>
      </div>
    </div>

    <footer class="page-foot">
      <span>共 {{ visibleVersions }} 个阈值版本，归并在 {{ visibleChains.length }} 条配置线上</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'

import {
  downloadEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import { adjustThreshold, recommendThreshold, thresholdSnapshot } from '@/data/threshold/service'
import {
  LIFECYCLE_LABEL,
  SOURCE_LABEL,
} from '@/data/threshold/types'
import type { ThresholdChain, ThresholdVersion } from '@/data/threshold/types'

const meta = moduleMeta('threshold')
const columns = [
  '阈值编号', '隐患点编号', '监测类型', '版本号', '来源',
  '设定日期', '生效日期', '失效日期',
  '注意级阈值', '警示级阈值', '警戒级阈值', '设定人',
]
const operatorField = '设定人'
const filterFields = ['阈值编号', '监测类型']
const textFields = ['阈值编号', '隐患点编号', '监测类型', '设定日期', '生效日期', '注意级阈值', '警示级阈值', '警戒级阈值', '设定人'] as const

const registry = ref<{ chains: ThresholdChain[]; issues: string[] }>({ chains: [], issues: [] })
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const formVisible = ref(false)
const formMode = ref<'adjust' | 'recommend'>('recommend')
const formBaseId = ref<number | null>(null)
const form = reactive<Record<(typeof textFields)[number], string>>({
  阈值编号: '',
  隐患点编号: '',
  监测类型: '雨量',
  设定日期: '',
  生效日期: '',
  注意级阈值: '',
  警示级阈值: '',
  警戒级阈值: '',
  设定人: '值班员',
})

const statusSummary = computed(() =>
  (['草稿', '已生效', '已调整', '已废止'] as const).map((status) => ({
    status,
    count: registry.value.chains.reduce(
      (sum, chain) =>
        sum + chain.versions.filter((version) => version.row.status === status).length,
      0,
    ),
  })),
)

const stats = computed(() => {
  const all = registry.value.chains.flatMap((chain) => chain.versions)
  const monthPrefix = new Date().toISOString().slice(0, 7)
  return [
    { label: '阈值配置数（配置线）', value: registry.value.chains.length },
    { label: '现行有效版本数', value: all.filter((version) => version.lifecycle === 'active').length },
    {
      label: '本月人工调整草稿',
      value: all.filter(
        (version) =>
          version.lifecycle === 'draft' &&
          version.source === 'manual' &&
          version.configuredAt.startsWith(monthPrefix),
      ).length,
    },
  ]
})

const visibleChains = computed(() => {
  const code = filters.value['阈值编号']?.trim() ?? ''
  const type = filters.value['监测类型']?.trim() ?? ''
  return registry.value.chains.filter(
    (chain) =>
      (!code || chain.code.includes(code)) && (!type || chain.monitorType.includes(type)),
  )
})

const visibleVersions = computed(() =>
  visibleChains.value.reduce((sum, chain) => sum + chain.versions.length, 0),
)

function sourceText(version: ThresholdVersion): string {
  return version.suppressed ? `${SOURCE_LABEL[version.source]}（被人工压制）` : SOURCE_LABEL[version.source]
}

function lifecycleText(version: ThresholdVersion): string {
  const label = LIFECYCLE_LABEL[version.lifecycle]
  return version.issues.length ? `${label}（配置异常）` : label
}

function chainHint(version: ThresholdVersion): string {
  // 隐患点编号沿用原行字段，便于和各监测页对上号。
  return String(version.row['隐患点编号'] ?? '—')
}

function formatLevel(value: number | null): string {
  return value === null ? '数值无法解析' : String(value)
}

function resetFilters() {
  filters.value = {}
}

function exportRows() {
  downloadEntries(meta.key)
}

function runAction(action: string, id: number) {
  errorMessage.value = ''
  const result = applyAction(meta.key, id, action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function today(): string {
  return new Date().toISOString().slice(0, 10)
}

function openRecommend() {
  formMode.value = 'recommend'
  formBaseId.value = null
  Object.assign(form, {
    阈值编号: '',
    隐患点编号: '',
    监测类型: '雨量',
    设定日期: today(),
    生效日期: today(),
    注意级阈值: '',
    警示级阈值: '',
    警戒级阈值: '',
    设定人: '系统推荐',
  })
  formVisible.value = true
  errorMessage.value = ''
}

function openAdjust(version: ThresholdVersion) {
  formMode.value = 'adjust'
  formBaseId.value = Number(version.row.id)
  Object.assign(form, {
    阈值编号: version.code,
    隐患点编号: String(version.row['隐患点编号'] ?? ''),
    监测类型: version.monitorType,
    设定日期: today(),
    生效日期: today(),
    注意级阈值: String(version.levels.notice ?? ''),
    警示级阈值: String(version.levels.warning ?? ''),
    警戒级阈值: String(version.levels.alert ?? ''),
    设定人: '值班员',
  })
  formVisible.value = true
  errorMessage.value = ''
}

function submitForm() {
  const levels = {
    notice: Number(form['注意级阈值']),
    warning: Number(form['警示级阈值']),
    alert: Number(form['警戒级阈值']),
  }
  const result =
    formMode.value === 'adjust'
      ? adjustThreshold({
          id: formBaseId.value ?? -1,
          configuredAt: form['设定日期'],
          effectiveFrom: form['生效日期'],
          levels,
          operator: form['设定人'],
        })
      : recommendThreshold({
          code: form['阈值编号'],
          hazardCode: form['隐患点编号'],
          monitorType: form['监测类型'],
          configuredAt: form['设定日期'],
          effectiveFrom: form['生效日期'],
          levels,
          operator: form['设定人'],
        })
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  formVisible.value = false
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    registry.value = thresholdSnapshot()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '预警阈值列表读取失败'
  }
}

onMounted(reload)
</script>

<style scoped>
.issue-banner {
  background: #fef3f2;
  border: 1px solid #fecdca;
  border-radius: 8px;
  padding: 8px 12px;
  margin-bottom: 12px;
  font-size: 13px;
  color: #b42318;
}
.issue-banner ul { margin: 4px 0 0; padding-left: 18px; }
.issue-row td { background: #fef3f2; color: #b42318; }
.threshold-form {
  margin-top: 14px;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 12px;
  background: #fff;
}
.form-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 10px;
  margin: 8px 0;
}
.form-actions { display: flex; gap: 8px; }
.muted-text { color: var(--muted); font-size: 12px; }
.link.danger { color: #b42318; }
</style>
