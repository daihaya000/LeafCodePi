import { afterEach, describe, expect, it } from "vitest";
import {
  HOME_TAB_ID,
  MAX_PANES,
  MAX_TABS_PER_PANE,
  TASK_PANES_STORAGE_KEY,
  createState,
  isSplitHostPath,
  loadTaskPanes,
  normalize,
  paneLayoutForState,
  restoreTaskPanesForUrl,
  resizeAdjacentPaneWidths,
  retargetActiveTab,
  saveTaskPanes,
  removeTaskEverywhere,
  taskIdFromPathname,
  taskPanesReducer as reducer,
  type PaneLayout,
  type TaskPane,
  type TaskPanesState,
} from "./task-panes";

function pane(id: string, tabs: string[], activeTabId: string | null = tabs[0] ?? null): TaskPane {
  return { id, tabs, activeTabId };
}

function state(...panes: TaskPane[]): TaskPanesState {
  return { panes, activePaneId: panes[0].id };
}

function layoutPaneIds(layout: PaneLayout): string[] {
  return layout.type === "pane"
    ? [layout.paneId]
    : [...layoutPaneIds(layout.children[0]), ...layoutPaneIds(layout.children[1])];
}

const P1 = "pane-1";
const P2 = "pane-2";
const P3 = "pane-3";

