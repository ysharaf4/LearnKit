/**
 * Card Validator & Variant Normalizer
 *
 * Pure domain module responsible for validating card invariants, normalizing
 * multi-line text fields, and computing variant representations (e.g. Cartesian
 * and zip combo variants, canonical MCQ option ordering) across all supported card types.
 */

import {
  escapeDelimiterRe,
  splitComboVariants,
  splitZipVariants,
} from "../../platform/core/delimiter";
import { validateClozeTextCompat } from "../../platform/core/shared-utils";
import { normalizeGroups } from "../indexing/group-format";

export type CardType = "basic" | "reversed" | "mcq" | "cloze" | "io" | "hq" | "oq" | "combo";

export type McqOption = { text: string; isCorrect: boolean };

export type ParsedCard = {
  id: string | null;
  type: CardType;

  title: string | null;

  // basic
  q: string | null;
  a: string | null; // (also used for MCQ explanation)

  // mcq
  stem: string | null;

  // NEW canonical representation
  options: McqOption[] | null;

  // legacy convenience (derived from options)
  correctIndex: number | null;

  // legacy / parse staging
  mcqMarkedRaw: string | null; // lines prefixed with W:/C: (new O/A or legacy C/K)
  mcqLegacyOptionsRaw: string | null; // legacy single O: list with **correct**

  // groups
  groupsRaw: string | null;
  groups: string[] | null;

  // cloze
  clozeText: string | null;

  // IO prompt (IO uses prompt via Q | ... | field inside IO card)
  prompt: string | null;

  // IO: start line content (should include ![[...]] or equivalent)
  ioSrc: string | null;

  // IO: optional occlusions JSON + mask mode
  ioOcclusionsRaw: string | null; // raw JSON text from O | ... |
  occlusions: unknown[] | null; // parsed array, if valid
  maskMode: "solo" | "all" | null; // from C | solo/all |

  // HQ: optional regions JSON + interaction mode
  hqSrc: string | null;
  hqRegionsRaw: string | null;
  hqRegions: unknown[] | null;
  interactionMode: "click" | "drag-drop" | null;

  // OQ: ordering question
  oqSteps: string[] | null; // ordered list of steps (correct order)
  /** @internal Parser-only: index of the step currently being accumulated. */
  _oqCurrentStepIdx?: number;

  // Combo: Cartesian product cards (QX/AX)
  /** Question variants split by :: (product) or ::: (zip). */
  qVariants: string[] | null;
  /** Answer variants split by :: (product) or ::: (zip). */
  aVariants: string[] | null;
  /** How children are expanded: "product" (Cartesian) or "zip" (sequential, paired). */
  comboMode: "product" | "zip" | null;

  // shared
  info: string | null;
  audioRef: string | null;

  sourceNotePath: string;
  sourceStartLine: number;
  sourceEndLine: number;

  /** True when this card was parsed from shorthand `::` / `:::` syntax. */
  isShorthand: boolean;

  errors: string[];
};

export interface CardValidationContext {
  pendingId?: string | null;
  pendingTitle?: string | null;
  delimiter?: string;
}

export function createEmptyParsedCard(
  notePath: string,
  startLine: number,
  type: CardType = "basic",
): ParsedCard {
  return {
    id: null,
    type,
    title: null,
    q: null,
    a: null,
    stem: null,
    options: null,
    correctIndex: null,
    mcqMarkedRaw: null,
    mcqLegacyOptionsRaw: null,
    groupsRaw: null,
    groups: null,
    clozeText: null,
    prompt: null,
    ioSrc: null,
    ioOcclusionsRaw: null,
    occlusions: null,
    maskMode: null,
    hqSrc: null,
    hqRegionsRaw: null,
    hqRegions: null,
    interactionMode: null,
    oqSteps: null,
    qVariants: null,
    aVariants: null,
    comboMode: null,
    info: null,
    audioRef: null,

    sourceNotePath: notePath,
    sourceStartLine: startLine,
    sourceEndLine: startLine,
    isShorthand: false,
    errors: [],
  };
}

export function normaliseMultiline(s: string | null): string | null {
  if (!s) return s;
  return s.replace(/[ \t]+\n/g, "\n").trim();
}

export function parseGroups(raw: string | null, delimiter?: string): string[] | null {
  if (!raw) return null;
  const flat = raw.replace(/\r?\n/g, " ").trim();
  if (!flat) return null;

  // Split on comma and the active delimiter
  const delimEsc = delimiter ? escapeDelimiterRe(delimiter) : escapeDelimiterRe();
  const delimRe = new RegExp(`[,${delimEsc}]`, "g");
  const groups = normalizeGroups(flat.split(delimRe));
  return groups.length ? groups : null;
}

