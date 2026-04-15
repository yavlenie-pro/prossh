/**
 * Modal dialog for creating / editing a script with multiline bash editor
 * and basic syntax highlighting.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { useTranslation } from "react-i18next";

import { DraggableDialogContent } from "@/components/ui/DraggableDialogContent";

// ── Types ────────────────────────────────────────────────────────────────

export interface ScriptEditorData {
  name: string;
  command: string;
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** If provided, we're editing an existing script; otherwise creating new. */
  initial?: ScriptEditorData;
  /** Called when user presses Save with valid data. */
  onSave: (data: ScriptEditorData) => void;
}

// ── Bash syntax highlighting ─────────────────────────────────────────────

// Order matters — more specific patterns first.
const BASH_RULES: { pattern: RegExp; className: string }[] = [
  // Comments
  { pattern: /#.*$/gm, className: "text-emerald-500" },
  // Strings (double-quoted, may span content but not newlines for simplicity)
  { pattern: /"(?:[^"\\]|\\.)*"/g, className: "text-amber-400" },
  // Strings (single-quoted)
  { pattern: /'[^']*'/g, className: "text-amber-400" },
  // Variable / env references
  { pattern: /\$\{[^}]*\}|\$[A-Za-z_][A-Za-z0-9_]*/g, className: "text-cyan-400" },
  // Numbers (standalone)
  { pattern: /\b\d+\b/g, className: "text-purple-400" },
  // Keywords
  {
    pattern:
      /\b(?:if|then|else|elif|fi|for|while|until|do|done|case|esac|in|function|return|local|export|readonly|declare|unset|shift|break|continue|exit|trap|source|true|false|sudo)\b/g,
    className: "text-pink-400 font-semibold",
  },
  // Common builtins / commands
  {
    pattern:
      /\b(?:echo|printf|cat|grep|awk|sed|find|xargs|curl|wget|chmod|chown|mkdir|rm|cp|mv|ls|cd|pwd|kill|ps|systemctl|service|docker|kubectl|apt|yum|dnf|pip|npm|git|tar|gzip|gunzip|zip|unzip|head|tail|sort|wc|cut|tr|tee|touch|stat|df|du|mount|umount|ssh|scp|rsync)\b/g,
    className: "text-blue-400",
  },
  // Operators / redirections
  { pattern: /[|&;><]{1,2}/g, className: "text-fg-subtle" },
  // Flags (--flag or -f)
  { pattern: /(?<=\s)-{1,2}[A-Za-z][\w-]*/g, className: "text-teal-400" },
];

/** Tokenise `code` into an array of {text, className?} spans.
 *  Overlapping matches are handled by processing left-to-right and skipping
 *  already-consumed ranges. */
interface Token {
  text: string;
  className?: string;
}

function tokenize(code: string): Token[] {
  // Collect all matches with their positions
  const matches: { start: number; end: number; className: string }[] = [];
  for (const rule of BASH_RULES) {
    const re = new RegExp(rule.pattern.source, rule.pattern.flags);
    let m: RegExpExecArray | null;
    while ((m = re.exec(code)) !== null) {
      matches.push({ start: m.index, end: m.index + m[0].length, className: rule.className });
    }
  }
  // Sort by start, then by longer match first
  matches.sort((a, b) => a.start - b.start || b.end - a.end);

  const tokens: Token[] = [];
  let cursor = 0;
  for (const m of matches) {
    if (m.start < cursor) continue; // overlapping — skip
    if (m.start > cursor) {
      tokens.push({ text: code.slice(cursor, m.start) });
    }
    tokens.push({ text: code.slice(m.start, m.end), className: m.className });
    cursor = m.end;
  }
  if (cursor < code.length) {
    tokens.push({ text: code.slice(cursor) });
  }
  return tokens;
}

// ── Component ────────────────────────────────────────────────────────────

