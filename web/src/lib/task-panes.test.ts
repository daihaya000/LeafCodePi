import { afterEach, describe, expect, it } from "vitest";
import {
  MAX_PANES,
  MAX_TABS_PER_PANE,
  TASK_PANES_STORAGE_KEY,
  createState,
  loadTaskPanes,
  normalize,
  saveTaskPanes,
  taskPanesReducer as reducer,
  type TaskPane,
  type TaskPanesState,
} from "./task-panes";

function pane(id: string, tabs: string[], activeTabId: string | null = tabs[0] ?? null): TaskPane {
  return { id, tabs, activeTabId };
}

function state(...panes: TaskPane[]): TaskPanesState {
  return { panes, activePaneId: panes[0].id };
}

const P1 = "pane-1";
const P2 = "pane-2";
const P3 = "pane-3";

class MemoryLocalStorage {
  private map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, String(value));
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
  clear(): void {
    this.map.clear();
  }
}

describe("createState", () => {
  it("URL taskId を最初のタブにした 1 ペインを構築する", () => {
    const created = createState("task-a");
    expect(created.panes).toHaveLength(1);
    expect(created.panes[0].tabs).toEqual(["task-a"]);
    expect(created.panes[0].activeTabId).toBe("task-a");
    expect(created.activePaneId).toBe(created.panes[0].id);
  });
});

describe("openTab", () => {
  it("指定ペインにタブを追加して活性化する", () => {
    const base = state(pane(P1, ["t1"]), pane(P2, [], null));
    const next = reducer(base, { type: "openTab", paneId: P2, taskId: "t2" });
    expect(next.panes[1].tabs).toEqual(["t2"]);
    expect(next.panes[1].activeTabId).toBe("t2");
    expect(next.activePaneId).toBe(P2);
  });

  it("重複時は既存タブの活性化に寄せる（二重登録しない）", () => {
    const base = state(pane(P1, ["t1"]), pane(P2, ["t2"]));
    const next = reducer(base, { type: "openTab", paneId: P2, taskId: "t1" });
    expect(next.panes.reduce((sum, p) => sum + p.tabs.filter((id) => id === "t1").length, 0)).toBe(1);
    expect(next.activePaneId).toBe(P1);
    expect(next.panes[0].activeTabId).toBe("t1");
  });

  it("タブ上限到達で同一参照のまま no-op", () => {
    const full = Array.from({ length: MAX_TABS_PER_PANE }, (_, i) => `t${i}`);
    const base = state(pane(P1, full));
    const next = reducer(base, { type: "openTab", paneId: P1, taskId: "extra" });
    expect(next).toBe(base);
  });

  it("不明ペイン ID は no-op", () => {
    const base = state(pane(P1, ["t1"]));
    expect(reducer(base, { type: "openTab", paneId: "nope", taskId: "t9" })).toBe(base);
  });
});

describe("closeTab", () => {
  it("中間タブを閉じると右隣が active になる", () => {
    const base = state(pane(P1, ["a", "b", "c"], "b"));
    const next = reducer(base, { type: "closeTab", paneId: P1, taskId: "b" });
    expect(next.panes[0].tabs).toEqual(["a", "c"]);
    expect(next.panes[0].activeTabId).toBe("c");
  });

  it("末尾タブを閉じると左隣が active になる", () => {
    const base = state(pane(P1, ["a", "b"]));
    const next = reducer(base, { type: "closeTab", paneId: P1, taskId: "b" });
    expect(next.panes[0].tabs).toEqual(["a"]);
    expect(next.panes[0].activeTabId).toBe("a");
  });

  it("最終タブを閉じると複数ペイン時はペインごと閉じ、activePaneId は右隣へ繰り上がる", () => {
    const s = state(pane(P1, ["a"]), pane(P2, ["b"]), pane(P3, ["c"]));
    const activeSecond: TaskPanesState = { panes: s.panes, activePaneId: P2 };
    const next = reducer(activeSecond, { type: "closeTab", paneId: P2, taskId: "b" });
    expect(next.panes.map((p) => p.id)).toEqual([P1, P3]);
    expect(next.activePaneId).toBe(P3);
  });

  it("1 ペイン時の最終タブは最小 1 ペイン制約で no-op", () => {
    const base = state(pane(P1, ["a"]));
    expect(reducer(base, { type: "closeTab", paneId: P1, taskId: "a" })).toBe(base);
  });

  it("非アクティブタブを閉じても activeTabId は変わらない", () => {
    const base = state(pane(P1, ["a", "b", "c"], "a"));
    const next = reducer(base, { type: "closeTab", paneId: P1, taskId: "b" });
    expect(next.panes[0].activeTabId).toBe("a");
  });
});

