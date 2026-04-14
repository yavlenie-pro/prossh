import { useRef } from "react";

import type { PaneNode, PaneSplit } from "@/stores/tabs";

import { PaneLeafView } from "./PaneLeafView";

interface Props {
  node: PaneNode;
}

/**
 * Recursively renders a pane tree. Split nodes lay out their children in a
 * flex container; leaf nodes render the actual content (terminal / sftp).
 *
 * TODO(step 7+): add drag-resize handles between split children.
 */
export function SplitPane({ node }: Props) {
  if (node.type === "leaf") {
    return <PaneLeafView leaf={node} />;
  }
  return <SplitView split={node} />;
}

function SplitView({ split }: { split: PaneSplit }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const isH = split.direction === "horizontal";
  const pct = `${(split.ratio * 100).toFixed(1)}%`;

  return (
    <div
      ref={containerRef}
      className="flex min-h-0 min-w-0 flex-1"
      style={{ flexDirection: isH ? "row" : "column" }}
    >
      <div style={{ flex: `0 0 ${pct}` }} className="flex min-h-0 min-w-0">
        <SplitPane node={split.children[0]} />
      </div>
      {/* Resize handle — cosmetic for now; draggable in a later polish pass */}
      <div
        className={
          isH
            ? "w-1 shrink-0 cursor-col-resize bg-border-subtle hover:bg-accent"
            : "h-1 shrink-0 cursor-row-resize bg-border-subtle hover:bg-accent"
        }
      />
      <div className="flex min-h-0 min-w-0 flex-1">
        <SplitPane node={split.children[1]} />
      </div>
    </div>
  );
}
