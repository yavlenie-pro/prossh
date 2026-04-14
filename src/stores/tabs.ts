/**
 * Tab and split-pane state management.
 *
 * Each **tab** contains a recursive pane tree. A pane tree node is either:
 * - `PaneLeaf` — a single terminal (or SFTP explorer in step 14)
 * - `PaneSplit` — two children arranged horizontally or vertically
 *
 * The store tracks tabs + which tab/pane is focused, and exposes actions for
 * creating tabs, splitting, closing, and navigating.
 */
import { nanoid } from "nanoid";
import { create } from "zustand";

// ---------------------------------------------------------------------------
// Tree types
// ---------------------------------------------------------------------------

export interface PaneLeaf {
  type: "leaf";
  id: string;
  kind: "terminal" | "sftp";
  /** Session id from the sessions store. */
  sessionId: string;
}

export interface PaneSplit {
  type: "split";
  id: string;
  direction: "horizontal" | "vertical";
  /** Fraction of the parent space given to the first child (0..1). */
  ratio: number;
  children: [PaneNode, PaneNode];
}

export type PaneNode = PaneLeaf | PaneSplit;

export interface Tab {
  id: string;
  label: string;
  sessionId: string;
  root: PaneNode;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

interface State {
  tabs: Tab[];
  activeTabId: string | null;
  /** The focused leaf pane inside the active tab. */
  focusedPaneId: string | null;
  /** Maps paneId → SSH runtimeId (set by useXterm on connect). */
  paneRuntimeIds: Record<string, string>;
  /** Tabs that received output while inactive. */
  unreadTabs: Record<string, boolean>;
}

interface Actions {
  /** Open a new tab with a single terminal pane. */
  openTab: (sessionId: string, label: string) => string;
  /** Open a new tab with an SFTP explorer. */
  openSftpTab: (sessionId: string, label: string) => string;
  /** Close a tab by id, tearing down all its panes. Returns the list of
   *  pane ids that were removed (so callers can close SSH sessions). */
  closeTab: (tabId: string) => string[];
  /** Activate (switch to) a tab. */
  activateTab: (tabId: string) => void;
  /** Split the focused pane in the active tab. */
  splitPane: (direction: "horizontal" | "vertical") => void;
  /** Close a specific pane leaf by id. If it was the last pane in the tab,
   *  the whole tab is closed. Returns removed pane ids. */
  closePane: (paneId: string) => string[];
  /** Set the focused leaf pane. */
  focusPane: (paneId: string) => void;
  /** Register an SSH runtimeId for a pane (called by useXterm on connect). */
  setPaneRuntimeId: (paneId: string, runtimeId: string) => void;
  /** Remove runtimeId mapping (called on disconnect/close). */
  clearPaneRuntimeId: (paneId: string) => void;
  /** Get the runtimeId of the focused pane in the active tab (if any). */
  activeRuntimeId: () => string | null;
  /** Mark the tab containing `paneId` as having unread output. No-op if the
   *  tab is already active. */
  markPaneUnread: (paneId: string) => void;
}

export const useTabsStore = create<State & Actions>((set, get) => ({
  tabs: [],
  activeTabId: null,
  focusedPaneId: null,
  paneRuntimeIds: {},
  unreadTabs: {},

  openTab: (sessionId, label) => {
    const paneId = nanoid(8);
    const tabId = nanoid(8);
    const leaf: PaneLeaf = {
      type: "leaf",
      id: paneId,
      kind: "terminal",
      sessionId,
    };
    const tab: Tab = { id: tabId, label, sessionId, root: leaf };
    set((s) => ({
      tabs: [...s.tabs, tab],
      activeTabId: tabId,
      focusedPaneId: paneId,
    }));
    return paneId;
  },

  openSftpTab: (sessionId, label) => {
    const paneId = nanoid(8);
    const tabId = nanoid(8);
    const leaf: PaneLeaf = {
      type: "leaf",
      id: paneId,
      kind: "sftp",
      sessionId,
    };
    const tab: Tab = { id: tabId, label: `SFTP: ${label}`, sessionId, root: leaf };
    set((s) => ({
      tabs: [...s.tabs, tab],
      activeTabId: tabId,
      focusedPaneId: paneId,
    }));
    return paneId;
  },

  closeTab: (tabId) => {
    const { tabs, activeTabId } = get();
    const tab = tabs.find((t) => t.id === tabId);
    if (!tab) return [];

    const removed = collectLeafIds(tab.root);
    const remaining = tabs.filter((t) => t.id !== tabId);
    let nextActive = activeTabId;
    let nextFocused: string | null = null;
    if (activeTabId === tabId) {
      // Activate the next or previous tab
      const idx = tabs.findIndex((t) => t.id === tabId);
      const next = remaining[Math.min(idx, remaining.length - 1)] ?? null;
      nextActive = next?.id ?? null;
      nextFocused = next ? firstLeafId(next.root) : null;
    }
    set({
      tabs: remaining,
      activeTabId: nextActive,
      focusedPaneId: nextFocused ?? get().focusedPaneId,
    });
    return removed;
  },

  activateTab: (tabId) => {
    const tab = get().tabs.find((t) => t.id === tabId);
    set((s) => {
      const { [tabId]: _, ...rest } = s.unreadTabs;
      return {
        activeTabId: tabId,
        focusedPaneId: tab ? firstLeafId(tab.root) : null,
        unreadTabs: rest,
      };
    });
  },

  splitPane: (direction) => {
    const { tabs, activeTabId, focusedPaneId } = get();
    if (!activeTabId || !focusedPaneId) return;
    const tabIdx = tabs.findIndex((t) => t.id === activeTabId);
    if (tabIdx === -1) return;
    const tab = tabs[tabIdx];

    const leaf = findLeaf(tab.root, focusedPaneId);
    if (!leaf) return;

    const newLeafId = nanoid(8);
    const newLeaf: PaneLeaf = {
      type: "leaf",
      id: newLeafId,
      kind: leaf.kind,
      sessionId: leaf.sessionId,
    };
    const splitId = nanoid(8);
    const split: PaneSplit = {
      type: "split",
      id: splitId,
      direction,
      ratio: 0.5,
      children: [{ ...leaf }, newLeaf],
    };

    const newRoot = replaceNode(tab.root, focusedPaneId, split);
    const newTabs = [...tabs];
    newTabs[tabIdx] = { ...tab, root: newRoot };
    set({ tabs: newTabs, focusedPaneId: newLeafId });
  },

  closePane: (paneId) => {
    const { tabs, activeTabId } = get();
    const tabIdx = tabs.findIndex((t) => t.id === activeTabId);
    if (tabIdx === -1) return [];

    const tab = tabs[tabIdx];
    // If it's the only leaf, close the whole tab.
    if (tab.root.type === "leaf" && tab.root.id === paneId) {
      return get().closeTab(tab.id);
    }

    const newRoot = removeLeaf(tab.root, paneId);
    if (!newRoot) return get().closeTab(tab.id);

    const newTabs = [...tabs];
    newTabs[tabIdx] = { ...tab, root: newRoot };
    set({
      tabs: newTabs,
      focusedPaneId: firstLeafId(newRoot),
    });
    return [paneId];
  },

  focusPane: (paneId) => set({ focusedPaneId: paneId }),

  setPaneRuntimeId: (paneId, runtimeId) =>
    set((s) => ({
      paneRuntimeIds: { ...s.paneRuntimeIds, [paneId]: runtimeId },
    })),

  clearPaneRuntimeId: (paneId) =>
    set((s) => {
      const { [paneId]: _, ...rest } = s.paneRuntimeIds;
      return { paneRuntimeIds: rest };
    }),

  activeRuntimeId: () => {
    const { focusedPaneId, paneRuntimeIds } = get();
    if (!focusedPaneId) return null;
    return paneRuntimeIds[focusedPaneId] ?? null;
  },

  markPaneUnread: (paneId) => {
    const { tabs, activeTabId, unreadTabs } = get();
    // Find which tab owns this pane
    let tabId: string | null = null;
    for (const tab of tabs) {
      if (findLeaf(tab.root, paneId)) {
        tabId = tab.id;
        break;
      }
    }
    if (!tabId || tabId === activeTabId) return;
    if (unreadTabs[tabId]) return; // already marked
    set((s) => ({
      unreadTabs: { ...s.unreadTabs, [tabId]: true },
    }));
  },
}));

// ---------------------------------------------------------------------------
// Tree helpers
// ---------------------------------------------------------------------------

/** Collect all leaf ids in a tree (used for teardown). */
function collectLeafIds(node: PaneNode): string[] {
  if (node.type === "leaf") return [node.id];
  return [
    ...collectLeafIds(node.children[0]),
    ...collectLeafIds(node.children[1]),
  ];
}

/** Find the first (depth-first) leaf id. */
function firstLeafId(node: PaneNode): string {
  if (node.type === "leaf") return node.id;
  return firstLeafId(node.children[0]);
}

/** Find a leaf by id. */
function findLeaf(node: PaneNode, id: string): PaneLeaf | null {
  if (node.type === "leaf") return node.id === id ? node : null;
  return findLeaf(node.children[0], id) ?? findLeaf(node.children[1], id);
}

/** Replace a node (by id) with a new subtree. */
function replaceNode(tree: PaneNode, targetId: string, replacement: PaneNode): PaneNode {
  if (tree.type === "leaf") {
    return tree.id === targetId ? replacement : tree;
  }
  return {
    ...tree,
    children: [
      replaceNode(tree.children[0], targetId, replacement),
      replaceNode(tree.children[1], targetId, replacement),
    ],
  };
}

/** Remove a leaf — the sibling takes the parent split's place. */
function removeLeaf(tree: PaneNode, leafId: string): PaneNode | null {
  if (tree.type === "leaf") {
    return tree.id === leafId ? null : tree;
  }
  const [left, right] = tree.children;
  if (left.type === "leaf" && left.id === leafId) return right;
  if (right.type === "leaf" && right.id === leafId) return left;

  const newLeft = removeLeaf(left, leafId);
  if (newLeft !== left) {
    return newLeft
      ? { ...tree, children: [newLeft, right] }
      : right;
  }
  const newRight = removeLeaf(right, leafId);
  if (newRight !== right) {
    return newRight
      ? { ...tree, children: [left, newRight] }
      : left;
  }
  return tree;
}