describe("activateTab / activatePane", () => {
  it("タブ切替でペインも活性化する", () => {
    const base = state(pane(P1, ["a"]), pane(P2, ["b", "c"]));
    const next = reducer(base, { type: "activateTab", paneId: P2, taskId: "c" });
    expect(next.activePaneId).toBe(P2);
    expect(next.panes[1].activeTabId).toBe("c");
  });

  it("存在しないタスク・ペインは no-op", () => {
    const base = state(pane(P1, ["a"]));
    expect(reducer(base, { type: "activateTab", paneId: P1, taskId: "nope" })).toBe(base);
    expect(reducer(base, { type: "activatePane", paneId: "nope" })).toBe(base);
  });

  it("activatePane は空ペインも活性化できる", () => {
    const base = state(pane(P1, ["a"]), pane(P2, [], null));
    const next = reducer(base, { type: "activatePane", paneId: P2 });
    expect(next.activePaneId).toBe(P2);
  });
});

describe("reorderTabs", () => {
  it("同一集合の並び替えを受け入れる", () => {
    const base = state(pane(P1, ["a", "b", "c"]));
    const next = reducer(base, { type: "reorderTabs", paneId: P1, tabs: ["c", "a", "b"] });
    expect(next.panes[0].tabs).toEqual(["c", "a", "b"]);
    expect(next.panes[0].activeTabId).toBe("a"); // 変わらない
  });

  it("要素集合が異なる並び替えは no-op", () => {
    const base = state(pane(P1, ["a", "b"]));
    expect(reducer(base, { type: "reorderTabs", paneId: P1, tabs: ["a"] })).toBe(base);
    expect(reducer(base, { type: "reorderTabs", paneId: P1, tabs: ["a", "x"] })).toBe(base);
  });
});

describe("moveTab", () => {
  it("他ペインへ index 指定で移動し移動先が活性化する", () => {
    const base = state(pane(P1, ["a", "b"]), pane(P2, ["z"]));
    const next = reducer(base, {
      type: "moveTab",
      fromPaneId: P1,
      toPaneId: P2,
      taskId: "a",
      index: 0,
    });
    expect(next.panes[0].tabs).toEqual(["b"]);
    expect(next.panes[1].tabs).toEqual(["a", "z"]);
    expect(next.panes[1].activeTabId).toBe("a");
    expect(next.activePaneId).toBe(P2);
  });

  it("from の activeTabId は繰り上げられる", () => {
    const base = state(pane(P1, ["a", "b"], "a"), pane(P2, []));
    const next = reducer(base, { type: "moveTab", fromPaneId: P1, toPaneId: P2, taskId: "a" });
    expect(next.panes[0].activeTabId).toBe("b");
  });

  it("同一ペイン内は並び替えとして扱う", () => {
    const base = state(pane(P1, ["a", "b", "c"]));
    const next = reducer(base, { type: "moveTab", fromPaneId: P1, toPaneId: P1, taskId: "c", index: 0 });
    expect(next.panes[0].tabs).toEqual(["c", "a", "b"]);
  });

  it("移動先満杯は no-op", () => {
    const full = Array.from({ length: MAX_TABS_PER_PANE }, (_, i) => `f${i}`);
    const base = state(pane(P1, ["a"]), pane(P2, full));
    const next = reducer(base, { type: "moveTab", fromPaneId: P1, toPaneId: P2, taskId: "a" });
    expect(next).toBe(base);
  });
});

