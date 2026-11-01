import { collectMathRanges } from "./shared-utils";
import { LEGACY_CARD_ANCHOR_PREFIXES, PRIMARY_CARD_ANCHOR_PREFIX } from "./identity";

/**
 * @file src/core/delimiter.ts
 * @summary Centralised delimiter utilities for LearnKit's pipe-delimited card format.
 * Every file that reads or writes card fields should import helpers from here
 * instead of hard-coding the `|` character.
 *
 * The active delimiter is configured via `indexing.delimiter` in LearnKitSettings.
 * Presets: `|` (default), `@`, `~`, `;`. Custom single non-alphanumeric
 * Unicode characters (e.g. `⚵`) are also supported.
 *
 * **Warning:** changing the delimiter does NOT migrate existing cards.
 * Cards written with the previous delimiter will no longer parse, and their
 * scheduling data will be lost on the next sync.
 *
 * @exports
 *   - DelimiterChar              — type alias for delimiter strings
 *   - DELIMITER_OPTIONS          — preset delimiter values used by settings UIs
 *   - DELIMITER_OPTION_TOKENS    — i18n token keys for delimiter option labels
 *   - isValidDelimiterChar       — validates a single non-alphanumeric, non-whitespace char
 *   - getDelimiter               — returns the currently active delimiter character
 *   - setDelimiter               — sets the active delimiter (called from settings load)
 *   - escapeDelimiterRe          — regex-safe escaped version of the active delimiter
 *   - escapeDelimiterText        — escapes `\` and the delimiter in field content
 *   - unescapeDelimiterText      — reverses escapeDelimiterText
 *   - stripClosingDelimiter      — detects & strips an unescaped trailing delimiter
 *   - splitAtDelimiterTerminator — splits a line at the trailing delimiter (reading-view variant)
 *   - splitUnescapedDelimiters   — character-by-character split on unescaped delimiters
 *   - CARD_START_DELIM_RE        — dynamic regex: card-start line
 *   - FIELD_DELIM_RE             — dynamic regex: field line
 *   - TITLE_OUTSIDE_DELIM_RE     — dynamic regex: title outside card
 *   - ANY_HEADER_DELIM_RE        — dynamic regex: any header/field/anchor
 *   - FIELD_START_READING_RE     — dynamic regex: reading-view field-start
 *   - CARD_START_SETTINGS_RE     — dynamic regex: settings-utils card detection
 *   - FIELD_LINE_SETTINGS_RE     — dynamic regex: settings-utils field detection
 *   - FLASHCARD_HEADER_CARD_RE   — dynamic regex: sync-engine card header
 *   - FLASHCARD_HEADER_FIELD_RE  — dynamic regex: sync-engine field header
 */

// ── Types ────────────────────────────────────────────────────────────

/** Type alias for delimiter strings. Any non-alphanumeric, non-whitespace single character is valid. */
export type DelimiterChar = string;

/**
 * Validates that a character is a valid delimiter:
 * - exactly one character (not empty, not multi-char)
 * - not whitespace
 * - not alphanumeric (A-Z, a-z, 0-9)
 *
 * This prevents collision with field prefix letters (Q, A, T, CQ, etc.)
 * and ensures the delimiter is visually distinct from prose text.
 */
export function isValidDelimiterChar(c: string): boolean {
  return /^[^\s\w]$/u.test(String(c ?? ""));
}

/** Supported preset delimiter values for settings dropdowns. */
export const DELIMITER_OPTIONS: DelimiterChar[] = ["|", "@", "~", ";"];

/**
 * i18n token keys used to label each preset delimiter option in settings UIs.
 * The `"custom"` key is used when the active delimiter is not one of the presets.
 */
export const DELIMITER_OPTION_TOKENS: Record<string, string> = {
  "|": "ui.settings.sync.delimiterOptions.pipe",
  "@": "ui.settings.sync.delimiterOptions.atSign",
  "~": "ui.settings.sync.delimiterOptions.tilde",
  ";": "ui.settings.sync.delimiterOptions.semicolon",
  custom: "ui.settings.sync.delimiterOptions.custom",
};

