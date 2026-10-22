import { actions } from '../actions';
import { DEFAULT_KANBAN_FILTERS, DEFAULT_KANBAN_SORT } from '../constants';
import PipelinesAPI from 'dashboard/api/pipelines';
import mutations from '../mutations';

const rootGetters = { getCurrentUserID: 99 };

const makeState = (overrides = {}) => ({
  activePipelineId: 1,
  activeFilters: { ...DEFAULT_KANBAN_FILTERS },
  activeSort: { ...DEFAULT_KANBAN_SORT },
  showOnlyMine: false,
  items: {},
  stageItems: {},
  stageOrder: { 1: [3, 7] },
  itemIdsByContact: {},
  itemIdsByConversation: {},
  ...overrides,
});

const stageState = (ids = [], page = 1, count = ids.length) => ({
  ids,
  page,
  count,
  hasMore: count > ids.length,
  isFetching: false,
  hasError: false,
  unloadedCountedIds: [],
});

const createContext = state => {
  const context = { state, rootGetters };
  context.commit = vi.fn((name, payload) => mutations[name](state, payload));
  context.dispatch = vi.fn((name, payload) => actions[name](context, payload));
  return context;
};

describe('kanban realtime reconciliation', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(PipelinesAPI, 'getBoardItems');
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('loads a new remote card into the visible column using the active server filters', async () => {
    const item = {
      id: 8,
      pipeline_id: 1,
      pipeline_stage_id: 3,
      value: 99,
      assignee: { id: 99 },
      updated_at_usec: 1001,
    };
    const state = makeState({
      stageItems: { 3: stageState() },
      activeFilters: { ...DEFAULT_KANBAN_FILTERS, assigneeId: 99 },
      activeSort: { field: 'value', order: 'desc' },
    });
    const context = createContext(state);
    PipelinesAPI.getBoardItems.mockResolvedValue({
      data: { payload: [item], meta: { count: 1 } },
    });

    actions.applyRealtimePipelineItem(context, item);
    await vi.advanceTimersByTimeAsync(150);

    expect(state.stageItems[3].ids).toEqual([8]);
    expect(state.stageItems[3].count).toBe(1);
    expect(PipelinesAPI.getBoardItems).toHaveBeenCalledWith(1, {
      stage_id: 3,
      page: 1,
      sort_by: 'value',
      order: 'desc',
      assignee_id: 99,
    });
  });

  it('coalesces a burst and keeps all already loaded pages in canonical order', async () => {
    const item = { id: 3, pipeline_id: 1, pipeline_stage_id: 3, value: 99 };
    const state = makeState({
      stageItems: { 3: stageState([1, 2], 2, 3) },
      activeSort: { field: 'value', order: 'desc' },
    });
    const context = createContext(state);
    PipelinesAPI.getBoardItems
      .mockResolvedValueOnce({ data: { payload: [item], meta: { count: 3 } } })
      .mockResolvedValueOnce({
        data: {
          payload: [{ id: 2, pipeline_stage_id: 3 }],
          meta: { count: 3 },
        },
      });
    [1001, 1002, 1003].forEach(updated_at_usec =>
      actions.applyRealtimePipelineItem(context, { ...item, updated_at_usec })
    );

    await vi.advanceTimersByTimeAsync(150);

    expect(PipelinesAPI.getBoardItems).toHaveBeenCalledTimes(2);
    expect(state.stageItems[3]).toMatchObject({
      ids: [3, 2],
      page: 2,
      count: 3,
      hasMore: true,
    });
  });

  it('refreshes both source and destination after a move with a non-manual sort', async () => {
    const before = {
      id: 4,
      pipeline_id: 1,
      pipeline_stage_id: 3,
      updated_at_usec: 10,
    };
    const after = { ...before, pipeline_stage_id: 7, updated_at_usec: 11 };
    const state = makeState({
      items: { 4: before },
      stageItems: { 3: stageState([4]), 7: stageState() },
      activeSort: { field: 'updated_at', order: 'desc' },
    });
    const context = createContext(state);
    PipelinesAPI.getBoardItems.mockImplementation((_pipelineId, params) =>
      Promise.resolve({
        data: {
          payload: params.stage_id === 7 ? [after] : [],
          meta: { count: params.stage_id === 7 ? 1 : 0 },
        },
      })
    );

    actions.applyRealtimePipelineItem(context, after);
    await vi.advanceTimersByTimeAsync(150);

    expect(state.stageItems[3]).toMatchObject({ ids: [], count: 0 });
    expect(state.stageItems[7]).toMatchObject({ ids: [4], count: 1 });
  });

  it('rejects delayed and duplicate events, including updates within the same second', () => {
    const current = {
      id: 4,
      pipeline_id: 1,
      pipeline_stage_id: 7,
      updated_at: 10,
      updated_at_usec: 10000200,
    };
    const state = makeState({
      items: { 4: current },
      stageItems: { 7: stageState([4]) },
    });
    const context = createContext(state);

    actions.applyRealtimePipelineItem(context, {
      ...current,
      pipeline_stage_id: 3,
      updated_at_usec: 10000100,
    });
    actions.applyRealtimePipelineItem(context, current);

    expect(context.commit).not.toHaveBeenCalled();
    expect(context.dispatch).not.toHaveBeenCalled();
    expect(state.items[4].pipeline_stage_id).toBe(7);
  });

  it('rejects delayed events for an unloaded item as well', () => {
    const context = createContext(makeState());
    const item = {
      id: 4,
      pipeline_id: 1,
      pipeline_stage_id: 7,
      updated_at_usec: 10000200,
    };
    actions.applyRealtimePipelineItem(context, item);
    context.commit.mockClear();
    actions.applyRealtimePipelineItem(context, {
      ...item,
      pipeline_stage_id: 3,
      updated_at_usec: 10000100,
    });
    expect(context.commit).not.toHaveBeenCalled();
  });

  it('does not overwrite a new filter with the late response from the previous filter', async () => {
    let resolveOld;
    PipelinesAPI.getBoardItems.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          resolveOld = resolve;
        })
    );
    const state = makeState({ stageItems: { 3: stageState([1]) } });
    const context = createContext(state);
    const oldFetch = actions.fetchStageItems(context, {
      pipelineId: 1,
      stageId: 3,
    });
    state.activeFilters.assigneeId = 99;
    PipelinesAPI.getBoardItems.mockResolvedValueOnce({
      data: { payload: [{ id: 2 }], meta: { count: 1 } },
    });
    await actions.fetchStageItems(context, { pipelineId: 1, stageId: 3 });
    resolveOld({ data: { payload: [{ id: 1 }], meta: { count: 100 } } });
    await oldFetch;
    expect(state.stageItems[3]).toMatchObject({
      ids: [2],
      count: 1,
      isFetching: false,
    });
  });

  it('discards an in-flight page invalidated by a push and fetches it again after completion', async () => {
    let resolveOld;
    PipelinesAPI.getBoardItems.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          resolveOld = resolve;
        })
    );
    const state = makeState({ stageItems: { 3: stageState([1]) } });
    const context = createContext(state);
    const fetch = actions.refreshStageItems(context, {
      pipelineId: 1,
      stageId: 3,
    });
    const newest = {
      id: 2,
      pipeline_id: 1,
      pipeline_stage_id: 3,
      updated_at_usec: 20,
    };
    actions.applyRealtimePipelineItem(context, newest);
    await vi.advanceTimersByTimeAsync(150);
    expect(PipelinesAPI.getBoardItems).toHaveBeenCalledTimes(1);
    PipelinesAPI.getBoardItems.mockResolvedValueOnce({
      data: { payload: [newest], meta: { count: 1 } },
    });
    resolveOld({ data: { payload: [{ id: 99 }], meta: { count: 1 } } });
    await fetch;
    expect(state.items[99]).toBeUndefined();
    await vi.advanceTimersByTimeAsync(150);
    expect(PipelinesAPI.getBoardItems).toHaveBeenCalledTimes(2);
    expect(state.stageItems[3].ids).toEqual([2]);
  });

  it('does not repopulate the previous pipeline after switching boards', async () => {
    let resolveOld;
    PipelinesAPI.getBoardItems.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          resolveOld = resolve;
        })
    );
    const state = makeState({ stageItems: { 3: stageState() } });
    const context = createContext(state);
    const fetch = actions.fetchStageItems(context, {
      pipelineId: 1,
      stageId: 3,
    });
    context.commit('SET_ACTIVE_PIPELINE', 2);
    resolveOld({ data: { payload: [{ id: 1 }], meta: { count: 1 } } });
    await fetch;
    expect(state.stageItems).toEqual({});
  });

  it('refreshes only loaded columns on reconnect and keeps existing filters', async () => {
    const state = makeState({
      stageItems: { 3: stageState() },
      showOnlyMine: true,
    });
    const context = createContext(state);
    PipelinesAPI.getBoardItems.mockResolvedValue({
      data: { payload: [], meta: { count: 0 } },
    });
    await actions.refreshLoadedBoard(context);
    expect(PipelinesAPI.getBoardItems).toHaveBeenCalledTimes(1);
    expect(PipelinesAPI.getBoardItems).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ stage_id: 3, only_mine: true })
    );
  });

  it('keeps visible cards and exposes the error without an unbounded retry on failure', async () => {
    const state = makeState({ stageItems: { 3: stageState([1]) } });
    const context = createContext(state);
    PipelinesAPI.getBoardItems.mockRejectedValueOnce(new Error('unavailable'));
    await actions.refreshStageItems(context, { pipelineId: 1, stageId: 3 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(state.stageItems[3]).toMatchObject({
      ids: [1],
      hasError: true,
      isFetching: false,
    });
    expect(PipelinesAPI.getBoardItems).toHaveBeenCalledTimes(1);
  });
});