describe("addPane / closePane", () => {
  it("空ペインを追加して活性化する", () => {
    const base = state(pane(P1, ["a"]));
    const next = reducer(base, { type: "addPane" });
    expect(next.panes).toHaveLength(2);
    expect(next.panes[1].tabs).toEqual([]);
    expect(next.activePaneId).toBe(next.panes[1].id);
  });

  it(`ペイン上限 ${MAX_PANES} 到達で no-op`, () => {
    const base = state(pane(P1, ["a"]), pane(P2, ["b"]), pane(P3, ["c"]), pane("pane-4", ["d"]));
    expect(reducer(base, { type: "addPane" })).toBe(base);
  });

  it("1 ペイン時の closePane は no-op", () => {
    const base = state(pane(P1, ["a"]));
    expect(reducer(base, { type: "closePane", paneId: P1 })).toBe(base);
  });

  it("closePane 後は隣のペインへ activePaneId を繰り上げる", () => {
    const s = state(pane(P1, ["a"]), pane(P2, ["b"]));
    const activeSecond: TaskPanesState = { panes: s.panes, activePaneId: P2 };
    const next = reducer(activeSecond, { type: "closePane", paneId: P2 });
    expect(next.panes.map((p) => p.id)).toEqual([P1]);
    expect(next.activePaneId).toBe(P1);
  });
});

describe("normalize", () => {
  it("不正な activeTabId を先頭タブへ補正する", () => {
    const fixed = normalize({ panes: [{ id: P1, tabs: ["a", "b"], activeTabId: "gone" }] });
    expect(fixed?.panes[0].activeTabId).toBe("a");
  });

  it("ペイン上限超過・タブ上限超過を切り詰める", () => {
    const manyPanes = Array.from({ length: MAX_PANES + 2 }, (_, i) => ({
      id: `p${i}`,
      tabs: [`t${i}`],
    }));
    const fixed = normalize({ panes: manyPanes });
    expect(fixed?.panes).toHaveLength(MAX_PANES);

    const manyTabs = Array.from({ length: MAX_TABS_PER_PANE + 3 }, (_, i) => `t${i}`);
    const fixedTabs = normalize({ panes: [{ id: P1, tabs: manyTabs }] });
    expect(fixedTabs?.panes[0].tabs).toHaveLength(MAX_TABS_PER_PANE);
  });

  it("壊れた構造は null", () => {
    expect(normalize(null)).toBeNull();
    expect(normalize({})).toBeNull();
    expect(normalize({ panes: [] })).toBeNull();
    expect(normalize({ panes: [{ id: "", tabs: [] }, { id: "ok", tabs: "not-array" }] })).toBeNull();
  });
});

describe("localStorage 永続化", () => {
  afterEach(() => {
    delete (globalThis as { localStorage?: unknown }).localStorage;
  });

  function installLocalStorage(): MemoryLocalStorage {
    const store = new MemoryLocalStorage();
    (globalThis as { localStorage?: unknown }).localStorage = store;
    return store;
  }

  it("save → load で roundtrip する", () => {
    installLocalStorage();
    const saved = state(pane(P1, ["a", "b"], "b"), pane(P2, [], null));
    saveTaskPanes(saved);
    expect(loadTaskPanes()).toEqual(saved);
  });

  it("未保存・SSR（localStorage 未定義）では null", () => {
    expect(loadTaskPanes()).toBeNull(); // 未定義環境
    installLocalStorage();
    expect(loadTaskPanes()).toBeNull(); // 空ストア
  });

  it("破損 JSON・version 不一致は null", () => {
    const store = installLocalStorage();
    store.setItem(TASK_PANES_STORAGE_KEY, "{not json");
    expect(loadTaskPanes()).toBeNull();
    store.setItem(TASK_PANES_STORAGE_KEY, JSON.stringify({ version: 99 }));
    expect(loadTaskPanes()).toBeNull();
  });

  it("上限違反データは正規化して復元する", () => {
    const store = installLocalStorage();
    store.setItem(
      TASK_PANES_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        panes: [
          { id: P1, tabs: Array.from({ length: MAX_TABS_PER_PANE + 2 }, (_, i) => `t${i}`) },
        ],
        activePaneId: "gone",
      }),
    );
    const loaded = loadTaskPanes();
    expect(loaded?.panes[0].tabs).toHaveLength(MAX_TABS_PER_PANE);
    expect(loaded?.activePaneId).toBe(P1); // 不正 activePaneId は panes[0] へ補正
  });
});