// ── Active delimiter state ───────────────────────────────────────────

let _delim: DelimiterChar = "|";

/** Returns the currently active delimiter character. */
export function getDelimiter(): DelimiterChar {
  return _delim;
}

/**
 * Sets the active delimiter. Called once during plugin load (from settings)
 * and again if the user changes the setting.
 *
 * Accepts any valid non-alphanumeric, non-whitespace single character.
 * Falls back to `"|"` if the value is invalid.
 */
export function setDelimiter(d: DelimiterChar) {
  if (!isValidDelimiterChar(d)) d = "|";
  _delim = d;
  // Rebuild all cached regexes
  _rebuildRegexes();
}

// ── Regex-safe escape ────────────────────────────────────────────────

/** Returns the delimiter escaped for use inside a RegExp character class or literal. */
export function escapeDelimiterRe(d: string = _delim): string {
  return d.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ── Text escape / unescape ──────────────────────────────────────────

/**
 * Escapes backslashes and the active delimiter in field content so the
 * text can safely appear inside a delimited field.
 *
 * By default this keeps legacy behaviour (`\\` -> `\\\\`) because
 * some callsites expect fully escaped output.
 *
 * For note-writing field serializers, pass `{ escapeBackslashes: false }`
 * to preserve authored backslashes (for example LaTeX like `\begin`).
 *
 * `\`  →  `\\` (legacy/default mode)
 * `<delim>`  →  `\<delim>`
 */
export function escapeDelimiterText(
  s: string,
  opts?: { escapeBackslashes?: boolean; delimiter?: string },
): string {
  const d = opts?.delimiter ?? _delim;
  const escapeBackslashes = opts?.escapeBackslashes !== false;
  let out = String(s ?? "");
  if (escapeBackslashes) out = out.replace(/\\/g, "\\\\");
  // Only escape the delimiter character itself
  // Escape the delimiter character — use a dynamic regex so any Unicode
  // delimiter (including custom chars like ⚵) is handled correctly.
  out = out.replace(new RegExp(escapeDelimiterRe(d), "g"), `\\${d}`);
  return out;
}

/**
 * Reverses escapeDelimiterText:
 * `\\`  →  `\`
 * `\<delim>`  →  `<delim>`
 */
function shouldCollapseEscapedBackslashes(text: string, delim: DelimiterChar): boolean {
  // Legacy writer mode escaped every backslash, so non-delimiter runs were always even.
  // Raw markdown authored directly by users can contain odd runs (for example
  // TeX commands like \begin), which must be preserved.
  let hasLegacySignal = false;
  let hasRawSignal = false;

  for (let i = 0; i < text.length;) {
    if (text[i] !== "\\") {
      i += 1;
      continue;
    }

    let j = i;
    while (j < text.length && text[j] === "\\") j += 1;

    const slashCount = j - i;
    const nextChar = text[j] ?? "";

    // Runs before delimiter are handled by delimiter unescaping semantics.
    // Ignore them for mode detection.
    if (nextChar !== delim) {
      if (slashCount % 2 === 1) {
        hasRawSignal = true;
      }

      // Legacy escaped text tends to include doubled command prefixes
      // (e.g. \\begin) and/or quadrupled linebreaks (e.g. \\\\ + newline).
      if (
        slashCount >= 4
        || (slashCount === 2 && /[A-Za-z]/.test(nextChar))
      ) {
        hasLegacySignal = true;
      }
    }

    i = j;
  }

  return hasLegacySignal && !hasRawSignal;
}

export function unescapeDelimiterText(s: string): string {
  const d = _delim;
  const text = String(s ?? "");
  const collapseEscapedBackslashes = shouldCollapseEscapedBackslashes(text, d);
  const mathRanges = collectMathRanges(text);
  let out = "";

  for (let i = 0; i < text.length;) {
    const mathRange = mathRanges.find(([start, end]) => i >= start && i < end);
    if (mathRange) {
      // Preserve LaTeX (norm bars, backslash commands) verbatim inside math.
      out += text.slice(i, mathRange[1]);
      i = mathRange[1];
      continue;
    }

    if (text[i] !== "\\") {
      out += text[i];
      i += 1;
      continue;
    }

    let j = i;
    while (j < text.length && text[j] === "\\") j += 1;

    const slashCount = j - i;
    const nextChar = text[j] ?? "";

    if (nextChar === d) {
      // Delimiter escape semantics: pairs of backslashes are literal,
      // the remaining odd slash escapes the delimiter.
      out += "\\".repeat(Math.floor(slashCount / 2));
      out += d;
      i = j + 1;
      continue;
    }

    if (collapseEscapedBackslashes) {
      // Legacy mode: collapse doubled backslashes back to their authored form.
      out += "\\".repeat(Math.ceil(slashCount / 2));
    } else {
      // Raw mode: preserve non-delimiter backslashes exactly as written.
      out += "\\".repeat(slashCount);
    }

    i = j;
  }

  return out;
}

// ── Closing-delimiter detection ─────────────────────────────────────

/**
 * For delimited fields (KEY <d> ... <d>):
 * Field ends when a line ends with an unescaped delimiter (ignoring trailing whitespace).
 * Returns the text without the closing delimiter, and whether the field closed.
 */
export function stripClosingDelimiter(line: string): { text: string; closed: boolean } {
  const d = _delim;
  const trimmedRight = line.replace(/[ \t]+$/g, "");
  if (!trimmedRight.endsWith(d)) return { text: line, closed: false };

  // Count consecutive backslashes before the final delimiter
  let bs = 0;
  for (let i = trimmedRight.length - 1 - d.length; i >= 0 && trimmedRight[i] === "\\"; i--) bs++;

  // Odd number of backslashes means the delimiter is escaped
  if (bs % 2 === 1) return { text: line, closed: false };

  return { text: trimmedRight.slice(0, -d.length), closed: true };
}

/**
 * Reading-view variant: splits at the trailing (unescaped) delimiter.
 * Returns the content before the delimiter and whether it was terminated.
 */
export function splitAtDelimiterTerminator(line: string): { content: string; terminated: boolean } {
  const d = _delim;
  const trimmedRight = line.replace(/[ \t]+$/g, "");
  if (!trimmedRight.endsWith(d)) return { content: line, terminated: false };

  // Count consecutive backslashes before the final delimiter
  let bs = 0;
  for (let i = trimmedRight.length - 1 - d.length; i >= 0 && trimmedRight[i] === "\\"; i--) bs++;

  // Odd number of backslashes means the delimiter is escaped
  if (bs % 2 === 1) return { content: line, terminated: false };

  return {
    content: trimmedRight.slice(0, -d.length),
    terminated: true,
  };
}

// ── Character-by-character split ────────────────────────────────────

/**
 * Splits a string on unescaped delimiter characters.
 * `\<delim>` is treated as a literal delimiter in the output.
 * `\\` is treated as a literal backslash.
 */
export function splitUnescapedDelimiters(s: string): string[] {
  const d = _delim;
  const mathRanges = collectMathRanges(s);
  const out: string[] = [];
  let cur = "";

  for (let i = 0; i < s.length; i++) {
    const mathRange = mathRanges.find(([start, end]) => i >= start && i < end);
    if (mathRange) {
      // Keep absolute-value / norm math intact (delimiter chars inside $...$
      // are LaTeX, not field separators).
      cur += s.slice(i, mathRange[1]);
      i = mathRange[1] - 1;
      continue;
    }

    const ch = s[i];

    if (ch === "\\") {
      // `\<delim>` is a literal delimiter; every other backslash is
      // preserved verbatim so raw-mode LaTeX (commands, `\\` row breaks)
      // round-trips losslessly.
      const next = s[i + 1];
      if (next === d) {
        cur += d;
        i += 1;
      } else {
        cur += ch;
      }
      continue;
    }

    if (ch === d) {
      out.push(cur);
      cur = "";
      continue;
    }

    cur += ch;
  }

  out.push(cur);
  return out;
}

// ── Dynamic regex cache ─────────────────────────────────────────────
//
// All regexes that depend on the delimiter are rebuilt when setDelimiter()
// is called. Consumers import the getter functions below.

let _CARD_START_DELIM_RE: RegExp;
let _FIELD_DELIM_RE: RegExp;
let _TITLE_OUTSIDE_DELIM_RE: RegExp;
let _ANY_HEADER_DELIM_RE: RegExp;
let _FIELD_START_READING_RE: RegExp;
let _CARD_START_SETTINGS_RE: RegExp;
let _FIELD_LINE_SETTINGS_RE: RegExp;
let _FLASHCARD_HEADER_CARD_RE: RegExp;
let _FLASHCARD_HEADER_FIELD_RE: RegExp;

const ANCHOR_PREFIX_PATTERN = `(?:${PRIMARY_CARD_ANCHOR_PREFIX}|${LEGACY_CARD_ANCHOR_PREFIXES.join("|")})`;

function _rebuildRegexes() {
  const d = escapeDelimiterRe(_delim);

  // parser.ts — card start: ^(RQ|Q|MCQ|CQ|IO|HQ|OQ|QX)\s*<d>\s*(.*)$
  _CARD_START_DELIM_RE = new RegExp(`^(RQ|Q|MCQ|CQ|IO|HQ|OQ|QX)\\s*${d}\\s*(.*)$`, "u");

  // parser.ts — field: ^(T|A|O|I|G|C|M|AX|AU|\d{1,2})\s*<d>\s*(.*)$
  _FIELD_DELIM_RE = new RegExp(`^(T|A|O|I|G|C|M|AX|AU|\\d{1,2})\\s*${d}\\s*(.*)$`, "u");

  // parser.ts — title outside card: ^T\s*<d>\s*(.*)$
  _TITLE_OUTSIDE_DELIM_RE = new RegExp(`^T\\s*${d}\\s*(.*)$`, "u");

  // parser.ts — any header/anchor: ^(?:^learnkit-\d{9}|^learnkit-\d{9}|(?:RQ|Q|MCQ|CQ|IO|HQ|OQ|QX|T|A|O|I|G|C|M|AX|AU|\d{1,2})\s*<d>)\s*
  _ANY_HEADER_DELIM_RE = new RegExp(
    `^(?:\\^${ANCHOR_PREFIX_PATTERN}-\\d{9}|(?:RQ|Q|MCQ|CQ|IO|HQ|OQ|QX|T|A|O|I|G|C|M|AX|AU|\\d{1,2})\\s*${d})\\s*`,
    "u",
  );

  // reading-helpers.ts — field start (relaxed): ^([A-Za-z]+|\d{1,2})\s*<d>\s*(.*)$
  _FIELD_START_READING_RE = new RegExp(`^([A-Za-z]+|\\d{1,2})\\s*${d}\\s*(.*)$`, "u");

  // settings-utils.ts — card start (also accepts colon for legacy):
  //   ^(RQ|Q|MCQ|CQ|OQ|QX)\s*(?::|<d>)\s*.*$|^(IO|HQ)\s*<d>\s*.*$
  _CARD_START_SETTINGS_RE = new RegExp(
    `^(RQ|Q|MCQ|CQ|OQ|QX)\\s*(?::|${d})\\s*.*$|^(IO|HQ)\\s*${d}\\s*.*$`,
    "u",
  );

  // settings-utils.ts — field line:
  //   ^(T|A|I|O|G|M|AX|AU|\d{1,2})\s*(?::|<d>)\s*.*$|^(C|K)\s*(?::|<d>)\s*.*$
  _FIELD_LINE_SETTINGS_RE = new RegExp(
    `^(T|A|I|O|G|M|AX|AU|\\d{1,2})\\s*(?::|${d})\\s*.*$|^(C|K)\\s*(?::|${d})\\s*.*$`,
    "u",
  );

  // sync-engine.ts — flashcard header (card types):
  //   ^(RQ|Q|MCQ|CQ|IO|HQ|OQ|QX)\s*(?::|<d>)\s*
  _FLASHCARD_HEADER_CARD_RE = new RegExp(`^(RQ|Q|MCQ|CQ|IO|HQ|OQ|QX)\\s*(?::|${d})\\s*`, "u");

  // sync-engine.ts — flashcard header (field types):
  //   ^(T|A|O|I|G|C|M|K|L|AX|AU|QX|\d{1,2})\s*(?::|<d>)\s*
  _FLASHCARD_HEADER_FIELD_RE = new RegExp(`^(T|A|O|I|G|C|M|K|L|AX|AU|QX|\\d{1,2})\\s*(?::|${d})\\s*`, "u");
}

// Initial build with default delimiter
_rebuildRegexes();

// ── Regex getters ────────────────────────────────────────────────────

/** Card-start regex for parser.ts: `^(RQ|Q|MCQ|CQ|IO|OQ)\s*<d>\s*(.*)$` */
export function CARD_START_DELIM_RE(): RegExp { return _CARD_START_DELIM_RE; }

/** Field regex for parser.ts: `^(T|A|O|I|G|C|\d{1,2})\s*<d>\s*(.*)$` */
export function FIELD_DELIM_RE(): RegExp { return _FIELD_DELIM_RE; }

/** Title-outside-card regex for parser.ts: `^T\s*<d>\s*(.*)$` */
export function TITLE_OUTSIDE_DELIM_RE(): RegExp { return _TITLE_OUTSIDE_DELIM_RE; }

/** Any-header regex for parser.ts */
export function ANY_HEADER_DELIM_RE(): RegExp { return _ANY_HEADER_DELIM_RE; }

/** Reading-view field-start regex: `^([A-Za-z]+|\d{1,2})\s*<d>\s*(.*)$` */
export function FIELD_START_READING_RE(): RegExp { return _FIELD_START_READING_RE; }

/** Settings-utils card-start regex (includes legacy colon) */
export function CARD_START_SETTINGS_RE(): RegExp { return _CARD_START_SETTINGS_RE; }

/** Settings-utils field-line regex (includes legacy colon) */
export function FIELD_LINE_SETTINGS_RE(): RegExp { return _FIELD_LINE_SETTINGS_RE; }

/** Sync-engine flashcard header — card types */
export function FLASHCARD_HEADER_CARD_RE(): RegExp { return _FLASHCARD_HEADER_CARD_RE; }

/** Sync-engine flashcard header — field types */
export function FLASHCARD_HEADER_FIELD_RE(): RegExp { return _FLASHCARD_HEADER_FIELD_RE; }

// ── Shorthand syntax & Spaced Repetition preprocessor ───────────────
export {
  isMarkdownHeading,
  BASIC_SHORTHAND_RE,
  REVERSED_SHORTHAND_RE,
  CLOZE_SHORTHAND_RE,
  SR_MULTILINE_BASIC_SEP_RE,
  SR_MULTILINE_REVERSED_SEP_RE,
  SR_CLOZE_DELETION_RE,
  convertSrClozeToShorthand,
  mergeSrMultilineBlocks,
  preprocessSrText,
} from "./shorthand-preprocessor";

// ── Field formatting & Card Serialization ───────────────────────────
export {
  pushDelimitedField,
  formatDelimitedField,
  COMBO_VARIANT_SEPARATOR,
  COMBO_ZIP_SEPARATOR,
  splitComboVariants,
  splitZipVariants,
  serializeCard,
} from "./card-serializer";
export type {
  CardSerializationInput,
  CardSerializationOptions,
  McqOptionInput,
} from "./card-serializer";

