/**
 * @file src/platform/integrations/sync/markdown-card-sync.ts
 * @summary Headless domain module for synchronizing flashcard anchors and markdown formatting.
 *
 * Encapsulates all text-level mutations:
 * - Preprocessing SuperMemo / spaced-repetition shorthand syntax (?, ??)
 * - Card anchor ID allocation and line insertion (^lk-xxxxxxxxx)
 * - Shorthand card expansion (:: / ::: / CQ:: / RQ:: → canonical table delimiters)
 * - Markdown indentation and list/quote prefix preservation
 * - Orphan anchor detection and cleanup
 * - Pure, in-memory execution with no Obsidian Vault dependencies
 *
 * @exports
 *  - MarkdownCardSync
 *  - MarkdownCardSyncOptions
 *  - MarkdownCardSyncResult
 *  - TextEdit
 */

import { parseCardsFromText, type ParsedCard } from "../../../engine/parser/parser";
import { generateUniqueId } from "../../../platform/core/ids";
import {
  FLASHCARD_HEADER_CARD_RE,
  FLASHCARD_HEADER_FIELD_RE,
  getDelimiter,
  escapeDelimiterText,
  formatDelimitedField,
  stripClosingDelimiter,
  preprocessSrText,
  isMarkdownHeading,
  ANY_HEADER_DELIM_RE,
} from "../../../platform/core/delimiter";
import {
  buildPrimaryCardAnchor,
  extractCardAnchorId,
} from "../../../platform/core/identity";

// ── Types ─────────────────────────────────────────────────────────────────────

export type TextEdit = {
  lineIndex: number;
  insertText?: string;
  deleteLine?: boolean;
};

export type MarkdownCardSyncOptions = {
  syncMode?: "full" | "simple" | "simple-safe" | "simple-compat";
  ignoreInCodeFences?: boolean;
  usedIds?: Set<string>;
  storeCards?: Record<string, { sourceNotePath?: string } | undefined>;
  storeQuarantine?: Record<string, { notePath?: string } | undefined>;
};

export type MarkdownCardSyncResult = {
  updatedText: string;
  cards: Array<ParsedCard & { assignedId?: string }>;
  parsedCards: Array<ParsedCard & { assignedId?: string }>;
  keepIds: Set<string>;
  idsInserted: number;
  anchorsRemoved: number;
  hadEdits: boolean;
  editsCount: number;
};

// ── Helpers ───────────────────────────────────────────────────────────────────

const PREFIX_RE = /^(\s*(?:(?:>\s*)|(?:[-*+]\s+)|(?:\d+\.\s+))*)(.*)$/;

export function splitMdPrefix(line: string): { prefix: string; rest: string } {
  const m = PREFIX_RE.exec(String(line ?? ""));
  if (!m) return { prefix: "", rest: String(line ?? "") };
  return { prefix: m[1] ?? "", rest: m[2] ?? "" };
}

export function looksLikeFlashcardHeader(rest: string): boolean {
  const s = String(rest ?? "");
  if (extractCardAnchorId(s) !== null) return true;
  if (FLASHCARD_HEADER_CARD_RE().test(s)) return true;
  if (FLASHCARD_HEADER_FIELD_RE().test(s)) return true;
  if (/^\d+(?:\.\d+)?\s*\|\s*/.test(s)) return true;
  return false;
}

export function normaliseTextForParsing(originalText: string): string {
  const lines = String(originalText ?? "").split(/\r?\n/);
  const out = lines.map((ln) => {
    const { rest } = splitMdPrefix(ln);
    return looksLikeFlashcardHeader(rest) ? rest : ln;
  });
  return out.join("\n");
}

export function matchAnchorId(line: string): string | null {
  const { rest } = splitMdPrefix(line);
  return extractCardAnchorId(rest);
}

export function inferPrefixAt(lines: string[], lineIndex: number): string {
  const idx = Math.max(0, Math.min(lines.length, lineIndex));
  if (idx >= lines.length) return "";
  const { prefix, rest } = splitMdPrefix(lines[idx] || "");
  return looksLikeFlashcardHeader(rest) ? prefix : "";
}

export function getBlockBounds(lines: string[], cardStartLine: number): { lo: number; hi: number } {
  const isBlank = (s: string) => (s || "").trim().length === 0;
  const start = Math.max(0, Math.min(lines.length - 1, cardStartLine));

  let lo = start;
  while (lo > 0 && !isBlank(lines[lo - 1])) lo--;

  let hi = start;
  while (hi < lines.length && !isBlank(lines[hi])) hi++;

  return { lo, hi };
}

