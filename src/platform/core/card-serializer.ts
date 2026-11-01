/**
 * Card Serializer
 *
 * Pure domain module responsible for serializing parsed cards and card fields
 * into Markdown representations using configurable delimiters.
 */

import { getDelimiter, escapeDelimiterText } from "./delimiter";
import { buildPrimaryCardAnchor } from "./identity";
import { normalizeGroups } from "../../engine/indexing/group-format";

const _isCodeFenceLine = (line: string): boolean => /^\s*`{3,}\s*\w*\s*$/.test(String(line ?? ""));

/**
 * Delimiter used to separate question/answer variants inside QX and AX fields
 * of combo (Cartesian product) cards.
 *
 * Uses `::` (double colon) rather than `||` to avoid escaping conflicts with
 * the pipe-delimited card format.
 */
export const COMBO_VARIANT_SEPARATOR = " :: ";

/**
 * Delimiter used to separate question/answer variants inside QX and AX fields
 * of combo (sequential/zip) cards.
 *
 * Uses `:::` (triple colon) inside field pipes. Note: the bare-line `:::` shorthand
 * syntax (e.g. `Question:::Answer`) is parsed before field content is read and
 * therefore does not conflict.
 */
export const COMBO_ZIP_SEPARATOR = " ::: ";

/**
 * Splits a raw QX/AX field value into individual Cartesian product variants.
 * Supports both the current `::` delimiter and the legacy `||` delimiter
 * for backward compatibility with cards written by older plugin versions.
 *
 * Note: uses negative lookaheads to avoid matching `::` inside `:::`.
 */
export function splitComboVariants(raw: string): string[] {
  // Split on :: (not preceded or followed by another :) or legacy ||
  return String(raw ?? "")
    .split(/(?<!:)::(?!:)|\s*\|\|\s*/)
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
}

/**
 * Splits a raw QX/AX field value into sequential (zip) variants.
 * Uses `:::` (triple colon) as the separator.
 * Q and A variant counts must be equal for a valid zip combo card.
 */
export function splitZipVariants(raw: string): string[] {
  return String(raw ?? "")
    .split(/\s*:::\s*/)
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
}

/**
 * Format a single delimited field. Multi-line values are split across
 * multiple output lines (the closing delimiter is on the last line).
 */
export function formatDelimitedField(
  key: string,
  value: string,
  delimiter?: string,
): string[] {
  const d = delimiter ?? getDelimiter();
  const raw = String(value ?? "");
  const parts = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const escapeFieldText = (line: string): string =>
    escapeDelimiterText(line, { escapeBackslashes: false, delimiter: d });
  const pushFinalLine = (out: string[], line: string) => {
    const escaped = escapeFieldText(line);
    if (String(line ?? "").trim() === "$$") {
      out.push(escaped);
      out.push(d);
      return;
    }
    out.push(`${escaped} ${d}`);
  };
  const startsWithListMarker = (line: string): boolean =>
    /^\s*(?:[-+*]|\d+[.)])\s+/.test(String(line ?? ""));

  if (parts.length <= 1 && !startsWithListMarker(parts[0] ?? "")) {
    return [`${key} ${d} ${escapeFieldText(parts[0] ?? "")} ${d}`];
  }

  if (startsWithListMarker(parts[0] ?? "")) {
    const out: string[] = [];
    out.push(`${key} ${d}`);
    for (let i = 0; i < parts.length - 1; i++) out.push(escapeFieldText(parts[i] ?? ""));
    pushFinalLine(out, parts[parts.length - 1] ?? "");
    return out;
  }

  // Code-fence opener on first line: put the field header on its own line.
  if (_isCodeFenceLine(parts[0] ?? "")) {
    const out: string[] = [];
    out.push(`${key} ${d}`);
    for (let i = 0; i < parts.length - 1; i++) out.push(escapeFieldText(parts[i] ?? ""));
    pushFinalLine(out, parts[parts.length - 1] ?? "");
    return out;
  }

  const out: string[] = [];
  out.push(`${key} ${d} ${escapeFieldText(parts[0] ?? "")}`);
  for (let i = 1; i < parts.length - 1; i++) out.push(escapeFieldText(parts[i] ?? ""));
  pushFinalLine(out, parts[parts.length - 1] ?? "");
  return out;
}

/**
 * Push a key-value field to a delimited card block.
 * Handles single-line (`KEY <d> value <d>`) and multi-line formatting.
 */
export function pushDelimitedField(
  out: string[],
  key: string,
  value: string,
  delimiter?: string,
): void {
  out.push(...formatDelimitedField(key, value, delimiter));
}

export type McqOptionInput = { text: string; isCorrect: boolean } | string;

export interface CardSerializationInput {
  id?: string | null;
  type?: "basic" | "reversed" | "mcq" | "cloze" | "io" | "hq" | "oq" | "combo";
  title?: string | null;
  q?: string | null;
  a?: string | null;
  stem?: string | null;
  options?: McqOptionInput[] | null;
  correctOptionIndexes?: number[] | null;
  clozeText?: string | null;
  prompt?: string | null;
  ioSrc?: string | null;
  ioOcclusions?: unknown[] | string | null;
  maskMode?: "solo" | "all" | null;
  hqSrc?: string | null;
  hqRegions?: unknown[] | string | null;
  interactionMode?: "click" | "drag-drop" | null;
  oqSteps?: string[] | null;
  qVariants?: string[] | null;
  aVariants?: string[] | null;
  comboMode?: "product" | "zip" | null;
  info?: string | null;
  groups?: string[] | null;
  audioRef?: string | null;
}

export interface CardSerializationOptions {
  delimiter?: string;
  includeId?: boolean;
  includeTitle?: boolean;
  includeInfo?: boolean;
  includeGroups?: boolean;
}

/**
 * Serializes a card object into Markdown lines according to the active
 * or specified delimiter format.
 */
export function serializeCard(
  card: CardSerializationInput,
  options?: CardSerializationOptions,
): string {
  const d = options?.delimiter ?? getDelimiter();
  const lines: string[] = [];

  // Card anchor if present and enabled
  if (options?.includeId !== false && card.id) {
    lines.push(buildPrimaryCardAnchor(card.id));
  }

  // Title
  if (options?.includeTitle !== false && card.title) {
    pushDelimitedField(lines, "T", card.title, d);
  }

  const type = card.type ?? "basic";
  switch (type) {
    case "basic": {
      pushDelimitedField(lines, "Q", card.q ?? "", d);
      pushDelimitedField(lines, "A", card.a ?? "", d);
      break;
    }
    case "reversed": {
      pushDelimitedField(lines, "RQ", card.q ?? "", d);
      pushDelimitedField(lines, "A", card.a ?? "", d);
      break;
    }
    case "cloze": {
      pushDelimitedField(lines, "CQ", card.clozeText ?? card.q ?? "", d);
      break;
    }
    case "mcq": {
      pushDelimitedField(lines, "MCQ", card.stem ?? card.q ?? "", d);
      if (Array.isArray(card.options)) {
        const correctSet = new Set<number>(
          Array.isArray(card.correctOptionIndexes) ? card.correctOptionIndexes : [],
        );
        card.options.forEach((opt, idx) => {
          if (typeof opt === "string") {
            const isCorrect = correctSet.has(idx);
            pushDelimitedField(lines, isCorrect ? "A" : "O", opt, d);
          } else if (opt && typeof opt === "object") {
            pushDelimitedField(lines, opt.isCorrect ? "A" : "O", opt.text, d);
          }
        });
      }
      if (card.a) {
        pushDelimitedField(lines, "A", card.a, d);
      }
      break;
    }
    case "oq": {
      pushDelimitedField(lines, "OQ", card.stem ?? card.q ?? "", d);
      if (Array.isArray(card.oqSteps)) {
        card.oqSteps.forEach((step, idx) => {
          pushDelimitedField(lines, String(idx + 1), step, d);
        });
      }
      break;
    }
    case "io": {
      if (card.ioSrc) pushDelimitedField(lines, "IO", card.ioSrc, d);
      if (card.q) pushDelimitedField(lines, "Q", card.q, d);
      if (card.ioOcclusions) {
        const occStr =
          typeof card.ioOcclusions === "string"
            ? card.ioOcclusions
            : JSON.stringify(card.ioOcclusions);
        pushDelimitedField(lines, "O", occStr, d);
      }
      if (card.maskMode) {
        pushDelimitedField(lines, "C", card.maskMode, d);
      }
      break;
    }
    case "hq": {
      if (card.hqSrc) pushDelimitedField(lines, "HQ", card.hqSrc, d);
      if (card.q) pushDelimitedField(lines, "Q", card.q, d);
      if (card.hqRegions) {
        const regStr =
          typeof card.hqRegions === "string"
            ? card.hqRegions
            : JSON.stringify(card.hqRegions);
        pushDelimitedField(lines, "R", regStr, d);
      }
      if (card.interactionMode) {
        pushDelimitedField(lines, "M", card.interactionMode, d);
      }
      break;
    }
    case "combo": {
      const mode = card.comboMode === "zip" ? "zip" : "product";
      const sep = mode === "zip" ? COMBO_ZIP_SEPARATOR : COMBO_VARIANT_SEPARATOR;
      const qText =
        Array.isArray(card.qVariants) && card.qVariants.length > 0
          ? card.qVariants.join(sep)
          : (card.q ?? "");
      const aText =
        Array.isArray(card.aVariants) && card.aVariants.length > 0
          ? card.aVariants.join(sep)
          : (card.a ?? "");
      pushDelimitedField(lines, "Q", qText, d);
      pushDelimitedField(lines, "A", aText, d);
      break;
    }
  }

  // Info
  if (options?.includeInfo !== false && card.info) {
    pushDelimitedField(lines, "I", card.info, d);
  }

  // Groups
  if (options?.includeGroups !== false && Array.isArray(card.groups) && card.groups.length > 0) {
    const groups = normalizeGroups(card.groups);
    if (groups.length > 0) {
      pushDelimitedField(lines, "G", groups.join(", "), d);
    }
  }

  return lines.join("\n");
}