export function ScriptEditorDialog({ open, onOpenChange, initial, onSave }: Props) {
  const { t } = useTranslation();
  const [name, setName] = useState(initial?.name ?? "");
  const [command, setCommand] = useState(initial?.command ?? "");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const highlightRef = useRef<HTMLPreElement>(null);

  // Reset state when dialog opens with new data
  useEffect(() => {
    if (open) {
      setName(initial?.name ?? "");
      setCommand(initial?.command ?? "");
    }
  }, [open, initial]);

  // Sync scroll between textarea and highlight overlay
  const syncScroll = useCallback(() => {
    if (textareaRef.current && highlightRef.current) {
      highlightRef.current.scrollTop = textareaRef.current.scrollTop;
      highlightRef.current.scrollLeft = textareaRef.current.scrollLeft;
    }
  }, []);

  const handleSave = () => {
    const n = name.trim();
    const c = command.trim();
    if (!n || !c) return;
    onSave({ name: n, command: c });
    onOpenChange(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    // Ctrl/Cmd+Enter to save
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      handleSave();
      return;
    }
    // Tab inserts 2 spaces
    if (e.key === "Tab") {
      e.preventDefault();
      const ta = textareaRef.current;
      if (!ta) return;
      const start = ta.selectionStart;
      const end = ta.selectionEnd;
      const before = command.slice(0, start);
      const after = command.slice(end);
      const newVal = before + "  " + after;
      setCommand(newVal);
      // Restore cursor after React re-render
      requestAnimationFrame(() => {
        ta.selectionStart = ta.selectionEnd = start + 2;
      });
    }
  };

  const tokens = tokenize(command);
  const isNew = !initial;
  const title = isNew ? t("settings.newScript") : t("settings.editScript");

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50 data-[state=open]:animate-in data-[state=open]:fade-in" />
        <DraggableDialogContent className="fixed left-1/2 top-1/2 z-50 flex max-h-[85vh] w-[560px] -translate-x-1/2 -translate-y-1/2 flex-col rounded-xl border border-border-subtle bg-bg-elevated shadow-2xl data-[state=open]:animate-in data-[state=open]:fade-in data-[state=open]:zoom-in-95">
          {/* Header */}
          <div className="flex items-center justify-between border-b border-border-subtle px-5 py-3">
            <Dialog.Title className="text-sm font-semibold text-fg">
              {title}
            </Dialog.Title>
            <Dialog.Close className="rounded p-1 text-fg-muted transition-colors hover:bg-fg-muted/10 hover:text-fg">
              <X className="h-4 w-4" />
            </Dialog.Close>
          </div>

          {/* Body */}
          <div className="flex flex-1 flex-col gap-3 overflow-y-auto px-5 py-4">
            {/* Name */}
            <div className="flex flex-col gap-1">
              <label className="text-xs font-medium text-fg-muted">{t("settings.scriptName")}</label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t("settings.scriptNamePlaceholder")}
                autoFocus
                className="rounded border border-border-subtle bg-bg px-3 py-2 text-sm text-fg outline-none placeholder:text-fg-subtle focus:border-accent"
              />
            </div>

            {/* Command editor with syntax highlighting */}
            <div className="flex flex-col gap-1">
              <label className="text-xs font-medium text-fg-muted">{t("settings.scriptCommandMultiline")}</label>
              <div className="relative min-h-[200px] flex-1 rounded border border-border-subtle bg-[#1a1b26] focus-within:border-accent">
                {/* Highlighted overlay (non-interactive) */}
                <pre
                  ref={highlightRef}
                  aria-hidden
                  className="pointer-events-none absolute inset-0 overflow-hidden whitespace-pre-wrap break-words p-3 font-mono text-sm leading-relaxed text-fg"
                >
                  {tokens.map((tok, i) =>
                    tok.className ? (
                      <span key={i} className={tok.className}>
                        {tok.text}
                      </span>
                    ) : (
                      <span key={i}>{tok.text}</span>
                    ),
                  )}
                  {/* Ensure trailing newline renders space for cursor */}
                  {"\n"}
                </pre>

                {/* Actual textarea (transparent text, visible caret) */}
                <textarea
                  ref={textareaRef}
                  value={command}
                  onChange={(e) => setCommand(e.target.value)}
                  onScroll={syncScroll}
                  onKeyDown={handleKeyDown}
                  placeholder={t("settings.scriptCommandPlaceholder")}
                  spellCheck={false}
                  className="relative z-10 h-full min-h-[200px] w-full resize-y whitespace-pre-wrap break-words bg-transparent p-3 font-mono text-sm leading-relaxed text-transparent caret-fg outline-none placeholder:text-fg-subtle/40"
                />
              </div>
              <p className="text-[10px] text-fg-subtle">
                Tab = 2 spaces · Ctrl+Enter = save
              </p>
            </div>
          </div>

          {/* Footer */}
          <div className="flex items-center justify-end gap-2 border-t border-border-subtle px-5 py-3">
            <Dialog.Close asChild>
              <button
                type="button"
                className="rounded px-3 py-1.5 text-xs text-fg-muted transition-colors hover:bg-fg-muted/10 hover:text-fg"
              >
                {t("dialog.cancel")}
              </button>
            </Dialog.Close>
            <button
              type="button"
              onClick={handleSave}
              disabled={!name.trim() || !command.trim()}
              className="rounded bg-accent px-4 py-1.5 text-xs font-medium text-white transition-colors hover:bg-accent/90 disabled:opacity-40"
            >
              {t("dialog.save")}
            </button>
          </div>
        </DraggableDialogContent>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
