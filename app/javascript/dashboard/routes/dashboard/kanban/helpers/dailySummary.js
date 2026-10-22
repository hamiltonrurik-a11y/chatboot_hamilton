export const SUMMARY_TIMEZONE = 'America/Sao_Paulo';
export const SUMMARY_MAX_AGE = 5 * 60 * 1000;

export const summaryDay = now =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: SUMMARY_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(now));

const positiveInteger = value => Number.isSafeInteger(value) && value > 0;
const counter = value => Number.isSafeInteger(value) && value >= 0;

export const dailySummaryConfig = (account, pipelineId) => {
  const config = account?.custom_attributes?.rgb_daily_summary_config;
  if (
    !config ||
    config.schema_version !== 1 ||
    config.pipeline_id !== pipelineId ||
    !positiveInteger(config.conversation_id) ||
    config.timezone !== SUMMARY_TIMEZONE
  ) {
    return null;
  }
  return config;
};

export const readDailySummary = (conversation, scope, now) => {
  const value = conversation?.custom_attributes?.rgb_daily_summary;
  const generatedAt = Date.parse(value?.generated_at);
  if (
    Number(conversation?.id) !== scope.conversationId ||
    Number(conversation?.account_id) !== scope.accountId ||
    value?.schema_version !== 1 ||
    value.account_id !== scope.accountId ||
    value.pipeline_id !== scope.pipelineId ||
    value.timezone !== SUMMARY_TIMEZONE ||
    value.currency !== 'BRL' ||
    value.date !== summaryDay(now) ||
    !Number.isFinite(generatedAt) ||
    generatedAt > now + 5000 ||
    generatedAt < now - SUMMARY_MAX_AGE ||
    ![
      value.attendance_count,
      value.sales_count,
      value.known_revenue_cents,
      value.unknown_sales_count,
    ].every(counter) ||
    value.unknown_sales_count > value.sales_count
  ) {
    return null;
  }
  return value;
};
