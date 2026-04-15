import { useEffect, useRef, useState, type CSSProperties, type RefObject } from "react";

/**
 * Elements that handle their own mouse events — we never start a drag when the
 * user presses one of these. Keeps buttons, inputs, comboboxes etc. clickable.
 */
const INTERACTIVE_SELECTOR = [
  "button",
  "input",
  "textarea",
  "select",
  "a[href]",
  '[contenteditable="true"]',
  '[role="button"]',
  '[role="tab"]',
  '[role="option"]',
  '[role="combobox"]',
  '[role="menuitem"]',
  '[role="slider"]',
  '[role="switch"]',
  '[role="checkbox"]',
].join(",");

/**
 * Height (px) of the draggable zone at the top of the dialog. Clicking above
 * this line on a non-interactive element starts a drag; clicking below is
 * passed through to normal form interaction.
 */
const HANDLE_HEIGHT = 72;

/**
 * Makes a Radix `Dialog.Content` draggable inside the webview. Returns an
 * inline `transform` that overrides Tailwind's `-translate-x-1/2
 * -translate-y-1/2` centring — the dialog stays centred at (0,0) offset and
 * shifts by the accumulated drag delta. The offset resets each time the
 * element is mounted, so reopening a dialog re-centres it.
 */
export function useDialogDrag(ref: RefObject<HTMLElement>): {
  style: CSSProperties;
} {
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const offsetRef = useRef(offset);
  offsetRef.current = offset;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    let startX = 0;
    let startY = 0;
    let baseX = 0;
    let baseY = 0;
    let dragging = false;

    const onMove = (e: MouseEvent) => {
      if (!dragging) return;
      e.preventDefault();
      setOffset({
        x: baseX + (e.clientX - startX),
        y: baseY + (e.clientY - startY),
      });
    };
    const onUp = () => {
      if (!dragging) return;
      dragging = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    const onDown = (e: MouseEvent) => {
      if (e.button !== 0) return;
      const target = e.target as HTMLElement | null;
      if (!target) return;
      if (target.closest(INTERACTIVE_SELECTOR)) return;
      const rect = el.getBoundingClientRect();
      if (e.clientY - rect.top > HANDLE_HEIGHT) return;

      dragging = true;
      startX = e.clientX;
      startY = e.clientY;
      baseX = offsetRef.current.x;
      baseY = offsetRef.current.y;
      document.body.style.cursor = "grabbing";
      document.body.style.userSelect = "none";
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
      e.preventDefault();
    };

    el.addEventListener("mousedown", onDown);
    return () => {
      el.removeEventListener("mousedown", onDown);
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
  }, [ref]);

  return {
    style: {
      transform: `translate(calc(-50% + ${offset.x}px), calc(-50% + ${offset.y}px))`,
    },
  };
}
