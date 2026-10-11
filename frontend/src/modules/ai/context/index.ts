/**
 * AI-04 上下文与前端工具模块入口（组：completion-context 独占）。
 */
export type {
  ChartAggregation,
  ChartSelection,
  ChartType,
  CodeSelection,
  ContextKind,
  ContextSelection,
  DatasourceQueryContent,
  DatasourceSelection,
  FrontendToolManifest,
  RecordSelection,
  UiFilterCondition,
  UiFilterGroup,
  WorkContextItem,
} from './types';
export { CHART_AGGREGATIONS, CHART_TYPES, FILTER_OPERATORS } from './types';
export {
  describeFilter,
  emptyUiFilter,
  isUiFilter,
  toEditableFilter,
  toServerFilter,
  validateUiFilter,
} from './filter';
export {
  attachFrontendTools,
  buildChartItem,
  buildCodeDataItem,
  buildCodeItem,
  buildDatasourceItem,
  buildFirstMessagePayload,
  buildItemsForSelection,
  buildRecordItem,
  buildWorkContext,
  CHART_WORKSPACE_UID,
  CODE_WORKSPACE_UID,
  describeSelection,
  recordUid,
} from './payload';
export {
  contextToolDefinitions,
  contextToolManifests,
  listContextToolManifests,
  registerContextTools,
  rejectProposal,
  runContextTool,
  type ContextToolDefinition,
  type FrontendToolRegistryLike,
} from './tools';
export {
  clearAll,
  clearSelections,
  ensureGeneration,
  getHistory,
  getProposals,
  getSelections,
  getSnapshot,
  removeSelection,
  settleProposal,
  subscribe,
  upsertSelection,
  type ContextStoreSnapshot,
  type ToolProposal,
  type ToolRunRecord,
} from './store';
export {
  contextKindOfItem,
  getAiManager,
  handoffPreparedItemsToChatBox,
  openDatasourcePicker,
  prepareChatBoxContextItems,
  registerCrewloomNativeContexts,
} from './native';
