/**
 * Parser Module Facade
 *
 * Provides the public facade for card text parsing, invariant validation,
 * and delimiter-based Markdown decomposition in LearnKit.
 */

export {
  parseCardsFromText,
  computeFenceMask,
  computeMathFenceMask,
  autoNumberClozeTokens,
  canParseShorthand,
} from "./card-text-parser";

export type {
  ParseCardsFromTextOptions,
} from "./card-text-parser";

export {
  createEmptyParsedCard,
  normaliseMultiline,
  parseGroups,
  tryParseJsonArray,
  validateAndNormalizeCard,
} from "./card-validator";

export type {
  CardType,
  McqOption,
  ParsedCard,
  CardValidationContext,
} from "./card-validator";