export function findAnchorInsertLineIndex(lines: string[], cardStartLine: number): number {
  const { lo: blockLo, hi: blockHi } = getBlockBounds(lines, cardStartLine);
  const start = Math.max(0, Math.min(lines.length - 1, cardStartLine));

  for (let i = blockLo; i < blockHi; i++) {
    const { rest } = splitMdPrefix(lines[i] || "");
    if (looksLikeFlashcardHeader(rest)) return i;
  }

  return start;
}

export function collectAnchorIdsFromLines(lines: string[]): Set<string> {
  const out = new Set<string>();
  for (const ln of lines) {
    const id = matchAnchorId(ln);
    if (id) out.add(id);
  }
  return out;
}

export function collectAnchorLineIndicesToDelete(lines: string[], keepIds: Set<string>): number[] {
  const dels: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    const id = matchAnchorId(lines[i] || "");
    if (!id) continue;
    if (!keepIds.has(id)) dels.push(i);
  }
  return dels;
}

export function applyEditsToLines(lines: string[], edits: TextEdit[]): string[] {
  const byIdx = new Map<number, TextEdit[]>();
  for (const e of edits) {
    const idx = Math.max(0, Math.min(lines.length, e.lineIndex));
    const arr = byIdx.get(idx) ?? [];
    arr.push({ ...e, lineIndex: idx });
    byIdx.set(idx, arr);
  }

  const indices = Array.from(byIdx.keys()).sort((a, b) => b - a);

  for (const idx of indices) {
    const ops = byIdx.get(idx) ?? [];
    const dels = ops.filter((o) => o.deleteLine);
    const ins = ops.filter((o) => typeof o.insertText === "string" && o.insertText.length);

    for (let i = 0; i < dels.length; i++) {
      if (idx >= 0 && idx < lines.length) lines.splice(idx, 1);
    }
    for (const o of ins) {
      const parts = String(o.insertText || "").split("\n");
      lines.splice(idx, 0, ...parts);
    }
  }

  return lines;
}

const IO_IMAGE_ID_RE = /(?:sprout|learnkit)-io-(\d{9})/i;

function inferIoIdFromCard(c: ParsedCard): string | null {
  if (!c || c.type !== "io") return null;
  const raw = String((c as { ioSrc?: string }).ioSrc ?? "");
  if (!raw) return null;
  const match = IO_IMAGE_ID_RE.exec(raw);
  return match?.[1] ?? null;
}

function findDelimitedFieldRange(
  lines: string[],
  startLine: number,
  endLine: number,
  key: string,
): { start: number; end: number; prefix: string } | null {
  const upperKey = key.toUpperCase();
  const lastLine = Math.min(endLine, lines.length - 1);

  for (let lineIndex = Math.max(0, startLine); lineIndex <= lastLine; lineIndex++) {
    const { prefix, rest } = splitMdPrefix(lines[lineIndex] || "");
    const match = rest.match(FLASHCARD_HEADER_FIELD_RE());
    if (!match || match[1]?.toUpperCase() !== upperKey) continue;

    let end = lineIndex;
    const headerRemainder = rest.slice(match[0].length);
    if (!stripClosingDelimiter(headerRemainder).closed) {
      for (let cursor = lineIndex + 1; cursor <= lastLine; cursor++) {
        const continuation = splitMdPrefix(lines[cursor] || "").rest;
        end = cursor;
        if (stripClosingDelimiter(continuation).closed) break;
        if (FLASHCARD_HEADER_CARD_RE().test(continuation) || FLASHCARD_HEADER_FIELD_RE().test(continuation)) break;
      }
    }

    return { start: lineIndex, end, prefix };
  }

  return null;
}

function findAnchoredCardSearchEndLine(lines: string[], startLine: number): number {
  const start = Math.max(0, Math.min(lines.length - 1, startLine));

  for (let lineIndex = start + 1; lineIndex < lines.length; lineIndex++) {
    const trimmed = (lines[lineIndex] || "").trim();
    if (!trimmed) return lineIndex - 1;
    if (matchAnchorId(lines[lineIndex] || "")) return lineIndex - 1;
  }

  return lines.length - 1;
}

