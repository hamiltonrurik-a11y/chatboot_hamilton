<script setup>
import { ref, computed, watch, onMounted } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRoute } from 'vue-router';
import { useStore, useMapGetter } from 'dashboard/composables/store';
import { useUISettings } from 'dashboard/composables/useUISettings';
import KanbanBoard from '../components/KanbanBoard.vue';
import KanbanEmptyState from '../components/KanbanEmptyState.vue';
import KanbanCardDetail from '../components/KanbanCardDetail.vue';
import PipelineSelector from '../components/PipelineSelector.vue';
import AddItemModal from '../components/AddItemModal.vue';
import KanbanFilterBar from '../components/KanbanFilterBar.vue';
import KanbanSortMenu from '../components/KanbanSortMenu.vue';
import ExportItemModal from '../components/ExportItemModal.vue';
import LostReasonModal from '../components/LostReasonModal.vue';
import KanbanDailySummary from '../components/KanbanDailySummary.vue';

const { t } = useI18n();
const store = useStore();
const route = useRoute();

const pipelines = useMapGetter('kanban/getPipelines');
const activePipeline = useMapGetter('kanban/getActivePipeline');
const uiFlags = useMapGetter('kanban/getUIFlags');

const hasPipelines = computed(() => pipelines.value.length > 0);

const { kanbanBoardSettings } = useUISettings();

// Applies the pipeline's saved filters/sort AND (re)fetches every column with them in the same
// step - committing the saved sort without refetching would leave the board showing whatever
// page 1 loaded under the *previous* sort (filtering/sorting is server-side, task 03/08 - a
// column only knows the page(s) it already fetched, it can't reach the rest of the stage on its
// own). This watcher is the single place activePipelineId changes route through (initial mount
// here, or a pipeline switch via PipelineSelector.vue), so it's also the only place that needs
// to call resetBoard.
// Watches the id, not the pipeline object (task 23): getActivePipeline reads $state.pipelines[id],
// and that object gets a fresh identity from EDIT_PIPELINE (saving the pipeline's settings) or
// SET_PIPELINES (any fetchPipelines after the first) without activePipelineId itself changing -
// watching the object fired this whole reset (losing whatever page an agent had scrolled to) on
// every unrelated pipeline settings save.
watch(
  () => activePipeline.value?.id,
  async pipelineId => {
    if (!pipelineId) return;
    const saved = kanbanBoardSettings(pipelineId);
    store.commit('kanban/SET_KANBAN_FILTERS', saved.filters);
    store.commit('kanban/SET_KANBAN_SORT', saved.sort);
    store.commit('kanban/SET_SHOW_ONLY_MINE', saved.showOnlyMine);
    store.dispatch('pipelineMembers/get', { pipelineId });
    await store.dispatch('kanban/resetBoard');
  },
  { immediate: true }
);

const showAddItemModal = ref(false);
const selectedStageId = ref(null);
const selectedCardId = ref(null);
const selectedCard = computed(() =>
  selectedCardId.value != null
    ? (store.state.kanban.items[selectedCardId.value] ?? null)
    : null
);

onMounted(async () => {
  store.dispatch('attributes/get');
  store.dispatch('accounts/get', { silent: true });
  await store.dispatch('kanban/fetchPipelines');
  if (hasPipelines.value) {
    const targetPipelineId =
      Number(route.query.pipelineId) ||
      activePipeline.value?.id ||
      pipelines.value[0]?.id;
    if (targetPipelineId) {
      // The activePipeline watcher above (immediate: true) picks this up and does the actual
      // settings-restore + resetBoard - committing here is what makes it fire.
      store.commit('kanban/SET_ACTIVE_PIPELINE', targetPipelineId);
    }
    if (route.query.itemId) {
      selectedCardId.value = Number(route.query.itemId);
    }
  }
});

const openAddItem = stageId => {
  selectedStageId.value = stageId;
  showAddItemModal.value = true;
};

const openCardDetail = item => {
  selectedCardId.value = item.id;
};

const closeCardDetail = () => {
  selectedCardId.value = null;
};

const itemToExport = ref(null);
const openExportModal = item => {
  itemToExport.value = item;
};
const closeExportModal = () => {
  if (itemToExport.value && selectedCardId.value === itemToExport.value.id) {
    selectedCardId.value = null;
  }
  itemToExport.value = null;
};
</script>

<template>
  <div class="flex flex-col h-full overflow-hidden">
    <div
      class="flex items-center px-4 py-3 border-b border-slate-100 dark:border-slate-700 flex-shrink-0 gap-3"
    >
      <h1 class="text-base font-semibold text-slate-800 dark:text-slate-100">
        {{ t('KANBAN.TITLE') }}
      </h1>
      <PipelineSelector v-if="hasPipelines" />
      <KanbanFilterBar v-if="activePipeline" />
      <KanbanSortMenu v-if="activePipeline" />
    </div>

    <KanbanDailySummary
      v-if="activePipeline"
      :pipeline-id="activePipeline.id"
    />

    <div
      v-if="uiFlags.isFetchingPipelines"
      class="flex flex-1 items-center justify-center"
    >
      <span class="i-lucide-loader size-8 animate-spin text-woot-500" />
    </div>

    <KanbanEmptyState v-else-if="!hasPipelines" />

    <KanbanBoard
      v-else-if="activePipeline"
      @card-click="openCardDetail"
      @add-item="openAddItem"
      @export="openExportModal"
    />

    <KanbanCardDetail
      :item="selectedCard"
      @close="closeCardDetail"
      @export="openExportModal"
    />

    <AddItemModal
      v-if="showAddItemModal"
      :stage-id="selectedStageId"
      @close="showAddItemModal = false"
      @created="showAddItemModal = false"
    />

    <ExportItemModal
      v-if="itemToExport"
      :item="itemToExport"
      @close="closeExportModal"
    />

    <LostReasonModal />
  </div>
</template>