export function tryParseJsonArray(
  raw: string,
  cardLabel: string = "IO",
): { arr: unknown[] | null; error: string | null } {
  const t = String(raw ?? "").trim();
  if (!t) return { arr: null, error: null };

  try {
    const v: unknown = JSON.parse(t);
    if (!Array.isArray(v)) return { arr: null, error: `${cardLabel} occlusions must be a JSON array.` };
    return { arr: v, error: null };
  } catch (e: unknown) {
    return {
      arr: null,
      error: `${cardLabel} occlusions JSON is invalid (${e instanceof Error ? e.message : String(e)}).`,
    };
  }
}

/**
 * Validates invariant requirements and normalizes variant/option fields
 * on a card instance. Mutates and returns the card.
 */
export function validateAndNormalizeCard(
  card: ParsedCard,
  context?: CardValidationContext,
): ParsedCard {
  // Attach pending title if not already present
  if (!card.title && context?.pendingTitle) {
    card.title = context.pendingTitle;
  }

  // Normalise multiline string fields
  (
    [
      "title",
      "q",
      "a",
      "stem",
      "mcqMarkedRaw",
      "mcqLegacyOptionsRaw",
      "groupsRaw",
      "clozeText",
      "prompt",
      "ioSrc",
      "ioOcclusionsRaw",
      "info",
      "audioRef",
    ] as const
  ).forEach((k) => {
    if (card[k]) card[k] = normaliseMultiline(card[k]);
  });

  // Attach pending ID if not already present
  if (!card.id && context?.pendingId) {
    card.id = context.pendingId;
  }

  card.groups = parseGroups(card.groupsRaw, context?.delimiter);

  if (card.type === "basic") {
    // ── Combo auto-detection ──────────────────────────────────────
    // Check ::: (zip/sequential) first, then :: (Cartesian product).
    // ::: inside field pipes is distinct from the bare-line `Q:::A` shorthand.
    const qRaw = String(card.q ?? "").trim();
    const aRaw = String(card.a ?? "").trim();

    const qZip = qRaw ? splitZipVariants(qRaw) : [];
    const aZip = aRaw ? splitZipVariants(aRaw) : [];
    const hasQZip = qZip.length > 1;
    const hasAZip = aZip.length > 1;

    if (hasQZip || hasAZip) {
      // Zip mode: variants are paired by position.
      card.comboMode = "zip";
      card.qVariants = hasQZip ? qZip : (qRaw ? [qRaw] : []);
      card.aVariants = hasAZip ? aZip : (aRaw ? [aRaw] : []);

      if (card.qVariants.length < 1) {
        card.errors.push("Combo card requires at least one question variant. Separate variants with :::.");
      }
      if (card.aVariants.length < 1) {
        card.errors.push("Combo card requires at least one answer variant. Separate variants with :::.");
      }
      if (
        card.qVariants.length > 1 &&
        card.aVariants.length > 1 &&
        card.qVariants.length !== card.aVariants.length
      ) {
        card.errors.push(
          `Sequential combo card has mismatched variant counts: ${card.qVariants.length} questions and ${card.aVariants.length} answers. Counts must be equal.`,
        );
      }
    } else {
      // Product mode: full Cartesian product Q × A.
      const qVariants = qRaw ? splitComboVariants(qRaw) : [];
      const aVariants = aRaw ? splitComboVariants(aRaw) : [];

      const hasQVariants = qVariants.length > 1;
      const hasAVariants = aVariants.length > 1;

      if (hasQVariants || hasAVariants) {
        card.comboMode = "product";
        card.qVariants = hasQVariants ? qVariants : (qRaw ? [qRaw] : []);
        card.aVariants = hasAVariants ? aVariants : (aRaw ? [aRaw] : []);

        if (card.qVariants.length < 1) {
          card.errors.push("Combo card requires at least one question variant. Separate variants with ::.");
        }
        if (card.aVariants.length < 1) {
          card.errors.push("Combo card requires at least one answer variant. Separate variants with ::.");
        }
      }
    }

    if (!card.q) card.errors.push("Missing Q:");
    if (!card.a) card.errors.push("Missing A:");
  } else if (card.type === "reversed") {
    if (!card.q) card.errors.push("Missing Q:");
    if (!card.a) card.errors.push("Missing A:");
  } else if (card.type === "mcq") {
    if (!card.stem) card.errors.push("Missing MCQ:");

    // Collect correct and wrong options from the options array
    // (A | lines are pushed as isCorrect:true, O | lines as isCorrect:false)
    const allOpts = Array.isArray(card.options) ? card.options : [];
    const correctFromA = card.a && card.a.trim() ? card.a.trim() : null;
    let corrects = allOpts.filter((o) => o.isCorrect && o.text && o.text.trim());
    let wrongs = allOpts.filter((o) => !o.isCorrect && o.text && o.text.trim());

    // Legacy compat: if no correct options in array but card.a exists, treat it as a single correct
    if (corrects.length === 0 && correctFromA) {
      corrects = [{ text: correctFromA, isCorrect: true }];
      // Remove wrongs that duplicate the answer
      wrongs = wrongs.filter((o) => o.text.trim() !== correctFromA);
    }

    if (corrects.length < 1) {
      card.errors.push("MCQ requires at least one A | correct answer | line.");
    }
    if (wrongs.length < 1) {
      card.errors.push("MCQ requires at least one O | wrong option | line.");
    }
    // Set canonical options: corrects first, then wrongs, filter out empty/whitespace
    if (corrects.length >= 1 && wrongs.length >= 1) {
      const correctTexts = corrects.map((o) => ({ text: o.text.trim(), isCorrect: true }));
      const wrongTexts = wrongs.map((o) => ({ text: o.text.trim(), isCorrect: false }));
      const finalOptions = [...correctTexts, ...wrongTexts].filter((opt) => opt.text.length > 0);
      card.options = finalOptions;
      card.correctIndex = 0; // backward compat: first correct
      // Also set legacy card.a to the first correct answer
      card.a = correctTexts[0]?.text ?? null;
    }
  } else if (card.type === "cloze") {
    if (!card.clozeText) card.errors.push("Missing CQ:");
    if (card.clozeText) {
      validateClozeTextCompat(card.clozeText).forEach((e) => card.errors.push(e));
    }
  } else if (card.type === "io") {
    const src = String(card.ioSrc ?? "").trim();
    if (!src) {
      card.errors.push("IO card requires: IO | ![[image.png]] |");
    } else {
      const hasEmbed = src.includes("![[") || /!\[[^\]]*\]\([^)]+\)/.test(src);
      if (!hasEmbed) card.errors.push("IO card requires an embedded image, e.g.: IO | ![[image.png]] |");
    }

    // occlusions are optional, but if present must be valid JSON array
    const rawOcc = String(card.ioOcclusionsRaw ?? "").trim();
    if (rawOcc) {
      const { arr, error } = tryParseJsonArray(rawOcc, "IO");
      if (error) card.errors.push(error);
      card.occlusions = arr;
    } else {
      card.occlusions = null;
    }

    // mask mode is optional; if present must be solo/all
    const mm = String(card.maskMode ?? "").trim();
    if (mm && mm !== "solo" && mm !== "all") {
      card.errors.push('IO mask mode must be "solo" or "all".');
    }
  } else if (card.type === "hq") {
    const src = String(card.hqSrc ?? "").trim();
    if (!src) {
      card.errors.push("HQ card requires: HQ | ![[image.png]] |");
    } else {
      const hasEmbed = src.includes("![[") || /!\[[^\]]*\]\([^)]+\)/.test(src);
      if (!hasEmbed) card.errors.push("HQ card requires an embedded image, e.g.: HQ | ![[image.png]] |");
    }

    const rawRegions = String(card.hqRegionsRaw ?? "").trim();
    if (rawRegions) {
      const { arr, error } = tryParseJsonArray(rawRegions, "HQ");
      if (error) card.errors.push(error);
      card.hqRegions = arr;
    } else {
      card.hqRegions = null;
    }

    const mode = String(card.interactionMode ?? "").trim();
    if (mode && mode !== "click" && mode !== "drag-drop") {
      card.errors.push('HQ interaction mode must be "click" or "drag-drop".');
    }
  } else if (card.type === "oq") {
    if (!card.q) card.errors.push("Missing OQ question.");
    // Clean up steps: trim whitespace, remove empty trailing entries
    if (card.oqSteps) {
      card.oqSteps = card.oqSteps.map((s) => (s || "").trim()).filter(Boolean);
    }
    const steps = card.oqSteps || [];
    if (steps.length < 2) card.errors.push("OQ requires at least 2 numbered steps (1 | ... |, 2 | ... |).");
    if (steps.length > 20) card.errors.push("OQ supports a maximum of 20 steps.");
    delete card._oqCurrentStepIdx;
  }

  return card;
}