function queueCanonicalGroupFieldEdit(lines: string[], edits: TextEdit[], card: ParsedCard): void {
  const groups = Array.isArray(card.groups) ? card.groups : [];
  if (!groups.length) return;

  const fieldRange = findDelimitedFieldRange(lines, card.sourceStartLine, findAnchoredCardSearchEndLine(lines, card.sourceStartLine), "G");
  if (!fieldRange) return;

  const canonicalLines = formatDelimitedField("G", groups.join(", "));
  const prefixedCanonicalLines = canonicalLines.map((line) => `${fieldRange.prefix}${line}`);
  const existingLines = lines.slice(fieldRange.start, fieldRange.end + 1);
  if (existingLines.join("\n") === prefixedCanonicalLines.join("\n")) return;

  for (let lineIndex = fieldRange.end; lineIndex >= fieldRange.start; lineIndex--) {
    edits.push({ lineIndex, deleteLine: true });
  }
  edits.push({ lineIndex: fieldRange.start, insertText: prefixedCanonicalLines.join("\n") });
}

function queueStripHiddenFields(lines: string[], edits: TextEdit[], card: ParsedCard): void {
  const keysToStrip = card.type === "hq" ? ["O", "M"] : card.type === "io" ? ["O", "C"] : [];
  if (!keysToStrip.length) return;

  const endLine = findAnchoredCardSearchEndLine(lines, card.sourceStartLine);
  for (const key of keysToStrip) {
    const fieldRange = findDelimitedFieldRange(lines, card.sourceStartLine, endLine, key);
    if (!fieldRange) continue;
    for (let lineIndex = fieldRange.end; lineIndex >= fieldRange.start; lineIndex--) {
      edits.push({ lineIndex, deleteLine: true });
    }
  }
}

function queueComboTypeMigration(lines: string[], edits: TextEdit[], card: ParsedCard): void {
  if (card.type !== "basic") return;
  const hasVariants =
    (Array.isArray(card.qVariants) && card.qVariants.length > 1) ||
    (Array.isArray(card.aVariants) && card.aVariants.length > 1);
  if (!hasVariants) return;

  const endLine = findAnchoredCardSearchEndLine(lines, card.sourceStartLine);
  const typeRange = findDelimitedFieldRange(lines, card.sourceStartLine, endLine, "TYPE");
  if (typeRange) {
    for (let i = typeRange.end; i >= typeRange.start; i--) {
      edits.push({ lineIndex: i, deleteLine: true });
    }
  }

  const d = getDelimiter();
  const insertIndex = typeRange ? typeRange.start : card.sourceStartLine;
  const prefix = inferPrefixAt(lines, insertIndex);
  edits.push({ lineIndex: insertIndex, insertText: `${prefix}TYPE ${d} combo ${d}` });
}

function parseShorthandModeForSync(syncMode: string): "all" | "anchored-only" {
  return syncMode === "simple-safe" ? "anchored-only" : "all";
}

// ── Primary Module ────────────────────────────────────────────────────────────

