/**
 * Card Text Parser
 *
 * Line-based streaming parser that extracts LearnKit flashcards from Markdown text.
 * Handles code fences, LaTeX math fences ($$), header detection, and delegates
 * invariant validation and variant normalization to `CardValidator`.
 */

import {
  ANY_HEADER_DELIM_RE,
  CARD_START_DELIM_RE,
  FIELD_DELIM_RE,
  TITLE_OUTSIDE_DELIM_RE,
  BASIC_SHORTHAND_RE,
  REVERSED_SHORTHAND_RE,
  CLOZE_SHORTHAND_RE,
  SR_CLOZE_DELETION_RE,
  convertSrClozeToShorthand,
  isMarkdownHeading,
  stripClosingDelimiter,
  unescapeDelimiterText,
  escapeDelimiterRe,
} from "../../platform/core/delimiter";
import { CARD_ANCHOR_LINE_RE } from "../../platform/core/identity";
import { collectMathRanges } from "../../platform/core/shared-utils";
import {
  ParsedCard,
  CardType,
  createEmptyParsedCard,
  validateAndNormalizeCard,
} from "./card-validator";

const ANCHOR_RE = CARD_ANCHOR_LINE_RE;

export type ParseCardsFromTextOptions = {
  /**
   * Controls whether shorthand syntax (`::`, `:::`, `cloze::`) is parsed.
   * - "all": parse all shorthand cards (default, legacy behavior)
   * - "anchored-only": parse shorthand only when immediately preceded by a card anchor
   * - "off": never parse shorthand cards
   */
  shorthandMode?: "all" | "anchored-only" | "off";
};

type CurrentFieldKey =
  | "title"
  | "q"
  | "a"
  | "stem"
  | "mcqMarkedRaw"
  | "mcqLegacyOptionsRaw"
  | "groupsRaw"
  | "clozeText"
  | "prompt"
  | "ioSrc"
  | "ioOcclusionsRaw"
  | "hqSrc"
  | "hqRegionsRaw"
  | "interactionMode"
  | "info"
  | "audioRef";

/**
 * Marks lines that are inside fenced code blocks (` ``` ` or ` ~~~ `).
 */
export function computeFenceMask(lines: string[]): boolean[] {
  const inside: boolean[] = new Array<boolean>(lines.length).fill(false);
  let inFence = false;
  let token: "```" | "~~~" | null = null;

  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trimStart();
    const isBack = t.startsWith("```");
    const isTilde = t.startsWith("~~~");

    if (!inFence && (isBack || isTilde)) {
      inFence = true;
      token = isBack ? "```" : "~~~";
      inside[i] = true;
      continue;
    }

    if (inFence) {
      inside[i] = true;
      if (token && t.startsWith(token)) {
        inFence = false;
        token = null;
      }
    }
  }

  return inside;
}

/**
 * Marks lines that are strictly inside a multi-line `$$...$$` display-math
 * block. The write-side (`pushDelimitedField`) emits `$$` on its own line
 * when the closing delimiter would otherwise be ambiguous, so content lines
 * between the opening and closing `$$` must not have their trailing `|`
 * interpreted as a field terminator (e.g. `\left| … \right|`).
 */
export function computeMathFenceMask(lines: string[]): boolean[] {
  const mask = new Array<boolean>(lines.length).fill(false);
  if (!lines.length) return mask;

  const joined = lines.join("\n");
  const ranges = collectMathRanges(joined);
  if (!ranges.length) return mask;

  // Map each line to its character offsets within the joined text.
  const lineOffsets: Array<[number, number]> = [];
  let offset = 0;
  for (const line of lines) {
    lineOffsets.push([offset, offset + line.length]);
    offset += line.length + 1; // +1 for the joining newline
  }

  for (let i = 0; i < lines.length; i += 1) {
    const [ls, le] = lineOffsets[i];
    for (const [ms, me] of ranges) {
      const block = joined.slice(ms, me);
      // Only display math that spans multiple lines needs fence protection;
      // single-line math is handled by delimiter escaping/unescaping.
      if (!block.startsWith("$$") || !block.endsWith("$$") || !block.includes("\n")) {
        continue;
      }
      // Strictly inside the fence (exclude the `$$` delimiter lines).
      if (ls > ms && le < me) {
        mask[i] = true;
        break;
      }
    }
  }

  return mask;
}