describe('kanban/actions', () => {
  describe('applyRealtimePipelineItem', () => {
    it('ignores items outside the currently active pipeline', () => {
      const commit = vi.fn();
      const state = makeState();

      actions.applyRealtimePipelineItem(
        { commit, state, rootGetters },
        { id: 5, pipeline_id: 2, pipeline_stage_id: 3 }
      );

      expect(commit).not.toHaveBeenCalled();
    });

    it('marks the destination stage count for a new item that matches the active filters, without inserting it into any list', () => {
      const commit = vi.fn();
      const state = makeState();
      const item = { id: 5, pipeline_id: 1, pipeline_stage_id: 3 };

      actions.applyRealtimePipelineItem({ commit, state, rootGetters }, item);

      expect(commit).toHaveBeenCalledTimes(1);
      expect(commit).toHaveBeenCalledWith('SET_UNLOADED_ITEM_COUNTED', {
        stageId: 3,
        itemId: 5,
        counted: true,
      });
    });

    it('un-marks the destination stage count for a new item that does not match the active filters', () => {
      const commit = vi.fn();
      const state = makeState({
        activeFilters: { ...DEFAULT_KANBAN_FILTERS, assigneeId: 'unassigned' },
      });
      const item = {
        id: 5,
        pipeline_id: 1,
        pipeline_stage_id: 3,
        assignee: { id: 42, name: 'Alice' },
      };

      actions.applyRealtimePipelineItem({ commit, state, rootGetters }, item);

      expect(commit).toHaveBeenCalledTimes(1);
      expect(commit).toHaveBeenCalledWith('SET_UNLOADED_ITEM_COUNTED', {
        stageId: 3,
        itemId: 5,
        counted: false,
        previousStageId: null,
      });
    });

    it('moves an already-loaded item whose stage changed, then applies the field update', () => {
      const commit = vi.fn();
      const state = makeState({
        items: { 5: { id: 5, pipeline_id: 1, pipeline_stage_id: 3 } },
      });
      const item = { id: 5, pipeline_id: 1, pipeline_stage_id: 7 };

      actions.applyRealtimePipelineItem({ commit, state, rootGetters }, item);

      expect(commit).toHaveBeenNthCalledWith(1, 'MOVE_ITEM', {
        itemId: 5,
        fromStageId: 3,
        toStageId: 7,
        position: 0,
      });
      expect(commit).toHaveBeenNthCalledWith(2, 'EDIT_ITEM', item);
    });

    it('does not call MOVE_ITEM when the stage is unchanged, but still applies the field update', () => {
      const commit = vi.fn();
      const state = makeState({
        items: { 5: { id: 5, pipeline_id: 1, pipeline_stage_id: 3 } },
      });
      const item = {
        id: 5,
        pipeline_id: 1,
        pipeline_stage_id: 3,
        title: 'Updated',
      };

      actions.applyRealtimePipelineItem({ commit, state, rootGetters }, item);

      expect(commit).toHaveBeenCalledTimes(1);
      expect(commit).toHaveBeenCalledWith('EDIT_ITEM', item);
    });

    it('drops an already-loaded item from its stage when it no longer matches the active filters', () => {
      const commit = vi.fn();
      const state = makeState({
        activeFilters: { ...DEFAULT_KANBAN_FILTERS, assigneeId: 42 },
        items: {
          5: {
            id: 5,
            pipeline_id: 1,
            pipeline_stage_id: 3,
            assignee: { id: 42, name: 'Alice' },
          },
        },
      });
      // Reassigned away from the agent being filtered on - no longer matches.
      const item = {
        id: 5,
        pipeline_id: 1,
        pipeline_stage_id: 3,
        assignee: { id: 7, name: 'Bob' },
      };

      actions.applyRealtimePipelineItem({ commit, state, rootGetters }, item);

      expect(commit).toHaveBeenNthCalledWith(1, 'REMOVE_STAGE_ITEM', {
        stageId: 3,
        itemId: 5,
      });
      expect(commit).toHaveBeenNthCalledWith(2, 'EDIT_ITEM', item);
    });
  });
});