export class MarkdownCardSync {
  /**
   * Synchronizes markdown text: parses card definitions, assigns anchors, normalizes
   * shorthand notation according to syncMode, prunes orphaned anchors, and returns
   * the updated text.
   */
  static syncText(
    originalText: string,
    filePath: string,
    options: MarkdownCardSyncOptions = {},
  ): MarkdownCardSyncResult {
    const syncMode = options.syncMode ?? "simple-safe";
    const shorthandMode = parseShorthandModeForSync(syncMode);
    const ignoreInCodeFences = options.ignoreInCodeFences ?? true;

    // 1. Preprocess SR multi-line blocks (?, ??)
    const processedText = preprocessSrText(
      originalText,
      ignoreInCodeFences,
      (ln: string) => ANY_HEADER_DELIM_RE().test(ln) || isMarkdownHeading(ln),
    );

    const lines = processedText.split(/\r?\n/);
    const parseText = normaliseTextForParsing(processedText);
    const { cards } = parseCardsFromText(filePath, parseText, ignoreInCodeFences, {
      shorthandMode,
    }) as { cards: Array<ParsedCard & { assignedId?: string }> };

    const usedIds = new Set<string>(options.usedIds ?? []);
    for (const ln of lines) {
      const id = matchAnchorId(ln);
      if (id) usedIds.add(id);
    }

    const existingAnchorIds = collectAnchorIdsFromLines(lines);
    const edits: TextEdit[] = [];
    const keepIds = new Set<string>();

    let idsInserted = 0;
    let anchorsRemoved = 0;

    // 2. Assign anchor IDs and plan insertions / expansions
    for (const c of cards) {
      let id: string | null = c.id ? String(c.id) : null;

      if (!id) {
        const inferred = inferIoIdFromCard(c);
        if (inferred) {
          const existing = options.storeCards?.[inferred] ?? options.storeQuarantine?.[inferred];
          const existingNote = (existing as { sourceNotePath?: string })?.sourceNotePath || (existing as { notePath?: string })?.notePath || "";
          const sameNote = existing && existingNote === filePath;
          id = !usedIds.has(inferred) || sameNote ? inferred : generateUniqueId(usedIds);
        } else {
          id = generateUniqueId(usedIds);
        }
        c.assignedId = id;
      }

      usedIds.add(id);
      keepIds.add(id);

      if (c.isShorthand) {
        const shorthandLine = c.sourceEndLine;
        const prefix = inferPrefixAt(lines, shorthandLine);

        if (syncMode !== "full") {
          if (!existingAnchorIds.has(id)) {
            const insertAt = findAnchorInsertLineIndex(lines, c.sourceStartLine);
            edits.push({ lineIndex: insertAt, insertText: `${prefix}${buildPrimaryCardAnchor(id)}` });
            idsInserted += 1;
            existingAnchorIds.add(id);
          }
        } else {
          const d = getDelimiter();
          const canonicalLines: string[] = [];
          if (!existingAnchorIds.has(id)) {
            canonicalLines.push(`${prefix}${buildPrimaryCardAnchor(id)}`);
            idsInserted += 1;
          }

          if (c.type === "cloze") {
            const cqEsc = escapeDelimiterText(c.clozeText ?? "", { escapeBackslashes: false });
            canonicalLines.push(`${prefix}CQ ${d} ${cqEsc} ${d}`);
          } else if (c.type === "reversed") {
            const qEsc = escapeDelimiterText(c.q ?? "", { escapeBackslashes: false });
            const aEsc = escapeDelimiterText(c.a ?? "", { escapeBackslashes: false });
            canonicalLines.push(`${prefix}RQ ${d} ${qEsc} ${d}`);
            canonicalLines.push(`${prefix}A ${d} ${aEsc} ${d}`);
          } else {
            const qEsc = escapeDelimiterText(c.q ?? "", { escapeBackslashes: false });
            const aEsc = escapeDelimiterText(c.a ?? "", { escapeBackslashes: false });
            canonicalLines.push(`${prefix}Q ${d} ${qEsc} ${d}`);
            canonicalLines.push(`${prefix}A ${d} ${aEsc} ${d}`);
          }

          edits.push({ lineIndex: shorthandLine, deleteLine: true });
          edits.push({ lineIndex: shorthandLine, insertText: canonicalLines.join("\n") });
        }
        existingAnchorIds.add(id);
      } else if (!existingAnchorIds.has(id)) {
        const insertAt = findAnchorInsertLineIndex(lines, c.sourceStartLine);
        const prefix = inferPrefixAt(lines, insertAt);
        edits.push({ lineIndex: insertAt, insertText: `${prefix}${buildPrimaryCardAnchor(id)}` });
        idsInserted += 1;
        existingAnchorIds.add(id);
      } else if (syncMode === "full") {
        queueCanonicalGroupFieldEdit(lines, edits, c);
        queueStripHiddenFields(lines, edits, c);
        queueComboTypeMigration(lines, edits, c);
      }
    }

    // 3. Remove orphan anchors
    const orphanLineIdxs = collectAnchorLineIndicesToDelete(lines, keepIds);
    for (const idx of orphanLineIdxs) {
      edits.push({ lineIndex: idx, deleteLine: true });
      anchorsRemoved += 1;
    }

    // 4. Apply edits
    const hadEdits = edits.length > 0;
    if (hadEdits) {
      applyEditsToLines(lines, edits);
    }

    return {
      updatedText: hadEdits ? lines.join("\n") : originalText,
      cards,
      parsedCards: cards,
      keepIds,
      idsInserted,
      anchorsRemoved,
      hadEdits,
      editsCount: edits.length,
    };
  }
}