export function canParseShorthand(
  shorthandMode: ParseCardsFromTextOptions["shorthandMode"],
  pendingId: string | null,
): boolean {
  if (shorthandMode === "off") return false;
  if (shorthandMode === "anchored-only") return !!pendingId;
  return true;
}

/**
 * Auto-number bare `{{text}}` tokens into `{{c1::text}}`, `{{c2::text}}`, etc.
 * Already-numbered `{{cN::text}}` tokens are left untouched.
 *
 * Starts numbering from the highest existing cN + 1 so that inserting
 * new bare tokens after already-numbered ones doesn't create duplicates.
 */
export function autoNumberClozeTokens(text: string): string {
  // Find highest existing cN number
  let maxExisting = 0;
  const existingRe = /\{\{c(\d+)::/g;
  let em: RegExpExecArray | null;
  while ((em = existingRe.exec(text)) !== null) {
    maxExisting = Math.max(maxExisting, Number(em[1]));
  }
  let counter = maxExisting;
  // Replace bare {{text}} (not already {{cN::text}}) with {{cN::text}}
  return text.replace(/\{\{(?!c\d+::)([\s\S]*?)\}\}/g, (_match, content) => {
    counter += 1;
    return `{{c${counter}::${content}}}`;
  });
}

function makeEmptyCard(
  notePath: string,
  startLine: number,
  pendingId: string | null,
  pendingTitle: string | null,
  kind: "Q" | "RQ" | "MCQ" | "CQ" | "IO" | "HQ" | "OQ" | "QX",
): ParsedCard {
  const type: CardType =
    kind === "Q" || kind === "QX"
      ? "basic"
      : kind === "RQ"
        ? "reversed"
        : kind === "MCQ"
          ? "mcq"
          : kind === "CQ"
            ? "cloze"
            : kind === "IO"
              ? "io"
              : kind === "HQ"
                ? "hq"
                : "oq";

  const card = createEmptyParsedCard(notePath, startLine, type);
  card.id = pendingId || null;
  card.title = pendingTitle || null;
  return card;
}

/**
 * Parses flashcards from note markdown text.
 */
export function parseCardsFromText(
  notePath: string,
  text: string,
  ignoreFences = true,
  options?: ParseCardsFromTextOptions,
): { cards: ParsedCard[] } {
  let lines = text.split(/\r?\n/);
  const fenceMask = ignoreFences ? computeFenceMask(lines) : new Array<boolean>(lines.length).fill(false);
  const mathFenceMask = computeMathFenceMask(lines);
  const shorthandMode = options?.shorthandMode ?? "all";

  // ── Pre-process: SR cloze deletions → LearnKit shorthand ───────────
  // Convert ==text==^[hint][^N] to cloze::{{cN::text::hint}} shorthand
  // so the sync engine expands it to CQ | ... | format.
  lines = lines.map((ln, idx) => {
    if (fenceMask[idx]) return ln;
    // Never parse markdown headings as cards
    if (isMarkdownHeading(ln)) return ln;
    // Don't convert lines that are already LearnKit cards
    if (ANY_HEADER_DELIM_RE().test(ln)) return ln;
    if (BASIC_SHORTHAND_RE.test(ln)) return ln;
    if (REVERSED_SHORTHAND_RE.test(ln)) return ln;
    if (CLOZE_SHORTHAND_RE.test(ln)) return ln;
    // Check for SR cloze pattern (only if the line is prose, not a header)
    SR_CLOZE_DELETION_RE.lastIndex = 0;
    if (SR_CLOZE_DELETION_RE.test(ln)) {
      return convertSrClozeToShorthand(ln) ?? ln;
    }
    return ln;
  });

  const cards: ParsedCard[] = [];

  let pendingId: string | null = null;
  let pendingIdLine: number | null = null;

  let pendingTitle: string | null = null;
  let pendingTitleFieldOpen = false;
  let pendingTitlePipeOpen = false;

  let current: ParsedCard | null = null;

  let currentField: CurrentFieldKey | null = null;
  let pipeField: CurrentFieldKey | "mcqOption" | "oqStepField" | "maskMode" | null = null;

  const flush = () => {
    if (!current) return;

    if (!current.title && pendingTitle) {
      current.title = pendingTitle;
      pendingTitle = null;
    }

    if (!current.id && pendingId) {
      current.id = pendingId;
      pendingId = null;
      pendingIdLine = null;
    }

    validateAndNormalizeCard(current);

    cards.push(current);
    current = null;
    currentField = null;
    pipeField = null;
  };

  const appendToField = (card: ParsedCard, key: CurrentFieldKey, chunk: string) => {
    if (key === "interactionMode") {
      const trimmed = chunk.trim().toLowerCase();
      card.interactionMode = trimmed === "drag-drop" ? "drag-drop" : trimmed === "click" ? "click" : null;
      return;
    }
    const prev = card[key];
    (card as any)[key] = (typeof prev === "string" && prev ? prev + "\n" : "") + chunk;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Fence skipping only applies outside of cards. Once a card has
    // started (current !== null), code fences inside fields are part
    // of the card content and must not be skipped.
    if (ignoreFences && fenceMask[i] && !current) continue;

    // 0) Anchor line
    const am = line.trim().match(ANCHOR_RE);
    if (am) {
      const id = am[1];

      if (current) {
        if (!current.id) {
          current.id = id;
        } else if (current.id !== id) {
          // Different anchor while inside a card — this anchor
          // belongs to the next card. Flush the current one first.
          flush();
          pendingId = id;
          pendingIdLine = i;
        }
      } else {
        pendingId = id;
        pendingIdLine = i;
      }
      continue;
    }

    // 2) Inside pipe field
    if (current && pipeField) {
      // A bare `|` inside multi-line $$...$$ display math (e.g. `\left| …
      // \right|`) is LaTeX, not a field terminator.
      const closing = mathFenceMask[i]
        ? { text: line, closed: false }
        : stripClosingDelimiter(line);
      const { text: rawText, closed } = closing;
      const chunk = unescapeDelimiterText(rawText);

      // Special handling for MCQ option continuation
      if (pipeField === "mcqOption") {
        if (current.options && current.options.length > 0) {
          const lastOption = current.options[current.options.length - 1];
          lastOption.text = (lastOption.text ? lastOption.text + "\n" : "") + chunk;
        }
      } else if (pipeField === "oqStepField") {
        // Continuation of a numbered OQ step
        const idx = (current as Record<string, unknown>)._oqCurrentStepIdx;
        if (current.oqSteps && typeof idx === "number" && idx >= 0 && idx < current.oqSteps.length) {
          current.oqSteps[idx] = (current.oqSteps[idx] ? current.oqSteps[idx] + "\n" : "") + chunk;
        }
      } else if (pipeField === "maskMode") {
        const v = String(chunk ?? "").trim();
        if (!v) {
          current.maskMode = null;
        } else if (v === "solo" || v === "all") {
          current.maskMode = v;
        } else {
          current.errors.push('IO mask mode must be "solo" or "all".');
        }
      } else {
        appendToField(current, pipeField, chunk);
      }

      if (closed) {
        pipeField = null;
        currentField = null;
      }
      continue;
    }

    // 3) Pending pipe title (outside card)
    if (!current && pendingTitlePipeOpen) {
      const { text: rawText, closed } = stripClosingDelimiter(line);
      const chunk = unescapeDelimiterText(rawText);
      pendingTitle = (pendingTitle ? pendingTitle + "\n" : "") + chunk;

      if (closed) pendingTitlePipeOpen = false;
      continue;
    }

    // 4) Blank line — only flush (end card) when outside a card.
    // Blank lines inside a card (e.g. between a closing | and the
    // next field header) are just spacing and must not end the card.
    if (line.trim().length === 0) {
      if (!current) {
        flush();
        pendingId = null;
        pendingIdLine = null;
        pendingTitle = null;
        pendingTitleFieldOpen = false;
        pendingTitlePipeOpen = false;
      }
      continue;
    }

    // 5) Pending title outside card (pipe)
    if (!current) {
      const tpipe = line.match(TITLE_OUTSIDE_DELIM_RE());
      if (tpipe) {
        const { text: rawText, closed } = stripClosingDelimiter(tpipe[1] || "");
        const chunk = unescapeDelimiterText(rawText);
        pendingTitle = (pendingTitle ? pendingTitle + "\n" : "") + chunk.trimEnd();
        pendingTitleFieldOpen = false;
        pendingTitlePipeOpen = !closed;
        continue;
      }
    }

    // 6) Legacy multiline pending title continuation
    if (!current && pendingTitleFieldOpen && !ANY_HEADER_DELIM_RE().test(line)) {
      pendingTitle = (pendingTitle || "") + "\n" + line;
      continue;
    }

    // --- IO prompt field inside IO card: "Q | ... |" must NOT start a new card ---
    if (current && (current.type === "io" || current.type === "hq")) {
      const qm = new RegExp(`^Q\\s*${escapeDelimiterRe()}\\s*(.*)$`).exec(line);
      if (qm) {
        const restRaw = qm[1] ?? "";
        const { text: rawText, closed } = stripClosingDelimiter(restRaw);
        const chunk = unescapeDelimiterText(rawText);

        current.prompt = current.prompt ?? null;
        appendToField(current, "prompt", chunk);
        if (!closed) pipeField = "prompt";

        currentField = null;
        continue;
      }
    }

    // 8) Card start (pipe)
    const sp = line.match(CARD_START_DELIM_RE());
    if (sp) {
      flush();

      const kind = sp[1] as "Q" | "RQ" | "MCQ" | "CQ" | "IO" | "HQ" | "OQ" | "QX";
      const startLine = pendingIdLine !== null ? pendingIdLine : i;

      current = makeEmptyCard(notePath, startLine, pendingId, pendingTitle, kind);

      pendingId = null;
      pendingIdLine = null;
      pendingTitle = null;
      pendingTitleFieldOpen = false;
      pendingTitlePipeOpen = false;

      const restRaw = sp[2] ?? "";
      const { text: rawText, closed } = stripClosingDelimiter(restRaw);
      const first = unescapeDelimiterText(rawText);

      if (kind === "Q" || kind === "RQ") current.q = "";
      if (kind === "MCQ") current.stem = "";
      if (kind === "CQ") current.clozeText = "";
      if (kind === "IO") current.ioSrc = "";
      if (kind === "HQ") current.hqSrc = "";
      if (kind === "OQ") {
        current.q = "";
        current.oqSteps = [];
      }
      if (kind === "QX") {
        current.q = "";
      }

      const key: CurrentFieldKey =
        kind === "Q" || kind === "RQ" || kind === "OQ"
          ? "q"
          : kind === "MCQ"
            ? "stem"
            : kind === "CQ"
              ? "clozeText"
              : kind === "IO"
                ? "ioSrc"
                : kind === "HQ"
                  ? "hqSrc"
                  : "q"; // QX uses "q" field for question variants

      appendToField(current, key, first);

      if (!closed) pipeField = key;

      currentField = null;
      continue;
    }

    // 9) Field inside card (pipe)
    const fp = current ? line.match(FIELD_DELIM_RE()) : null;
    if (fp && current) {
      const key = fp[1];
      const restRaw = fp[2] ?? "";
      const { text: rawText, closed } = stripClosingDelimiter(restRaw);
      const chunk = unescapeDelimiterText(rawText);

      // OQ numbered step fields (1 | ... |, 2 | ... |, etc.)
      if (current.type === "oq" && /^\d{1,2}$/.test(key)) {
        const stepNum = Number(key);
        if (stepNum >= 1 && stepNum <= 20) {
          if (!current.oqSteps) current.oqSteps = [];
          // Ensure the step array is large enough (steps may arrive out of order)
          while (current.oqSteps.length < stepNum) current.oqSteps.push("");
          // Accumulate content for this step (pipe field may be multi-line)
          current._oqCurrentStepIdx = stepNum - 1;
          current.oqSteps[stepNum - 1] = chunk;
          pipeField = closed ? null : "oqStepField";
          currentField = null;
          continue;
        }
      }

      // IO-specific fields first (so they don't get misinterpreted as MCQ)
      if (current.type === "io") {
        if (key === "O") {
          current.ioOcclusionsRaw = current.ioOcclusionsRaw ?? null;
          appendToField(current, "ioOcclusionsRaw", chunk);
          pipeField = closed ? null : "ioOcclusionsRaw";
          currentField = null;
          continue;
        }

        if (key === "C") {
          const v = String(chunk ?? "").trim();
          if (!v) {
            current.maskMode = null;
          } else if (v === "solo" || v === "all") {
            current.maskMode = v;
          } else {
            current.errors.push('IO mask mode must be "solo" or "all".');
          }
          // C | is always a single keyword (solo/all), but if left open consume remaining lines
          pipeField = closed ? null : "maskMode";
          currentField = null;
          continue;
        }

        if (key === "T") {
          current.title = null;
          appendToField(current, "title", chunk);
          pipeField = closed ? null : "title";
          currentField = null;
          continue;
        }

        if (key === "G") {
          current.groupsRaw = current.groupsRaw ?? null;
          appendToField(current, "groupsRaw", chunk);
          pipeField = closed ? null : "groupsRaw";
          currentField = null;
          continue;
        }

        if (key === "I") {
          current.info = null;
          appendToField(current, "info", chunk);
          pipeField = closed ? null : "info";
          currentField = null;
          continue;
        }

        // "Q |" inside IO is handled earlier (special-case), so anything else is invalid
        current.errors.push(`Unrecognised field in IO card: "${key} |" (allowed: T, Q, O, C, I, G)`);
        pipeField = null;
        currentField = null;
        continue;
      }

      if (current.type === "hq") {
        if (key === "O") {
          current.hqRegionsRaw = current.hqRegionsRaw ?? null;
          appendToField(current, "hqRegionsRaw", chunk);
          pipeField = closed ? null : "hqRegionsRaw";
          currentField = null;
          continue;
        }

        if (key === "M") {
          const v = String(chunk ?? "").trim();
          if (!v) {
            current.interactionMode = null;
          } else if (v === "click" || v === "drag-drop") {
            current.interactionMode = v;
          } else {
            current.errors.push('HQ interaction mode must be "click" or "drag-drop".');
          }
          pipeField = closed ? null : "interactionMode";
          currentField = null;
          continue;
        }

        if (key === "T") {
          current.title = null;
          appendToField(current, "title", chunk);
          pipeField = closed ? null : "title";
          currentField = null;
          continue;
        }

        if (key === "G") {
          current.groupsRaw = current.groupsRaw ?? null;
          appendToField(current, "groupsRaw", chunk);
          pipeField = closed ? null : "groupsRaw";
          currentField = null;
          continue;
        }

        if (key === "I") {
          current.info = null;
          appendToField(current, "info", chunk);
          pipeField = closed ? null : "info";
          currentField = null;
          continue;
        }

        current.errors.push(`Unrecognised field in HQ card: "${key} |" (allowed: T, Q, O, M, I, G)`);
        pipeField = null;
        currentField = null;
        continue;
      }

      // MCQ options (pipe): O => wrong, A => correct (new format)
      if (current.type === "mcq" && key === "O") {
        if (!current.options) current.options = [];
        // Create new wrong option
        current.options.push({ text: chunk, isCorrect: false });
        // If not closed, track that we're building this option
        pipeField = closed ? null : "mcqOption";
        currentField = null;
        continue;
      }
      if (current.type === "mcq" && key === "A") {
        // Multi-answer MCQ: each A | line becomes a correct option
        if (!current.options) current.options = [];
        current.options.push({ text: chunk, isCorrect: true });
        // If not closed, track that we're building this option (reuse mcqOption)
        pipeField = closed ? null : "mcqOption";
        currentField = null;
        continue;
      }

      if (key === "G") {
        current.groupsRaw = current.groupsRaw ?? null;
        appendToField(current, "groupsRaw", chunk);
        pipeField = closed ? null : "groupsRaw";
        currentField = null;
        continue;
      }

      if (key === "T") {
        current.title = null;
        appendToField(current, "title", chunk);
        pipeField = closed ? null : "title";
        currentField = null;
        continue;
      }

      if (key === "I") {
        // Always treat I | ... | as info, never as answer
        current.info = null;
        appendToField(current, "info", chunk);
        pipeField = closed ? null : "info";
        currentField = null;
        continue;
      }

      if (key === "A") {
        if (current.type !== "mcq") {
          current.a = null;
          appendToField(current, "a", chunk);
          pipeField = closed ? null : "a";
          currentField = null;
          continue;
        }
      }

      // Legacy AX field — mapped to answer (same as A)
      if (key === "AX") {
        current.a = null;
        appendToField(current, "a", chunk);
        pipeField = closed ? null : "a";
        currentField = null;
        continue;
      }

      // AU field — audio file attachment
      if (key === "AU") {
        current.audioRef = null;
        appendToField(current, "audioRef", chunk);
        pipeField = closed ? null : "audioRef";
        currentField = null;
        continue;
      }

      current.errors.push(`Unrecognised field in card: "${key} |"`);
      pipeField = null;
      currentField = null;
      continue;
    }

    // 10) Legacy continuation lines
    if (current && currentField && !ANY_HEADER_DELIM_RE().test(line)) {
      const prev = current[currentField];
      (current as Record<string, unknown>)[currentField] = (prev ? String(prev) + "\n" : "") + line;
      continue;
    }

    // 11a) Shorthand cloze card: cloze::text with {{hidden}}  /  cq::...  /  CQ::...
    if (!isMarkdownHeading(line) && canParseShorthand(shorthandMode, pendingId)) {
      const cm = line.match(CLOZE_SHORTHAND_RE);
      if (cm) {
        const body = cm[1].trim();
        if (body) {
          flush();
          const startLine = pendingIdLine !== null ? pendingIdLine : i;
          current = makeEmptyCard(notePath, startLine, pendingId, pendingTitle, "CQ");
          current.clozeText = autoNumberClozeTokens(body);
          current.isShorthand = true;
          current.sourceEndLine = i;
          pendingId = null;
          pendingIdLine = null;
          pendingTitle = null;
          pendingTitleFieldOpen = false;
          pendingTitlePipeOpen = false;
          flush();
          continue;
        }
      }
    }

    // 11b) Shorthand basic card: Question::Answer
    if (!isMarkdownHeading(line) && canParseShorthand(shorthandMode, pendingId)) {
      const sm = line.match(BASIC_SHORTHAND_RE);
      if (sm) {
        const qText = sm[1].trim();
        const aText = sm[2].trim();
        if (qText && aText) {
          flush();
          const startLine = pendingIdLine !== null ? pendingIdLine : i;
          current = makeEmptyCard(notePath, startLine, pendingId, pendingTitle, "Q");
          current.q = qText;
          current.a = aText;
          current.isShorthand = true;
          current.sourceEndLine = i;
          pendingId = null;
          pendingIdLine = null;
          pendingTitle = null;
          pendingTitleFieldOpen = false;
          pendingTitlePipeOpen = false;
          flush();
          continue;
        }
      }
    }

    // 11c) Shorthand reversed (bidirectional) card: Question:::Answer
    if (!isMarkdownHeading(line) && canParseShorthand(shorthandMode, pendingId)) {
      const rm = line.match(REVERSED_SHORTHAND_RE);
      if (rm) {
        const qText = rm[1].trim();
        const aText = rm[2].trim();
        if (qText && aText) {
          flush();
          const startLine = pendingIdLine !== null ? pendingIdLine : i;
          current = makeEmptyCard(notePath, startLine, pendingId, pendingTitle, "RQ");
          current.q = qText;
          current.a = aText;
          current.isShorthand = true;
          current.sourceEndLine = i;
          pendingId = null;
          pendingIdLine = null;
          pendingTitle = null;
          pendingTitleFieldOpen = false;
          pendingTitlePipeOpen = false;
          flush();
          continue;
        }
      }
    }

    // 14) Prose encountered while inside a card but not consuming a field => flush
    if (current && !pipeField && !currentField && !ANY_HEADER_DELIM_RE().test(line)) {
      flush();
      pendingId = null;
      pendingIdLine = null;
      pendingTitle = null;
      pendingTitleFieldOpen = false;
      pendingTitlePipeOpen = false;
      continue;
    }

    // 15) Otherwise, if still inside card, record as unrecognised.
    if (current) {
      current.errors.push(`Unrecognised line inside card: "${line.trim().slice(0, 60)}"`);
    }
  }

  flush();
  return { cards };
}
