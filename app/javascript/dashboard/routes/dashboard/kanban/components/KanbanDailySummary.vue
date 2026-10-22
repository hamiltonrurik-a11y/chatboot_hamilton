<script setup>
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useAccount } from 'dashboard/composables/useAccount';
import ConversationAPI from 'dashboard/api/conversations';
import {
  dailySummaryConfig,
  readDailySummary,
  SUMMARY_TIMEZONE,
  summaryDay,
} from '../helpers/dailySummary';

const props = defineProps({
  pipelineId: { type: Number, required: true },
});

const { t, locale } = useI18n();
const { accountId, currentAccount } = useAccount();
const config = computed(() =>
  dailySummaryConfig(currentAccount.value, props.pipelineId)
);
const response = ref(null);
const now = ref(Date.now());
let controller = null;
let timer = null;
let requestId = 0;
let disposed = false;

const scope = computed(() => ({
  accountId: accountId.value,
  pipelineId: props.pipelineId,
  conversationId: config.value?.conversation_id,
}));
const metrics = computed(() =>
  config.value ? readDailySummary(response.value, scope.value, now.value) : null
);
const today = computed(() =>
  summaryDay(now.value).split('-').reverse().join('/')
);
const displayLocale = computed(() => locale.value.replace('_', '-'));
const unavailable = computed(() => t('KANBAN.DAILY_SUMMARY.UNAVAILABLE_VALUE'));
const formatCount = value =>
  new Intl.NumberFormat(displayLocale.value).format(value);
const revenue = computed(() =>
  metrics.value
    ? new Intl.NumberFormat(displayLocale.value, {
        style: 'currency',
        currency: metrics.value.currency,
      }).format(metrics.value.known_revenue_cents / 100)
    : unavailable.value
);
const updatedAt = computed(() =>
  metrics.value
    ? new Intl.DateTimeFormat(displayLocale.value, {
        timeZone: SUMMARY_TIMEZONE,
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
      }).format(new Date(metrics.value.generated_at))
    : ''
);

const refresh = async () => {
  now.value = Date.now();
  if (disposed || !config.value || document.visibilityState !== 'visible')
    return;
  controller?.abort();
  controller = new AbortController();
  requestId += 1;
  const id = requestId;
  const current = scope.value;
  try {
    const { data } = await ConversationAPI.show(current.conversationId, {
      signal: controller.signal,
    });
    if (disposed || id !== requestId) return;
    response.value = data;
    now.value = Date.now();
  } catch {
    if (!disposed && id === requestId) response.value = null;
  } finally {
    if (id === requestId) controller = null;
  }
};

const handleVisibilityChange = () => {
  if (document.visibilityState === 'visible') {
    refresh();
  } else {
    requestId += 1;
    controller?.abort();
    controller = null;
  }
};

watch(
  () => [
    accountId.value,
    props.pipelineId,
    config.value?.conversation_id,
    config.value?.schema_version,
  ],
  () => {
    requestId += 1;
    controller?.abort();
    response.value = null;
    refresh();
  },
  { immediate: true }
);

onMounted(() => {
  document.addEventListener('visibilitychange', handleVisibilityChange);
  timer = setInterval(refresh, 30000);
});

onUnmounted(() => {
  disposed = true;
  requestId += 1;
  controller?.abort();
  clearInterval(timer);
  document.removeEventListener('visibilitychange', handleVisibilityChange);
});
</script>

<template>
  <div class="contents">
    <section
      v-if="config"
      class="flex-shrink-0 border-b border-slate-100 px-4 py-3 dark:border-slate-700"
      aria-live="polite"
    >
      <div class="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h2 class="text-sm font-semibold text-slate-800 dark:text-slate-100">
          {{ t('KANBAN.DAILY_SUMMARY.TITLE') }}
        </h2>
        <span class="text-xs text-slate-500 dark:text-slate-400">
          {{ t('KANBAN.DAILY_SUMMARY.DATE', { date: today }) }}
        </span>
      </div>
      <dl class="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div>
          <dt class="text-xs text-slate-500 dark:text-slate-400">
            {{ t('KANBAN.DAILY_SUMMARY.ATTENDANCES') }}
          </dt>
          <dd class="text-xl font-semibold text-slate-800 dark:text-slate-100">
            {{ metrics ? formatCount(metrics.attendance_count) : unavailable }}
          </dd>
        </div>
        <div>
          <dt class="text-xs text-slate-500 dark:text-slate-400">
            {{ t('KANBAN.DAILY_SUMMARY.SALES') }}
          </dt>
          <dd class="text-xl font-semibold text-slate-800 dark:text-slate-100">
            {{ metrics ? formatCount(metrics.sales_count) : unavailable }}
          </dd>
        </div>
        <div>
          <dt class="text-xs text-slate-500 dark:text-slate-400">
            {{ t('KANBAN.DAILY_SUMMARY.REVENUE') }}
          </dt>
          <dd class="text-xl font-semibold text-slate-800 dark:text-slate-100">
            {{ revenue }}
          </dd>
        </div>
      </dl>
      <p class="mt-2 text-xs text-slate-500 dark:text-slate-400">
        {{
          metrics
            ? t('KANBAN.DAILY_SUMMARY.UPDATED_AT', { time: updatedAt })
            : t('KANBAN.DAILY_SUMMARY.UNAVAILABLE')
        }}
        <span v-if="metrics?.unknown_sales_count">
          {{
            t('KANBAN.DAILY_SUMMARY.UNKNOWN_SALES', {
              count: metrics.unknown_sales_count,
            })
          }}
        </span>
      </p>
    </section>
  </div>
</template>
