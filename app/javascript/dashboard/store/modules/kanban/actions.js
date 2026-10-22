import PipelinesAPI from 'dashboard/api/pipelines';
import PipelineItemsAPI from 'dashboard/api/pipelineItems';
import PipelineItemLabelsAPI from 'dashboard/api/pipelineItemLabels';
import { useAlert } from 'dashboard/composables';
import i18n from 'dashboard/i18n/instance';
import { useLostReasonPrompt } from 'dashboard/composables/useLostReasonPrompt';
import { throwErrorMessage } from '../../utils/api';
import { itemMatchesActiveFilters, buildKanbanQueryParams } from './getters';

// Keep request/timer bookkeeping outside Vuex. A new view gets a new scope, so a
// late response cannot replace the board after a pipeline, filter or sort change.
const boardSync = new WeakMap();
const REFRESH_DELAY = 150;

function syncScope(state) {
  const key = JSON.stringify([
    state.activePipelineId,
    buildKanbanQueryParams(state),
  ]);
  let scope = boardSync.get(state);
  if (scope?.key !== key) {
    if (scope?.timer) clearTimeout(scope.timer);
    scope = {
      key,
      pending: new Set(),
      requests: new Map(),
      revisions: new Map(),
      itemVersions: new Map(),
      timer: null,
    };
    boardSync.set(state, scope);
  }
  return scope;
}

function flushPending(context) {
  const { state, dispatch } = context;
  const scope = syncScope(state);
  if (!scope.pending.size || scope.timer) return;
  scope.timer = setTimeout(() => {
    scope.timer = null;
    if (syncScope(state) !== scope) return;
    [...scope.pending].forEach(stageId => {
      if (state.stageItems[stageId]?.isFetching) return;
      scope.pending.delete(stageId);
      dispatch('refreshStageItems', {
        pipelineId: state.activePipelineId,
        stageId,
      });
    });
  }, REFRESH_DELAY);
}

function queueStageRefresh(context, stageIds) {
  const scope = syncScope(context.state);
  new Set(stageIds).forEach(stageId => {
    if (!context.state.stageItems[stageId]) return;
    scope.pending.add(stageId);
    scope.revisions.set(stageId, (scope.revisions.get(stageId) || 0) + 1);
  });
  flushPending(context);
}

function stageRequest(context, stageId) {
  const { state, commit } = context;
  const scope = syncScope(state);
  const token = Symbol('stage request');
  const revision = scope.revisions.get(stageId);
  scope.pending.delete(stageId);
  scope.requests.set(stageId, token);
  const ownsRequest = () =>
    syncScope(state) === scope && scope.requests.get(stageId) === token;
  return {
    current: () => ownsRequest() && scope.revisions.get(stageId) === revision,
    finish: () => {
      if (!ownsRequest()) return;
      commit('SET_STAGE_FETCHING', { stageId, isFetching: false });
      flushPending(context);
    },
  };
}

function isStalePush(state, item) {
  const scope = syncScope(state);
  const existing = state.items[item.id];
  const incoming = item.updated_at_usec || (item.updated_at || 0) * 1000000;
  const stored = Math.max(
    scope.itemVersions.get(item.id) || 0,
    existing?.updated_at_usec || (existing?.updated_at || 0) * 1000000
  );
  if (
    incoming &&
    (incoming < stored || (item.updated_at_usec && incoming === stored))
  ) {
    return true;
  }
  if (incoming) {
    scope.itemVersions.delete(item.id);
    scope.itemVersions.set(item.id, incoming);
    // Only recent unloaded pushes need this cache; loaded cards also carry their version.
    if (scope.itemVersions.size > 5000) {
      scope.itemVersions.delete(scope.itemVersions.keys().next().value);
    }
  }
  return false;
}

