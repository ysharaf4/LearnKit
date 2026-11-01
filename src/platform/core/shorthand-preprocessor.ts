/**
 * Spaced Repetition (SR) shorthand syntax and preprocessor.
 *
 * Provides regexes and pre-processing functions for single-line and multi-line
 * shorthand formats (such as Obsidian Spaced Repetition migration syntax).
 */

// ── Markdown heading detection ──────────────────────────────────────

/**
 * Tests whether a line is a Markdown ATX heading (#, ##, ###, etc.).
 * These should never be treated as card shorthand or merged into
 * multi-line SR questions.
 */
export function isMarkdownHeading(line: string): boolean {
  return /^#{1,6}\s/.test(line);
}

// ── Shorthand syntax ────────────────────────────────────────────────

/**
 * Matches a single-line shorthand basic card: `Question::Answer`.
 * Uses double-colon – matches Obsidian Spaced Repetition's single-line basic
 * separator so existing SR users transition seamlessly.
 *
 * The `(?<!:)` and `(?!:)` lookarounds ensure `::` is exactly two colons
 * (not part of `:::`), preventing collision with the reversed shorthand.
 *
 * Both question (group 1) and answer (group 2) must be non-empty.
 */
export const BASIC_SHORTHAND_RE = /^(.+?)(?<!:)::(?!:)(.+)$/;

/**
 * Matches a single-line shorthand reversed (bidirectional) card: `Question:::Answer`.
 * Uses triple-colon – matches Obsidian Spaced Repetition's single-line bidirectional
 * separator. Creates two cards with Q↔A swapping.
 *
 * Both question (group 1) and answer (group 2) must be non-empty.
 */
export const REVERSED_SHORTHAND_RE = /^(.+?):::(.+)$/;

/**
 * Matches a single-line shorthand cloze card:
 *   `cloze::text with {{hidden}}`
 *   `cq::text with {{hidden}}`
 *   `CQ::text with {{hidden}}`
 * Case-insensitive prefix (cloze|cq). Group 1 = cloze body.
 *
 * The `(?!:)` prevents matching triple-colon syntax.
 */
export const CLOZE_SHORTHAND_RE = /^(?:cloze|cq)::(?!:)(.+)$/i;

// ── Spaced Repetition migration patterns ────────────────────────────

/**
 * Matches standalone `?` or `??` separator lines from Obsidian Spaced Repetition's
 * multi-line basic / bidirectional flashcard format.
 *
 * Multi-line basic:   question text \n? \n answer text
 * Multi-line reversed: question text \n??\n answer text
 *
 * These are pre-processed into single-line `::` / `:::` shorthand before the
 * main parser loop so existing SR vaults migrate seamlessly.
 */
export const SR_MULTILINE_BASIC_SEP_RE = /^\?$/;
export const SR_MULTILINE_REVERSED_SEP_RE = /^\?\?$/;

/**
 * Matches a line that contains at least one Obsidian Spaced Repetition
 * cloze deletion (`==text==`) with optional hint (`^[hint]`) and/or
 * sequence number (`[^N]`) trailing notation.
 *
 * Lines containing these patterns are pre-processed into LearnKit's
 * `cloze::...` shorthand (with auto-numbered `{{cN::text}}` tokens)
 * before the main parser loop.
 *
 * Capture groups per match:
 *   1 = cloze text content
 *   2 = optional hint (without ^[] wrapper)
 *   3 = optional sequence number (without [^] wrapper)
 */
export const SR_CLOZE_DELETION_RE = /==(.+?)==(?:\^\[(.+?)\])?(?:\[\^(\d+)\])?/g;

/**
 * Converts raw text containing SR cloze deletions into LearnKit shorthand.
 *
 * Simplified clozes (no [^N]): sequential numbering c1, c2, c3...
 * Classic clozes (with [^N]): deletions sharing the same [^N] get the same cN.
 *
 * Returns null if no cloze deletions are found in the line.
 */
