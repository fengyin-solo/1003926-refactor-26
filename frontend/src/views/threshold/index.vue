<template>
  <section class="page" data-module="threshold">
    <header class="page-head">
      <div>
        <h2>预警阈值管理</h2>
        <p class="page-desc">
          列表、发布、调整共用一套版本：同一「阈值编号 + 监测类型」按版本迭代；人工调整高于自动推荐，历史监测按当时阈值解释。
        </p>
      </div>
      <div class="page-actions">
        <button class="btn" type="button" @click="exportRows">导出预警阈值清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <div v-if="conflictIssues.length" class="issue-banner danger">
      <strong>存在冲突版本，发布/调整/废止外的计算已阻断：</strong>
      <ul>
        <li v-for="issue in conflictIssues" :key="issue.thresholdCode + issue.reason">
          {{ issue.thresholdCode }}（{{ issue.monitorType }}）：{{ issue.reason }}
        </li>
      </ul>
    </div>
    <div v-if="noteIssues.length" class="issue-banner hint">
      <strong>并行来源说明（按人工调整高于自动推荐取值）：</strong>
      <ul>
        <li v-for="issue in noteIssues" :key="issue.thresholdCode + issue.reason">
          {{ issue.thresholdCode }}（{{ issue.monitorType }}）：{{ issue.reason }}
        </li>
      </ul>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

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
          <th>说明</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>{{ statusLabel(row.status) }}</td>
          <td class="remark-cell">{{ row['备注'] || '—' }}</td>
          <td class="row-actions">
            <button
              v-for="action in availableActions(row)"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
            <span v-if="!availableActions(row).length" class="muted">仅可查看</span>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 3" class="empty-state">暂无预警阈值版本</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 个阈值版本（草稿与已废止一并列出）</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import { listThresholdIssues } from '@/domain/threshold'
import { STATUS_LABELS } from '@/domain/threshold'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('threshold')
const columns = [
  '阈值编号',
  '版本',
  '隐患点编号',
  '监测类型',
  '来源',
  '注意级阈值',
  '警示级阈值',
  '警戒级阈值',
  '生效日期',
  '失效日期',
  '设定人',
  '设定日期',
]
const filterFields = ['阈值编号', '监测类型', '隐患点编号']

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})

const issues = ref(listThresholdIssues())
const conflictIssues = computed(() => issues.value.filter((issue) => issue.level === 'conflict'))
const noteIssues = computed(() => issues.value.filter((issue) => issue.level === 'note'))

const stats = computed(() => [
  { label: '阈值版本数', value: rows.value.length },
  { label: '已生效版本', value: rows.value.filter((row) => row.status === 'active').length },
  { label: '草稿待发布', value: rows.value.filter((row) => row.status === 'draft').length },
  { label: '冲突版本', value: conflictIssues.value.length },
])

const statusSummary = computed(() =>
  ['draft', 'active', 'superseded', 'abolished'].map((status) => ({
    status: STATUS_LABELS[status as keyof typeof STATUS_LABELS],
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

function statusLabel(status: string | number | boolean): string {
  return STATUS_LABELS[String(status) as keyof typeof STATUS_LABELS] ?? String(status)
}

/** 只有草稿可发布、现行可调整/废止；已废止/已调整仅可查看，从入口上杜绝旧版本复活。 */
function availableActions(row: EntryRow): string[] {
  if (row.status === 'draft') {
    return ['发布生效']
  }
  if (row.status === 'active') {
    return ['调整阈值', '废止配置']
  }
  return []
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function promptEffectiveFrom(): string | null {
  const value = window.prompt('生效日期（YYYY-MM-DD，留空为明天）', '')
  return value === null ? null : value.trim()
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  let payload: unknown
  if (action === '发布生效') {
    const effectiveFrom = promptEffectiveFrom()
    if (effectiveFrom === null) {
      return
    }
    payload = effectiveFrom ? { effectiveFrom } : {}
  } else if (action === '调整阈值') {
    const result = window.prompt(
      '调整阈值，依次填写 注意级,警示级,警戒级（人工调整即时生效）',
      `${row['注意级阈值']},${row['警示级阈值']},${row['警戒级阈值']}`,
    )
    if (result === null) {
      return
    }
    const values = result
      .split(',')
      .map((part) => Number(part.trim()))
    if (values.length !== 3 || values.some((value) => !Number.isFinite(value))) {
      errorMessage.value = '阈值输入无效，需要三个以逗号分隔的数字'
      return
    }
    const effectiveFrom = promptEffectiveFrom()
    if (effectiveFrom === null) {
      return
    }
    payload = {
      values: { attention: values[0], warning: values[1], alarm: values[2] },
      ...(effectiveFrom ? { effectiveFrom } : {}),
    }
  } else if (action === '废止配置') {
    if (!window.confirm(`确认废止 ${row['阈值编号']} ${row['版本']}？废止后不可再发布`)) {
      return
    }
  }
  const outcome = applyAction(meta.key, Number(row.id), action, payload)
  if (!outcome.ok) {
    errorMessage.value = outcome.message
    return
  }
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
    issues.value = listThresholdIssues()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '预警阈值列表读取失败'
  }
}

onMounted(reload)
</script>

<style scoped>
.issue-banner {
  border: 1px solid var(--border-color, #d9d9d9);
  border-radius: 6px;
  padding: 10px 14px;
  margin: 12px 0;
}

.issue-banner.danger {
  border-color: #d4380d;
  background: #fff2e8;
  color: #ad2102;
}

.issue-banner.hint {
  border-color: #d9d9d9;
  background: #fafafa;
  color: #595959;
}

.issue-banner ul {
  margin: 6px 0 0;
  padding-left: 18px;
}

.remark-cell {
  max-width: 260px;
  color: #8c8c8c;
  font-size: 12px;
}

.muted {
  color: #bfbfbf;
}
</style>