describe("resizeAdjacentPaneWidths", () => {
  it("隣接ペインの境界を移動し、最小幅を守る", () => {
    const wider = resizeAdjacentPaneWidths([0.5, 0.5], 0, 0.2, 0.2);
    const clamped = resizeAdjacentPaneWidths([0.5, 0.5], 0, -0.5, 0.2);
    expect(wider[0]).toBeCloseTo(0.7);
    expect(wider[1]).toBeCloseTo(0.3);
    expect(clamped[0]).toBeCloseTo(0.2);
    expect(clamped[1]).toBeCloseTo(0.8);
  });

  it("3 ペインでも指定した境界の 2 ペインだけを調整する", () => {
    const next = resizeAdjacentPaneWidths([0.3, 0.4, 0.3], 1, 0.1, 0.2);
    expect(next[0]).toBeCloseTo(0.3);
    expect(next[1]).toBeCloseTo(0.5);
    expect(next[2]).toBeCloseTo(0.2);
  });
});

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

  it("URL taskId が無ければ新規作成（Home）タブをアクティブにする", () => {
    const created = createState(null);
    expect(created.panes[0].tabs).toEqual([HOME_TAB_ID]);
    expect(created.panes[0].activeTabId).toBe(HOME_TAB_ID);
    expect(retargetActiveTab(created, "task-a").panes[0].tabs).toEqual(["task-a"]);
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

  it("未登録タスクを既存タブのある指定ペインへ追加して活性化する", () => {
    const base = state(pane(P1, ["t1"]), pane(P2, ["t2"]));
    const next = reducer(base, { type: "openTab", paneId: P2, taskId: "fresh" });
    expect(next.panes[1].tabs).toEqual(["t2", "fresh"]);
    expect(next.panes[1].activeTabId).toBe("fresh");
    expect(next.activePaneId).toBe(P2);
  });

  it("タブ追加時も既存のレイアウトと orientation を保持する", () => {
    const base: TaskPanesState = {
      ...state(pane(P1, ["t1"]), pane(P2, ["t2"])),
      orientation: "column",
      layout: {
        type: "split",
        id: "root",
        orientation: "row",
        children: [
          { type: "pane", paneId: P1 },
          { type: "pane", paneId: P2 },
        ],
      },
    };
    const next = reducer(base, { type: "openTab", paneId: P2, taskId: "fresh" });
    expect(next.orientation).toBe("column");
    expect(next.layout).toEqual(base.layout);
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

describe("openInNewPane", () => {
  it("未登録タスクを新ペインで開いて活性化する", () => {
    const base = state(pane(P1, ["t1"]));
    const next = reducer(base, { type: "openInNewPane", taskId: "t2" });
    expect(next.panes).toHaveLength(2);
    expect(next.panes[1].tabs).toEqual(["t2"]);
    expect(next.activePaneId).toBe(next.panes[1].id);
    expect(next.panes[0].tabs).toEqual(["t1"]);
  });

  it("既存タスクは元ペインから外して新ペインへ移す", () => {
    const base = state(pane(P1, ["a", "b"], "b"));
    const next = reducer(base, { type: "openInNewPane", taskId: "b" });
    expect(next.panes).toHaveLength(2);
    expect(next.panes[0].tabs).toEqual(["a"]);
    expect(next.panes[0].activeTabId).toBe("a");
    expect(next.panes[1].tabs).toEqual(["b"]);
    expect(next.activePaneId).toBe(next.panes[1].id);
  });

  it("単独タブの既存タスクは移動せず活性化のみ", () => {
    const base = state(pane(P1, ["only"]));
    const next = reducer(base, { type: "openInNewPane", taskId: "only" });
    expect(next.panes).toHaveLength(1);
    expect(next.activePaneId).toBe(P1);
    expect(next.panes[0].activeTabId).toBe("only");
  });

  it("ペイン上限では最後のペインのタブへフォールバックする", () => {
    const full = Array.from({ length: MAX_PANES }, (_, i) => pane(`p${i}`, [`t${i}`]));
    const base = { panes: full, activePaneId: "p0" };
    const next = reducer(base, { type: "openInNewPane", taskId: "extra" });
    expect(next.panes).toHaveLength(MAX_PANES);
    expect(next.panes[MAX_PANES - 1].tabs).toEqual(["t3", "extra"]);
    expect(next.activePaneId).toBe("p3");
  });

  it("ペイン上限かつフォールバック先満杯でも既存タスクを失わない", () => {
    const full = Array.from({ length: MAX_TABS_PER_PANE }, (_, i) => `full-${i}`);
    const base = state(
      pane(P1, ["keep", "moving"], "moving"),
      pane(P2, ["target"]),
      pane(P3, ["other"]),
      pane("p4", full),
    );
    const next = reducer(base, {
      type: "openInNewPane",
      taskId: "moving",
      anchorPaneId: P2,
      direction: "right",
    });
    expect(next).toBe(base);
    expect(next.panes[0].tabs).toContain("moving");
  });
});

describe("openInNewPane with direction", () => {
  it("direction=right は anchor 直後に挿入し orientation=row を設定する", () => {
    const base = state(pane(P1, ["a"]), pane(P2, ["b"]));
    const next = reducer(base, {
      type: "openInNewPane",
      taskId: "c",
      anchorPaneId: P1,
      direction: "right",
    });
    expect(next.panes.map((p) => p.id)).toEqual([P1, next.panes[1].id, P2]);
    expect(next.panes[1].tabs).toEqual(["c"]);
    expect(next.activePaneId).toBe(next.panes[1].id);
    expect(next.orientation).toBe("row");
  });

  it("direction=left は anchor 直前に挿入する", () => {
    const base = state(pane(P1, ["a"]), pane(P2, ["b"]));
    const next = reducer(base, {
      type: "openInNewPane",
      taskId: "c",
      anchorPaneId: P2,
      direction: "left",
    });
    expect(next.panes.map((p) => p.id)).toEqual([P1, next.panes[1].id, P2]);
    expect(next.orientation).toBe("row");
  });

  it("方向分割は anchor の葉だけを置き換え、他ペインの方向を変えない", () => {
    const base = state(pane(P1, ["a"]), pane(P2, ["b"]), pane(P3, ["c"]));
    const next = reducer(base, {
      type: "openInNewPane",
      taskId: "d",
      anchorPaneId: P2,
      direction: "bottom",
    });
    const layout = next.layout!;
    expect(layoutPaneIds(layout)).toEqual(next.panes.map((pane) => pane.id));
    expect(layout).toMatchObject({
      type: "split",
      orientation: "row",
      children: [
        {
          type: "split",
          orientation: "row",
          children: [
            { type: "pane", paneId: P1 },
            {
              type: "split",
              orientation: "column",
              children: [{ type: "pane", paneId: P2 }, { type: "pane", paneId: next.panes[2].id }],
            },
          ],
        },
        { type: "pane", paneId: P3 },
      ],
    });
  });

  it("direction=top / bottom は orientation を column に切り替える", () => {
    const base = state(pane(P1, ["a"]));
    const top = reducer(base, {
      type: "openInNewPane",
      taskId: "c",
      anchorPaneId: P1,
      direction: "top",
    });
    expect(top.orientation).toBe("column");
    expect(top.panes.map((p) => p.tabs)).toEqual([["c"], ["a"]]);

    const bottom = reducer(
      { ...base, orientation: "row" },
      { type: "openInNewPane", taskId: "c", anchorPaneId: P1, direction: "bottom" },
    );
    expect(bottom.orientation).toBe("column");
    expect(bottom.panes.map((p) => p.tabs)).toEqual([["a"], ["c"]]);
  });

  it("direction 指定時は単独タブの既存タスクも元ペインから外して分割移動する", () => {
    const base = state(pane(P1, ["only"], "only"));
    const next = reducer(base, {
      type: "openInNewPane",
      taskId: "only",
      anchorPaneId: P1,
      direction: "right",
    });
    expect(next.panes).toHaveLength(2);
    expect(next.panes[0].tabs).toEqual([]);
    expect(next.panes[1].tabs).toEqual(["only"]);
    expect(next.activePaneId).toBe(next.panes[1].id);
  });

  it("direction 未指定なら末尾追加で既存 orientation を引き継ぐ", () => {
    const base: TaskPanesState = { ...state(pane(P1, ["a"])), orientation: "column" };
    const next = reducer(base, { type: "openInNewPane", taskId: "b" });
    expect(next.panes.map((p) => p.tabs)).toEqual([["a"], ["b"]]);
    expect(next.orientation).toBe("column");
  });

  it("不明 anchorPaneId は末尾フォールバック", () => {
    const base = state(pane(P1, ["a"]));
    const next = reducer(base, {
      type: "openInNewPane",
      taskId: "b",
      anchorPaneId: "nope",
      direction: "left",
    });
    expect(next.panes).toHaveLength(2);
    expect(next.panes[0].tabs).toEqual(["a"]);
    expect(next.panes[1].tabs).toEqual(["b"]);
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

  it("closePane はレイアウトツリーの該当葉だけを縮退させる", () => {
    const base = state(pane(P1, ["a"]), pane(P2, ["b"]));
    const split = reducer(base, {
      type: "openInNewPane",
      taskId: "c",
      anchorPaneId: P1,
      direction: "right",
    });
    const closed = reducer(split, { type: "closePane", paneId: split.panes[1].id });
    expect(closed.panes.map((pane) => pane.id)).toEqual([P1, P2]);
    expect(layoutPaneIds(closed.layout!)).toEqual([P1, P2]);
    expect(closed.layout).toMatchObject({
      type: "split",
      orientation: "row",
      children: [{ type: "pane", paneId: P1 }, { type: "pane", paneId: P2 }],
    });
  });
});

describe("paneLayoutForState", () => {
  it("layout のない旧保存値は orientation を使って平坦なツリーへ変換する", () => {
    const layout = paneLayoutForState({
      panes: [pane(P1, ["a"]), pane(P2, ["b"])],
      activePaneId: P1,
      orientation: "column",
    });
    expect(layout).toEqual({
      type: "split",
      id: "split-pane-2",
      orientation: "column",
      children: [{ type: "pane", paneId: P1 }, { type: "pane", paneId: P2 }],
    });
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

  it("orientation=column を保持し、不正値は無視する", () => {
    const kept = normalize({ panes: [{ id: P1, tabs: ["a"] }], activePaneId: P1, orientation: "column" });
    expect(kept?.orientation).toBe("column");
    const dropped = normalize({ panes: [{ id: P1, tabs: ["a"] }], activePaneId: P1, orientation: "diagonal" });
    expect(dropped?.orientation).toBeUndefined();
    const absent = normalize({ panes: [{ id: P1, tabs: ["a"] }], activePaneId: P1 });
    expect(absent?.orientation).toBeUndefined();
  });

  it("保存されたペイン単位の layout tree を検証して復元する", () => {
    const layout: PaneLayout = {
      type: "split",
      id: "root",
      orientation: "row",
      children: [
        { type: "pane", paneId: P1 },
        { type: "pane", paneId: P2 },
      ],
    };
    expect(
      normalize({
        panes: [pane(P1, ["a"]), pane(P2, ["b"])],
        activePaneId: P2,
        layout,
      }),
    ).toEqual({ panes: [pane(P1, ["a"]), pane(P2, ["b"])], activePaneId: P2, layout });
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

  it("方向付き layout tree も save → load で保持する", () => {
    installLocalStorage();
    const saved: TaskPanesState = {
      ...state(pane(P1, ["a"]), pane(P2, ["b"])),
      layout: {
        type: "split",
        id: "root",
        orientation: "row",
        children: [
          { type: "pane", paneId: P1 },
          { type: "pane", paneId: P2 },
        ],
      },
    };
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

describe("taskIdFromPathname / isSplitHostPath", () => {
  it("/task/<id> から taskId を取り出す", () => {
    expect(taskIdFromPathname("/task/abc")).toBe("abc");
    expect(taskIdFromPathname("/task/a%2Fb")).toBe("a/b");
    expect(taskIdFromPathname("/task/abc/sub")).toBe("abc");
    expect(taskIdFromPathname("/")).toBeNull();
    expect(taskIdFromPathname("/settings")).toBeNull();
    expect(taskIdFromPathname(null)).toBeNull();
  });

  it("Home・task のみが分割ホスト", () => {
    expect(isSplitHostPath("/")).toBe(true);
    expect(isSplitHostPath("/task/x")).toBe(true);
    expect(isSplitHostPath("/settings")).toBe(false);
  });
});

describe("retargetActiveTab", () => {
  it("既存タブならそのペインを活性化する", () => {
    const base = state(pane(P1, ["a"]), pane(P2, ["url-task"]));
    const next = retargetActiveTab(base, "url-task");
    expect(next.activePaneId).toBe(P2);
    expect(next.panes[1].activeTabId).toBe("url-task");
  });

  it("未登録なら panes[0] のタブへ追加して活性化する", () => {
    const base = state(pane(P1, ["a"]), pane(P2, []));
    const next = retargetActiveTab(base, "fresh");
    expect(next.panes[0].tabs).toEqual(["a", "fresh"]);
    expect(next.panes[0].activeTabId).toBe("fresh");
    expect(next.activePaneId).toBe(P1);
  });

  it("panes[0] 満杯時は activeTabId 差し替えのみ（タブ数は増やさない）", () => {
    const full = Array.from({ length: MAX_TABS_PER_PANE }, (_, i) => `t${i}`);
    const base = state(pane(P1, full));
    const next = retargetActiveTab(base, "fresh");
    expect(next.panes[0].tabs).toEqual([...full.slice(1), "fresh"]);
    expect(next.panes[0].activeTabId).toBe("fresh");
  });

  it("変更不要なら同一参照を返す", () => {
    const base = state(pane(P1, ["a"]));
    expect(retargetActiveTab(base, "a")).toBe(base);
  });

  it("Home タブから実タスクを開くと Home タブは自動クローズされる", () => {
    const base = state(pane(P1, [HOME_TAB_ID]));
    const next = retargetActiveTab(base, "fresh");
    expect(next.panes[0].tabs).toEqual(["fresh"]);
    expect(next.panes[0].activeTabId).toBe("fresh");
  });

  it("HomeView と同じペインで実タスクを開く", () => {
    const base = state(pane(P1, ["existing"]), pane(P2, [HOME_TAB_ID]), pane(P3, ["other"]));
    const next = retargetActiveTab(base, "fresh");
    expect(next.activePaneId).toBe(P2);
    expect(next.panes).toEqual([
      pane(P1, ["existing"]),
      pane(P2, ["fresh"]),
      pane(P3, ["other"]),
    ]);
  });

  it("実タスクから Home へ戻ると Home タブを開く", () => {
    const base = state(pane(P1, ["task-a"]));
    const next = retargetActiveTab(base, HOME_TAB_ID);
    expect(next.panes[0].tabs).toEqual(["task-a", HOME_TAB_ID]);
    expect(next.panes[0].activeTabId).toBe(HOME_TAB_ID);
  });
});

describe("restoreTaskPanesForUrl", () => {
  afterEach(() => {
    delete (globalThis as { localStorage?: unknown }).localStorage;
  });

  function installLocalStorage(): MemoryLocalStorage {
    const store = new MemoryLocalStorage();
    (globalThis as { localStorage?: unknown }).localStorage = store;
    return store;
  }

  it("md 未満では復元しない", () => {
    installLocalStorage();
    saveTaskPanes(state(pane(P1, ["a"])));
    expect(restoreTaskPanesForUrl("a", false)).toBeNull();
  });

  it("URL taskId を含む構成へ差し替える", () => {
    installLocalStorage();
    saveTaskPanes({ panes: [pane(P1, ["a"]), pane(P2, ["url-task"])], activePaneId: P1 });
    const restored = restoreTaskPanesForUrl("url-task", true);
    expect(restored?.activePaneId).toBe(P2);
    expect(restored?.panes[1].activeTabId).toBe("url-task");
  });

  it("含まれない場合は保存 panes[0] の activeTabId を URL taskId に修正", () => {
    installLocalStorage();
    saveTaskPanes(state(pane(P1, ["a"]), pane(P2, ["b"])));
    const restored = restoreTaskPanesForUrl("direct-link", true);
    expect(restored?.panes[0].tabs).toEqual(["a", "direct-link"]);
    expect(restored?.panes[0].activeTabId).toBe("direct-link");
  });

  it("保存値なしは null", () => {
    installLocalStorage();
    expect(restoreTaskPanesForUrl("x", true)).toBeNull();
  });
});

describe("removeTaskEverywhere", () => {
  it("対象がなければ同一参照を返す", () => {
    const base = state(pane(P1, ["a"]));
    expect(removeTaskEverywhere(base, "absent")).toBe(base);
  });

  it("複数ペインの該当タブをすべて閉じる", () => {
    const base = state(pane(P1, ["t", "keep"]), pane(P2, ["t"]));
    const next = removeTaskEverywhere(base, "t");
    // P2 は空になったためペインごと除去、P1 で activeTabId が繰り上がる
    expect(next.panes).toHaveLength(1);
    expect(next.panes[0].tabs).toEqual(["keep"]);
    expect(next.panes[0].activeTabId).toBe("keep");
  });

  it("タブが全て消えたペインは縮退し、activePaneId を右隣へ繰り上げる", () => {
    const base = state(pane(P1, ["t"]), pane(P2, ["x"]));
    const next = removeTaskEverywhere(base, "t");
    expect(next.panes).toEqual([pane(P2, ["x"])]);
    expect(next.activePaneId).toBe(P2);
  });

  it("最終ペインの最終タブも除去し、空タブのペインへ縮退する", () => {
    const base = state(pane(P1, ["gone"]));
    const next = removeTaskEverywhere(base, "gone");
    expect(next.panes).toHaveLength(1);
    expect(next.panes[0].tabs).toEqual([]);
    expect(next.panes[0].activeTabId).toBeNull();
  });

  it("削除対象でないペイン・タブはそのまま保つ", () => {
    const base = state(pane(P1, ["a", "b"]), pane(P2, ["c"]));
    const next = removeTaskEverywhere(base, "nope-not-used") === base; // 参照同一
    expect(next).toBe(true);
    const after = removeTaskEverywhere(base, "a");
    expect(after.panes[1]).toBe(base.panes[1]); // 無関係ペインは参照保持
  });

  it("orientation を保持する", () => {
    const base: TaskPanesState = { ...state(pane(P1, ["t"]), pane(P2, ["x"])), orientation: "column" };
    const next = removeTaskEverywhere(base, "t");
    expect(next.orientation).toBe("column");
  });
});