export function convertSrClozeToShorthand(line: string): string | null {
  const pattern = SR_CLOZE_DELETION_RE;
  pattern.lastIndex = 0;

  // Collect all matches first
  const matches: Array<{ start: number; end: number; text: string; hint?: string; group?: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(line)) !== null) {
    matches.push({
      start: m.index,
      end: m.index + m[0].length,
      text: m[1],
      hint: m[2] || undefined,
      group: m[3] !== undefined ? Number(m[3]) : undefined,
    });
  }

  if (matches.length === 0) return null;

  // Assign c numbers – same group → same number
  const groupMap = new Map<number, number>();
  let nextNum = 1;

  let result = "";
  let lastEnd = 0;
  for (const match of matches) {
    result += line.slice(lastEnd, match.start);

    let cNum: number;
    if (match.group !== undefined) {
      if (!groupMap.has(match.group)) {
        groupMap.set(match.group, nextNum++);
      }
      cNum = groupMap.get(match.group)!;
    } else {
      cNum = nextNum++;
    }

    if (match.hint) {
      result += `{{c${cNum}::${match.text}::${match.hint}}}`;
    } else {
      result += `{{c${cNum}::${match.text}}}`;
    }

    lastEnd = match.end;
  }
  result += line.slice(lastEnd);

  return `cloze::${result}`;
}

/**
 * Pre-processes an array of lines, merging Obsidian Spaced Repetition
 * multi-line basic / bidirectional blocks into single-line `::` / `:::`
 * shorthand lines.
 *
 * Standalone `?`  → basic (`::` join)
 * Standalone `??` → reversed (`:::` join)
 *
 * Returns a new lines array with merged shorthand lines replacing the
 * original multi-line blocks.
 */
export function mergeSrMultilineBlocks(
  lines: string[],
  fenceMask: boolean[],
  isHeaderLine: (line: string) => boolean,
): string[] {
  const result: string[] = [];

  let i = 0;
  while (i < lines.length) {
    const trimmed = lines[i].trim();

    // Check for standalone ? or ?? (not in code fence, not already a card line)
    if (
      !fenceMask[i] &&
      (SR_MULTILINE_BASIC_SEP_RE.test(trimmed) || SR_MULTILINE_REVERSED_SEP_RE.test(trimmed)) &&
      !isHeaderLine(lines[i])
    ) {
      const isReversed = SR_MULTILINE_REVERSED_SEP_RE.test(trimmed);

      // Collect preceding non-blank, non-header lines as question
      let qStart = i - 1;
      while (
        qStart >= 0 &&
        !fenceMask[qStart] &&
        lines[qStart].trim() !== "" &&
        !isHeaderLine(lines[qStart])
      ) {
        qStart--;
      }
      qStart++;

      // Collect following non-blank, non-header lines as answer
      let aEnd = i + 1;
      while (
        aEnd < lines.length &&
        !fenceMask[aEnd] &&
        lines[aEnd].trim() !== "" &&
        !isHeaderLine(lines[aEnd])
      ) {
        aEnd++;
      }

      const qLines = lines.slice(qStart, i).map((l) => l.trim()).filter(Boolean);
      const aLines = lines.slice(i + 1, aEnd).map((l) => l.trim()).filter(Boolean);

      if (qLines.length > 0 && aLines.length > 0) {
        // Remove previously added question lines from result
        result.length = Math.max(0, result.length - (i - qStart));

        const sep = isReversed ? ":::" : "::";
        result.push(`${qLines.join(" ")}${sep}${aLines.join(" ")}`);
        i = aEnd;
        continue;
      }
    }

    result.push(lines[i]);
    i++;
  }

  return result;
}

/**
 * Lightweight fence-mask computer for pre-processing.
 * Mirrors the parser's computeFenceMask but avoids a circular dependency.
 */
export function computeFenceMaskForMerge(lines: string[]): boolean[] {
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
 * Applies SR multi-line block merging to raw note text.
 *
 * This is the entry point used by the sync engine BEFORE parsing so the
 * line indices in parsed cards match the text that will be edited.
 *
 * Returns the processed text (with multi-line blocks replaced by :: / :::
 * shorthand), or the original text if no blocks were merged.
 */
export function preprocessSrText(
  text: string,
  ignoreFences: boolean,
  isHeaderLine: (line: string) => boolean,
): string {
  const lines = text.split(/\r?\n/);
  const fenceMask = ignoreFences
    ? computeFenceMaskForMerge(lines)
    : new Array<boolean>(lines.length).fill(false);

  const merged = mergeSrMultilineBlocks(lines, fenceMask, isHeaderLine);

  // Only join if lines changed
  if (merged.length === lines.length) return text;
  return merged.join("\n");
}
