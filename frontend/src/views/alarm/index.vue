<template>
  <section class="page" data-module="alarm">
    <header class="page-head">
      <div>
        <h2>预警发布管理</h2>
        <p class="page-desc">维护预警通知，围绕通知编号、隐患点编号、预警等级、触发条件做登记、筛选与状态流转。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记预警通知</button>
        <button class="btn" type="button" @click="exportRows">导出预警发布清单</button>
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
      <strong>阈值配置问题（预警发布与雨量、倾斜读取同一份结果；空配置 / 版本冲突时禁止发布）：</strong>
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
          <th>发布阈值校验（共用）</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>
            <span :class="publishCheck(row).tone">{{ publishCheck(row).text }}</span>
          </td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-for="action in actions"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 3" class="empty-state">暂无预警发布数据，可先登记预警通知</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条预警发布记录</span>
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
import { alarmPublishContext } from '@/data/threshold/eval'
import type { ThresholdRegistry } from '@/data/threshold/registry'
import { thresholdSnapshot } from '@/data/threshold/service'
import { LEVEL_LABEL } from '@/data/threshold/types'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('alarm')
const columns = ["通知编号", "隐患点编号", "预警等级", "触发条件", "发布时间", "接收单位", "发布人", "通知状态"]
const actions = ["确认发布", "登记响应", "解除预警"]
const statuses = ["待发布", "已发布", "已响应", "已解除", "误报"]
const stats = [{"label": "本月预警数", "value": 0}, {"label": "已响应数", "value": 0}, {"label": "未解除数", "value": 0}]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const registry = ref<ThresholdRegistry>({ chains: [], issues: [] })
const filterFields = columns.slice(0, 3)

// 预警发布读取的就是统一判定：发布按当时有效版本核定等级，已发布的历史行展示其存档依据。
function publishCheck(row: EntryRow): { text: string; tone: string } {
  if (String(row.status) !== '待发布') {
    return { text: '—', tone: 'judge-normal' }
  }
  const { evaluation } = alarmPublishContext(registry.value, row)
  if (evaluation.status === 'empty') {
    return { text: `禁止发布：${evaluation.reason}`, tone: 'judge-conflict' }
  }
  if (evaluation.status === 'conflict') {
    return { text: `禁止发布：${evaluation.reason}`, tone: 'judge-conflict' }
  }
  if (evaluation.status === 'invalid') {
    return { text: `禁止发布：${evaluation.reason}`, tone: 'judge-conflict' }
  }
  if (!evaluation.hit) {
    return { text: `禁止发布：${LEVEL_LABEL[evaluation.level]}，未达注意级`, tone: 'judge-empty' }
  }
  return {
    text: `可发布：${LEVEL_LABEL[evaluation.level]}（v${evaluation.version.version}）`,
    tone: 'judge-hit',
  }
}
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '预警通知登记入口尚未接入审批流'
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
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
    registry.value = thresholdSnapshot()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '预警发布列表读取失败'
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
.judge-hit { color: #067647; font-weight: 600; }
.judge-conflict { color: #b42318; }
.judge-empty { color: var(--muted); }
.judge-normal { color: var(--muted); }
</style>
