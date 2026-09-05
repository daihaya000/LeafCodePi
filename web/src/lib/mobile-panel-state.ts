export type TaskPanel = "graph" | "diff";

export type TaskPanelState = {
  graphOpen: boolean;
  diffOpen: boolean;
};

export function toggleTaskPanel(
  state: TaskPanelState,
  panel: TaskPanel,
  allowMultiplePanels: boolean,
): TaskPanelState {
  const nextOpen = panel === "graph" ? !state.graphOpen : !state.diffOpen;
  if (allowMultiplePanels) {
    return panel === "graph"
      ? { ...state, graphOpen: nextOpen }
      : { ...state, diffOpen: nextOpen };
  }
  return panel === "graph"
    ? { graphOpen: nextOpen, diffOpen: false }
    : { graphOpen: false, diffOpen: nextOpen };
}

export function normalizeTaskPanelState(
  state: TaskPanelState,
  allowMultiplePanels: boolean,
): TaskPanelState {
  if (allowMultiplePanels || !state.graphOpen || !state.diffOpen) return state;
  return { ...state, diffOpen: false };
}