// Where a card that a realtime push just moved into a stage belongs in that stage's loaded list
// (task 28), or null when it can't be placed there. The list is a prefix of the server's order,
// and that order is only `(position, id)` when the manual sort is active - for any other sort
// (value, created_at, ...) working out the slot would mean re-implementing the server's
// comparator, so the card is left out of the list and counted as unloaded instead: it shows up in
// the right place on the next fetch. Same when it sorts after everything loaded and the column
// has more pages - the cards in between aren't here, so appending it would put it too early.
// Positions come from `state.items`, which isn't refreshed for cards someone else reordered, so
// the slot can be off by a few places after manual reorders; the next fetch corrects it.
function realtimeInsertIndex(state, item) {
  if (state.activeSort.field !== 'position' || state.activeSort.order !== 'asc')
    return null;

  const stage = state.stageItems[item.pipeline_stage_id];
  const ids = stage?.ids || [];
  const index = ids.findIndex(id => {
    const other = state.items[id];
    if (!other) return false;
    return (
      other.position > item.position ||
      (other.position === item.position && other.id > item.id)
    );
  });
  if (index !== -1) return index;
  return stage?.hasMore ? null : ids.length;
}

export const actions = {
  fetchPipelines: async ({ commit }) => {
    commit('SET_KANBAN_UI_FLAG', { isFetchingPipelines: true });
    try {
      const { data } = await PipelinesAPI.get();
      commit('SET_PIPELINES', data);
    } finally {
      commit('SET_KANBAN_UI_FLAG', { isFetchingPipelines: false });
    }
  },

  // Page 1 of one column. Replaces whatever was loaded for that stage. Errors are caught here,
  // not left to the caller (task 21): resetBoard fans this out to every column via Promise.all,
  // and one column's rejection must not take the others down with it or surface as an unhandled
  // rejection - it turns into a per-column error state instead (KanbanColumn.vue), which is also
  // how the column tells "failed to load" apart from "genuinely empty".
  fetchStageItems: async (context, { pipelineId, stageId }) => {
    const { commit, state } = context;
    if (state.activePipelineId !== pipelineId) return;
    const request = stageRequest(context, stageId);
    commit('SET_STAGE_FETCHING', { stageId, isFetching: true });
    try {
      const { data } = await PipelinesAPI.getBoardItems(pipelineId, {
        stage_id: stageId,
        page: 1,
        ...buildKanbanQueryParams(state),
      });
      if (!request.current()) return;
      commit('SET_STAGE_ITEMS_PAGE', {
        stageId,
        items: data.payload,
        count: data.meta.count,
        page: 1,
      });
    } catch {
      if (request.current())
        commit('SET_STAGE_ERROR', { stageId, hasError: true });
    } finally {
      request.finish();
    }
  },

  // Next page of one column, appended. No-op if already fetching or there's nothing more to
  // load - the IntersectionObserver driving this (task 06) can fire more than once in a row.
  // Same error handling as fetchStageItems (task 21) - a failed "load more" leaves the already-
  // loaded cards on screen and marks the column so the observer stops retrying in a loop.
  fetchMoreStageItems: async (context, { pipelineId, stageId }) => {
    const { commit, state } = context;
    const current = state.stageItems[stageId];
    if (
      state.activePipelineId !== pipelineId ||
      !current ||
      current.isFetching ||
      !current.hasMore
    )
      return;

    const request = stageRequest(context, stageId);
    commit('SET_STAGE_FETCHING', { stageId, isFetching: true });
    try {
      const nextPage = current.page + 1;
      const { data } = await PipelinesAPI.getBoardItems(pipelineId, {
        stage_id: stageId,
        page: nextPage,
        ...buildKanbanQueryParams(state),
      });
      if (!request.current()) return;
      commit('APPEND_STAGE_ITEMS_PAGE', {
        stageId,
        items: data.payload,
        count: data.meta.count,
        page: nextPage,
      });
    } catch {
      if (request.current())
        commit('SET_STAGE_ERROR', { stageId, hasError: true });
    } finally {
      request.finish();
    }
  },

  // Reload the loaded prefix atomically in server order. Do not collapse a column
  // back to page 1 or fetch the entire pipeline on every incoming message.
  refreshStageItems: async (context, { pipelineId, stageId }) => {
    const { commit, state } = context;
    if (state.activePipelineId !== pipelineId) return;
    const current = state.stageItems[stageId];
    if (!current) return;
    if (current.isFetching) {
      queueStageRefresh(context, [stageId]);
      return;
    }
    const pages = Math.max(1, current.page);
    const params = buildKanbanQueryParams(state);
    const request = stageRequest(context, stageId);
    commit('SET_STAGE_FETCHING', { stageId, isFetching: true });
    try {
      let items = [];
      let count = 0;
      let page = 0;
      while (page < pages) {
        page += 1;
        // Sequential requests keep each refresh bounded to one request in flight per column.
        // eslint-disable-next-line no-await-in-loop
        const { data } = await PipelinesAPI.getBoardItems(pipelineId, {
          stage_id: stageId,
          page,
          ...params,
        });
        if (!request.current()) return;
        items = [...items, ...data.payload];
        count = data.meta.count;
        if (!data.payload.length || items.length >= count) break;
      }
      items = [...new Map(items.map(item => [item.id, item])).values()];
      commit('SET_STAGE_ITEMS_PAGE', { stageId, items, count, page });
    } catch {
      if (request.current())
        commit('SET_STAGE_ERROR', { stageId, hasError: true });
    } finally {
      request.finish();
    }
  },

  refreshLoadedBoard: async ({ dispatch, state }) => {
    const pipelineId = state.activePipelineId;
    if (!pipelineId) return;
    const stageIds = (state.stageOrder[pipelineId] || []).filter(
      stageId => state.stageItems[stageId]
    );
    await Promise.all(
      stageIds.map(stageId =>
        dispatch('refreshStageItems', { pipelineId, stageId })
      )
    );
  },

  // Refetches page 1 of every column of the active pipeline - used on initial load, pipeline
  // switch, and (task 06) whenever a filter or sort changes. fetchStageItems never rejects (task
  // 21), so one broken column can't stop Promise.all from resolving for the rest - a single
  // aggregated alert covers however many columns came back with an error, instead of one per
  // column (which would just be noise on a flaky-network reload of the whole board).
  resetBoard: async ({ dispatch, state }) => {
    const pipelineId = state.activePipelineId;
    const stageIds = state.stageOrder[pipelineId] || [];
    await Promise.all(
      stageIds.map(stageId =>
        dispatch('fetchStageItems', { pipelineId, stageId })
      )
    );
    const failedCount = stageIds.filter(
      stageId => state.stageItems[stageId]?.hasError
    ).length;
    if (failedCount) {
      useAlert(
        i18n.global.t(
          'KANBAN.BOARD.COLUMNS_LOAD_FAILED',
          { count: failedCount },
          failedCount
        )
      );
    }
  },

  createPipeline: async ({ commit }, pipelineData) => {
    commit('SET_KANBAN_UI_FLAG', { isCreating: true });
    try {
      const { data } = await PipelinesAPI.create({ pipeline: pipelineData });
      commit('SET_PIPELINE_ITEM', data);
      return data;
    } finally {
      commit('SET_KANBAN_UI_FLAG', { isCreating: false });
    }
  },

  updatePipeline: async ({ commit }, { id, ...pipelineData }) => {
    commit('SET_KANBAN_UI_FLAG', { isUpdating: true });
    try {
      const { data } = await PipelinesAPI.update(id, {
        pipeline: pipelineData,
      });
      commit('EDIT_PIPELINE', data);
      return data;
    } finally {
      commit('SET_KANBAN_UI_FLAG', { isUpdating: false });
    }
  },

  deletePipeline: async ({ commit }, pipelineId) => {
    commit('SET_KANBAN_UI_FLAG', { isDeleting: true });
    try {
      await PipelinesAPI.delete(pipelineId);
      commit('DELETE_PIPELINE', pipelineId);
    } finally {
      commit('SET_KANBAN_UI_FLAG', { isDeleting: false });
    }
  },

  createStage: async ({ commit }, { pipelineId, ...stageData }) => {
    commit('SET_KANBAN_UI_FLAG', { isCreating: true });
    try {
      const { data } = await PipelinesAPI.createStage(pipelineId, {
        pipeline_stage: stageData,
      });
      commit('SET_STAGE_ITEM', { pipelineId, stage: data });
      return data;
    } finally {
      commit('SET_KANBAN_UI_FLAG', { isCreating: false });
    }
  },

  updateStage: async ({ commit }, { pipelineId, stageId, ...stageData }) => {
    commit('SET_KANBAN_UI_FLAG', { isUpdating: true });
    try {
      const { data } = await PipelinesAPI.updateStage(pipelineId, stageId, {
        pipeline_stage: stageData,
      });
      commit('EDIT_STAGE', data);
      return data;
    } finally {
      commit('SET_KANBAN_UI_FLAG', { isUpdating: false });
    }
  },

  deleteStage: async ({ commit }, { pipelineId, stageId }) => {
    commit('SET_KANBAN_UI_FLAG', { isDeleting: true });
    try {
      await PipelinesAPI.deleteStage(pipelineId, stageId);
      commit('DELETE_STAGE', { pipelineId, stageId });
    } finally {
      commit('SET_KANBAN_UI_FLAG', { isDeleting: false });
    }
  },

  createItem: async ({ commit }, itemData) => {
    commit('SET_KANBAN_UI_FLAG', { isCreating: true });
    try {
      const { data } = await PipelineItemsAPI.create({
        pipeline_item: itemData,
      });
      commit('SET_ITEM', data);
      return data;
    } catch (error) {
      throwErrorMessage(error);
      return null;
    } finally {
      commit('SET_KANBAN_UI_FLAG', { isCreating: false });
    }
  },

  updateItem: async ({ commit }, { id, ...itemData }) => {
    commit('SET_KANBAN_UI_FLAG', { isUpdating: true });
    try {
      const { data } = await PipelineItemsAPI.update(id, {
        pipeline_item: itemData,
      });
      commit('EDIT_ITEM', data);
      return data;
    } finally {
      commit('SET_KANBAN_UI_FLAG', { isUpdating: false });
    }
  },

  deleteItem: async ({ commit, state }, itemId) => {
    commit('SET_KANBAN_UI_FLAG', { isDeleting: true });
    try {
      const item = state.items[itemId];
      await PipelineItemsAPI.delete(itemId);
      commit('DELETE_ITEM', {
        stageId: item?.pipeline_stage_id,
        itemId,
      });
    } finally {
      commit('SET_KANBAN_UI_FLAG', { isDeleting: false });
    }
  },

  // Both drag-and-drop (KanbanBoard.handleCardMove) and manual edit
  // (KanbanCardDetail.handleSave) dispatch this directly, so the lost-reason prompt lives
  // here rather than in either caller. The commit below already moves the card optimistically
  // (vuedraggable has already moved it visually too) - if the destination is a `lost` stage
  // and no reason was pre-supplied, pause for a reason before persisting. Cancelling reuses
  // the exact same rollback commit as an API error, which the callers' `watch(storeItems...)`
  // already resyncs from.
  // `position` is expected to already be absolute within the destination stage (not a
  // page-local index) - translating a drop's visual index into that absolute position is the
  // caller's job (task 06), since it depends on exactly which pages are loaded there.
  // Returns true only when the move was actually persisted; false when the user cancelled the
  // lost-reason prompt or the API call failed. Both failure paths already rolled back and (for
  // the API error) alerted, so a caller acting on `false` should stay silent and just not
  // report success - KanbanCardDetail.handleSave depends on this to avoid claiming a save that
  // did not happen. Drag-and-drop ignores the return value, which is fine: the board's own
  // state is already correct either way.
  moveItem: async (
    { commit, state },
    { itemId, fromStageId, toStageId, position, pipelineLostReasonId = null }
  ) => {
    // Read before the optimistic commit below moves it - the rollback puts the card back at this
    // index (task 28), not at the top of the source column.
    const originalIndex = Math.max(
      0,
      state.stageItems[fromStageId]?.ids.indexOf(itemId) ?? 0
    );
    commit('MOVE_ITEM', { itemId, fromStageId, toStageId, position });

    const rollback = () => {
      commit('MOVE_ITEM', {
        itemId,
        fromStageId: toStageId,
        toStageId: fromStageId,
        position: originalIndex,
      });
    };

    let reasonId = pipelineLostReasonId;
    if (state.stages[toStageId]?.stage_type === 'lost' && !reasonId) {
      const { promptForLostReason } = useLostReasonPrompt();
      reasonId = await promptForLostReason();
      if (!reasonId) {
        rollback();
        return false;
      }
    }

    try {
      const { data } = await PipelineItemsAPI.update(itemId, {
        pipeline_item: {
          pipeline_stage_id: toStageId,
          position,
          ...(reasonId ? { pipeline_lost_reason_id: reasonId } : {}),
        },
      });
      commit('EDIT_ITEM', data);
      return true;
    } catch {
      rollback();
      useAlert(i18n.global.t('KANBAN.BOARD.MOVE_ITEM_FAILED'));
      return false;
    }
  },

  reorderStages: async ({ commit }, { pipelineId, orderedIds }) => {
    commit('REORDER_STAGES', { pipelineId, orderedIds });
    try {
      await PipelinesAPI.reorderStages(pipelineId, orderedIds);
    } catch {
      useAlert(i18n.global.t('KANBAN.BOARD.REORDER_STAGES_FAILED'));
    }
  },

  // startPosition is the offset of the page being reordered (0 for the first page) - the
  // caller (task 06) is responsible for knowing which page's cards orderedIds represents.
  reorderItems: async (
    { commit },
    { stageId, orderedIds, startPosition = 0 }
  ) => {
    commit('REORDER_ITEMS', { stageId, orderedIds });
    try {
      await PipelineItemsAPI.reorder(stageId, orderedIds, startPosition);
    } catch {
      useAlert(i18n.global.t('KANBAN.BOARD.REORDER_ITEMS_FAILED'));
    }
  },

  fetchItemLabels: async ({ commit }, itemId) => {
    const { data } = await PipelineItemLabelsAPI.get(itemId);
    commit('EDIT_ITEM', { id: itemId, label_list: data.payload });
    return data.payload;
  },

  updateItemLabels: async ({ commit }, { itemId, labels }) => {
    const { data } = await PipelineItemLabelsAPI.update(itemId, labels);
    commit('EDIT_ITEM', { id: itemId, label_list: data.payload });
    return data.payload;
  },

  exportItem: async (
    { commit, state },
    { itemId, targetPipelineId, targetStageId }
  ) => {
    commit('SET_KANBAN_UI_FLAG', { isExporting: true });
    try {
      const item = state.items[itemId];
      const { data } = await PipelineItemsAPI.export(itemId, {
        targetPipelineId,
        targetStageId,
      });
      commit('DELETE_ITEM', { stageId: item?.pipeline_stage_id, itemId });
      return data;
    } finally {
      commit('SET_KANBAN_UI_FLAG', { isExporting: false });
    }
  },

  fetchItemsForContact: async ({ commit }, contactId) => {
    const { data } = await PipelineItemsAPI.getByContact(contactId);
    data.forEach(item => commit('SET_ITEM_DATA', item));
    return data;
  },

  fetchItemsForConversation: async ({ commit }, conversationId) => {
    const { data } = await PipelineItemsAPI.getByConversation(conversationId);
    data.forEach(item => commit('SET_ITEM_DATA', item));
    return data;
  },

  // Apply known fields immediately, then reconcile the affected columns from the
  // server. Reloading handles new/unloaded cards, filters and every sort without
  // guessing their rank or collapsing the pages the agent has already opened.
  applyRealtimePipelineItem: (context, item) => {
    const { commit, state, rootGetters } = context;
    if (state.activePipelineId !== item.pipeline_id) return;
    if (isStalePush(state, item)) return;

    queueStageRefresh(context, [
      item.pipeline_stage_id,
      item.previous_pipeline_stage_id,
      state.items[item.id]?.pipeline_stage_id,
    ]);

    const currentUserId = rootGetters.getCurrentUserID;
    const stillMatches = itemMatchesActiveFilters(state, item, currentUserId);
    const existingItem = state.items[item.id];

    if (!existingItem) {
      // With a filter active, whether the card was in the previous stage's count depends on how
      // it matched *before* this change, which the payload doesn't carry - so the previous stage
      // is only trusted when the column is unfiltered (every card counts).
      const isFiltered = Object.keys(buildKanbanQueryParams(state)).length > 2;
      commit('SET_UNLOADED_ITEM_COUNTED', {
        stageId: item.pipeline_stage_id,
        itemId: item.id,
        counted: stillMatches,
        previousStageId: isFiltered ? null : item.previous_pipeline_stage_id,
      });
      return;
    }

    const oldStageId = existingItem.pipeline_stage_id;
    if (!stillMatches) {
      commit('REMOVE_STAGE_ITEM', { stageId: oldStageId, itemId: item.id });
      commit('EDIT_ITEM', item);
      return;
    }

    if (oldStageId !== item.pipeline_stage_id) {
      const fromStage = state.stageItems[oldStageId];
      const loadedInFrom = fromStage?.ids.includes(item.id);
      const trackedInFrom = fromStage?.unloadedCountedIds.includes(item.id);
      const insertIndex =
        loadedInFrom || trackedInFrom ? realtimeInsertIndex(state, item) : null;
      const countAsUnloaded = () =>
        commit('SET_UNLOADED_ITEM_COUNTED', {
          stageId: item.pipeline_stage_id,
          itemId: item.id,
          counted: true,
        });

      if (loadedInFrom && insertIndex !== null) {
        commit('MOVE_ITEM', {
          itemId: item.id,
          fromStageId: oldStageId,
          toStageId: item.pipeline_stage_id,
          position: insertIndex,
        });
      } else if (loadedInFrom) {
        // Can't be placed in the new stage's loaded list (see realtimeInsertIndex): leave the old
        // list and count it as unloaded over there.
        commit('REMOVE_STAGE_ITEM', { stageId: oldStageId, itemId: item.id });
        countAsUnloaded();
      } else if (trackedInFrom && insertIndex !== null) {
        // Only a count in its old stage (an earlier push put it there), but the new stage's
        // loaded list does have room for it.
        commit('SET_UNLOADED_ITEM_COUNTED', {
          stageId: oldStageId,
          itemId: item.id,
          counted: false,
        });
        commit('INSERT_STAGE_ITEM', {
          stageId: item.pipeline_stage_id,
          itemId: item.id,
          position: insertIndex,
        });
      } else if (trackedInFrom) {
        // Still can't be placed - SET_UNLOADED_ITEM_COUNTED hands the count from the old stage
        // over to the new one.
        countAsUnloaded();
      } else {
        // Neither list nor count tracks it in the old stage (e.g. only loaded by an
        // Opportunities panel), so there's nothing to move - MOVE_ITEM just updates its stage id.
        commit('MOVE_ITEM', {
          itemId: item.id,
          fromStageId: oldStageId,
          toStageId: item.pipeline_stage_id,
          position: 0,
        });
      }
    }
    commit('EDIT_ITEM', item);
  },
};
