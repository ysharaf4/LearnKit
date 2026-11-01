/**
 * @file src/platform/integrations/anki/anki-package.ts
 * @summary Deep domain module for Anki Package (.apkg) exchange.
 *
 * Encapsulates the entire .apkg lifecycle:
 * - SQLite schema compilation and row manipulation
 * - ZIP archiving and zstd-compressed collection decoding
 * - HTML ↔ Markdown field conversions and media references
 * - In-memory extraction of Markdown deck notes, card states, and media
 * - Headless operation (free of Obsidian Vault dependencies)
 *
 * Also provides thin adapters for Obsidian modals:
 * - exportToApkg
 * - previewApkg
 * - importFromApkg
 *
 * @exports
 *  - AnkiPackage
 *  - AnkiPackageCreateOptions
 *  - AnkiPackageCreateStats
 *  - AnkiPackagePreview
 *  - AnkiPackageExtractOptions
 *  - AnkiPackageExtractResult
 *  - exportToApkg
 *  - previewApkg
 *  - importFromApkg
 */

import { zipSync, unzipSync, strToU8, strFromU8 } from "fflate/browser";
import { decompress as zstdDecompress } from "fzstd";
import { generatorParameters } from "ts-fsrs";
import { TFile, type App } from "obsidian";

import { getSqlJs, type Database, type SqlValue } from "../../core/sql-wasm";
import type { CardRecord } from "../../types/card";
import type { CardState, SchedulerSettings } from "../../types/scheduler";
import type { ReviewLogEntry } from "../../types/review";
import type LearnKitPlugin from "../../../main";
import { log } from "../../core/logger";
import { syncOneFile } from "../sync/sync-engine";
import { normalizeGroups } from "../../../engine/indexing/group-format";

import {
  ANKI_SCHEMA_VERSION,
  ANKI_FIELD_SEPARATOR,
  DEFAULT_DECK_ID,
  DEFAULT_DECK_NAME,
  BASIC_MODEL_ID,
  CLOZE_MODEL_ID,
  type AnkiNoteRow,
  type AnkiCardRow,
  type AnkiRevlogRow,
  type AnkiModel,
  type AnkiDeck,
  makeBasicModel,
  makeClozeModel,
} from "./anki-constants";

import {
  cardRecordToAnkiNote,
  cardStateToAnkiCard,
  reviewLogToAnkiRevlog,
  ankiNoteToCardRecord,
  ankiCardToCardState,
} from "./anki-mapper";

import {
  groupPathToAnkiDeck,
  generateAnkiId,
  _resetIdCounter,
  deckToFolderAndFile,
} from "./anki-utils";

function normalizeForHash(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

function computeCardContentHash(card: CardRecord): string | null {
  if (card.type === "cloze" || card.type === "cloze-child") {
    const text = card.clozeText || (card as { prompt?: string }).prompt;
    return text ? `cloze:${normalizeForHash(text)}` : null;
  }
  if (card.type === "basic" || card.type === "reversed") {
    const text = card.q || (card as { prompt?: string }).prompt;
    return text ? `basic:${normalizeForHash(text)}` : null;
  }
  if (card.type === "mcq") {
    return card.stem ? `mcq:${normalizeForHash(card.stem)}` : null;
  }
  return null;
}

// ── Types ─────────────────────────────────────────────────────────────────────

export type AnkiPackageCreateOptions = {
  cards: CardRecord[];
  states?: Record<string, CardState>;
  revlogs?: ReviewLogEntry[];
  media?: Map<string, Uint8Array>;
  defaultDeckName?: string;
  mcqStrategy?: "convert-to-basic" | "skip";
  includeScheduling?: boolean;
  includeRevlog?: boolean;
  includeMedia?: boolean;
  schedulerSettings?: SchedulerSettings;
  desiredRetention?: number;
  onProgress?: (pct: number, message: string) => void | Promise<void>;
};

export type AnkiPackageCreateStats = {
  notesExported: number;
  cardsExported: number;
  revlogEntries: number;
  mediaFiles: number;
  mcqConverted: number;
  mcqSkipped: number;
  ioSkipped: number;
};

export type UnknownModelInfo = {
  modelId: number;
  modelName: string;
  fieldNames: string[];
  noteCount: number;
};

export type ModelFieldMapping = {
  modelId: number;
  importAs: "basic" | "cloze";
  questionFieldIdx: number;
  answerFieldIdx: number;
  infoFieldIdx: number;
};

export type AnkiPackagePreview = {
  decks: string[];
  noteCount: number;
  cardCount: number;
  hasMedia: boolean;
  mediaCount: number;
  unknownModels: UnknownModelInfo[];
  warnings: string[];
  totalNotes: number;
  totalCards: number;
  basicCount: number;
  clozeCount: number;
  ioCount: number;
  otherCount: number;
  deckNames: string[];
};

export type AnkiPackageExtractOptions = {
  fieldMappings?: ModelFieldMapping[];
  groupMapping?: "tags-only" | "deck-as-group";
  duplicateStrategy?: "allow" | "skip";
  existingCardHashes?: Set<string>;
  importScheduling?: boolean;
  targetFolder?: string;
  onProgress?: (pct: number, message: string) => void | Promise<void>;
};

export type AnkiPackageDeckExtraction = {
  deckId: number;
  deckName: string;
  targetFolder: string;
  targetFilePath: string;
  markdownContent: string;
  cards: CardRecord[];
  cardStates: Record<string, CardState>;
  noteCount: number;
  cardCount: number;
};

export type AnkiPackageExtractResult = {
  decks: AnkiPackageDeckExtraction[];
  media: Map<string, Uint8Array>;
  mediaNameMap: Map<string, string>;
  imported: number;
  skipped: number;
  duplicates: number;
  ioSkipped: number;
  otherSkipped: number;
  warnings: string[];
};

// ── Media and ZIP Constants ───────────────────────────────────────────────────

const WIKI_IMAGE_RE = /!\[\[([^\]]+)\]\]/g;
const MD_IMAGE_RE = /!\[([^\]]*)\]\(([^)]+)\)/g;
const ANKI_IMG_RE = /<img\s+[^>]*src=["']([^"']+)["'][^>]*\/?>/gi;
const ANKI_SOUND_RE = new RegExp("\\[" + "sou" + "nd:([^\\]]+)\\]", "g");

const COLLECTION_NAMES_BY_PREFERENCE = [
  "collection.anki21b",
  "collection.anki21",
  "collection.anki2",
] as const;

const SQLITE_MAGIC = "SQLite format 3\0";

function startsWithSqliteMagic(bytes: Uint8Array): boolean {
  if (bytes.length < SQLITE_MAGIC.length) return false;
  for (let i = 0; i < SQLITE_MAGIC.length; i++) {
    if (bytes[i] !== SQLITE_MAGIC.charCodeAt(i)) return false;
  }
  return true;
}

function decodeCollectionBytes(name: string, bytes: Uint8Array): Uint8Array {
  if (startsWithSqliteMagic(bytes)) return bytes;
  try {
    const inflated = zstdDecompress(bytes);
    if (startsWithSqliteMagic(inflated)) return inflated;
  } catch {
    // Fall through
  }
  throw new Error(`Invalid Anki file: ${name} is neither a SQLite database nor a readable zstd container.`);
}

function parseJsonObject<T>(raw: string): Record<string, T> {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as Record<string, T>;
  } catch {
    return {};
  }
}

function isStandardBasicModel(model: AnkiModel): boolean {
  const name = (model.name || "").toLowerCase();
  return name.includes("basic") && !name.includes("cloze");
}

function makeFallbackModel(id: number): AnkiModel {
  return {
    id,
    name: `Unknown (${id})`,
    type: 0,
    mod: 0,
    usn: -1,
    sortf: 0,
    did: DEFAULT_DECK_ID,
    tmpls: [],
    flds: [{ name: "Front", ord: 0 }, { name: "Back", ord: 1 }],
    css: "",
    latexPre: "",
    latexPost: "",
    tags: [],
    vers: [],
  };
}

// ── Deep Domain Module: AnkiPackage ──────────────────────────────────────────

export class AnkiPackage {
  private _bytes: Uint8Array;
  private _stats: AnkiPackageCreateStats | null;
  private _models: Map<number, AnkiModel>;
  private _decks: Map<number, AnkiDeck>;
  private _notes: AnkiNoteRow[];
  private _cards: AnkiCardRow[];
  private _revlogs: AnkiRevlogRow[];
  private _media: Map<string, Uint8Array>;
  private _collectionCrt: number;

  private constructor(
    bytes: Uint8Array,
    stats: AnkiPackageCreateStats | null,
    models: Map<number, AnkiModel>,
    decks: Map<number, AnkiDeck>,
    notes: AnkiNoteRow[],
    cards: AnkiCardRow[],
    revlogs: AnkiRevlogRow[],
    media: Map<string, Uint8Array>,
    collectionCrt: number,
  ) {
    this._bytes = bytes;
    this._stats = stats;
    this._models = models;
    this._decks = decks;
    this._notes = notes;
    this._cards = cards;
    this._revlogs = revlogs;
    this._media = media;
    this._collectionCrt = collectionCrt;
  }

  get stats(): AnkiPackageCreateStats | null {
    return this._stats;
  }

  toBytes(): Uint8Array {
    return this._bytes;
  }

  get media(): Map<string, Uint8Array> {
    return this._media;
  }

  // ── Factory: Create ─────────────────────────────────────────────────────────

  static async create(options: AnkiPackageCreateOptions): Promise<AnkiPackage> {
    _resetIdCounter();
    const defaultDeckName = options.defaultDeckName || DEFAULT_DECK_NAME;
    const includeScheduling = options.includeScheduling !== false;
    const includeRevlog = options.includeRevlog !== false;
    const includeMedia = options.includeMedia !== false;
    const mcqStrategy = options.mcqStrategy || "convert-to-basic";
    const mediaMap = options.media || new Map<string, Uint8Array>();

    await options.onProgress?.(5, "Filtering cards…");

    // 1. Filter reviewable cards
    const allCards = options.cards || [];
    let cards = allCards.filter((c) => {
      if (!c) return false;
      if (c.type === "io" || c.type === "io-child") return false;
      if (c.type === "cloze-child" || c.type === "reversed-child") return false;
      return true;
    });

    let mcqConverted = 0;
    let mcqSkipped = 0;
    if (mcqStrategy === "skip") {
      const before = cards.length;
      cards = cards.filter((c) => c.type !== "mcq");
      mcqSkipped = before - cards.length;
    } else {
      mcqConverted = cards.filter((c) => c.type === "mcq").length;
    }

    const ioSkipped = allCards.filter((c) => c?.type === "io" || c?.type === "io-child").length;

    // 2. Build deck hierarchy from card groups
    await options.onProgress?.(15, "Building deck hierarchy…");
    const deckMap = new Map<string, number>();
    deckMap.set(defaultDeckName, DEFAULT_DECK_ID);

    const deckObjects: Record<string, AnkiDeck> = {};
    const nowSec = Math.floor(Date.now() / 1000);

    const makeDeck = (id: number, name: string): AnkiDeck => ({
      id,
      name,
      mod: nowSec,
      usn: -1,
      collapsed: false,
      browserCollapsed: false,
      desc: "",
      dyn: 0,
      conf: 1,
      extendNew: 10,
      extendRev: 50,
    });

    deckObjects[String(DEFAULT_DECK_ID)] = makeDeck(DEFAULT_DECK_ID, defaultDeckName);

    for (const card of cards) {
      if (Array.isArray(card.groups) && card.groups.length > 0) {
        const ankiDeckPath = groupPathToAnkiDeck(card.groups[0] || "");
        if (ankiDeckPath && !deckMap.has(ankiDeckPath)) {
          const deckId = generateAnkiId();
          deckMap.set(ankiDeckPath, deckId);
          deckObjects[String(deckId)] = makeDeck(deckId, ankiDeckPath);
        }
      }
    }

    // 3. Register models
    const basicModel = makeBasicModel();
    const clozeModel = makeClozeModel();

    const modelObjects: Record<string, AnkiModel> = {
      [String(BASIC_MODEL_ID)]: basicModel,
      [String(CLOZE_MODEL_ID)]: clozeModel,
    };

    // 4. Setup in-memory SQLite collection
    await options.onProgress?.(30, "Compiling collection database…");
    const SQL = await getSqlJs();
    const db = new SQL.Database();
    AnkiPackage.initializeSchema(db);

    // Build FSRS params
    let fsrsWeights: number[] | undefined;
    if (options.schedulerSettings) {
      try {
        const desiredRetention = Math.max(0.8, Math.min(0.97, Number(options.desiredRetention ?? options.schedulerSettings.requestRetention) || 0.9));
        const params = generatorParameters({
          request_retention: desiredRetention,
          maximum_interval: 36500,
          enable_fuzz: false,
        });
        if (Array.isArray(params?.w)) fsrsWeights = params.w;
      } catch {
        // fallback
      }
    }

    AnkiPackage.insertCollectionRow(db, {
      creationTimestamp: nowSec,
      models: modelObjects,
      decks: deckObjects,
      fsrsParams: fsrsWeights,
      desiredRetention: options.desiredRetention ?? 0.9,
    });

    // 5. Gather media references and rewrite fields
    const mediaNames = new Set(mediaMap.keys());
    const bundledMedia = new Map<string, Uint8Array>();

    // 6. Convert cards to Anki note, card, and revlog rows
    await options.onProgress?.(50, "Generating Anki cards and notes…");
    const states = options.states || {};
    const revlogs = options.revlogs || [];

    const revlogByCardId = new Map<string, ReviewLogEntry[]>();
    if (includeRevlog) {
      for (const entry of revlogs) {
        const list = revlogByCardId.get(entry.id) || [];
        list.push(entry);
        revlogByCardId.set(entry.id, list);
      }
    }

    let notesExported = 0;
    let cardsExported = 0;
    let revlogEntriesCount = 0;

    for (const card of cards) {
      const deckName = (Array.isArray(card.groups) && card.groups[0])
        ? groupPathToAnkiDeck(card.groups[0])
        : defaultDeckName;
      const deckId = deckMap.get(deckName) ?? DEFAULT_DECK_ID;

      // Collect & rewrite media in card fields
      const rw = (s: string | null | undefined): string | null | undefined => {
        if (!s) return s;
        return includeMedia ? AnkiPackage.rewriteFieldForAnki(s) : s;
      };

      if (includeMedia) {
        const cardRefs = AnkiPackage.collectMediaRefs([
          card.q,
          card.a,
          card.prompt,
          (card as { answer?: string }).answer,
          card.info,
          card.clozeText,
          card.stem,
        ]);
        for (const ref of cardRefs) {
          const base = ref.split("/").pop() || ref;
          if (mediaMap.has(base)) {
            bundledMedia.set(base, mediaMap.get(base)!);
          } else if (mediaMap.has(ref)) {
            bundledMedia.set(base, mediaMap.get(ref)!);
          }
        }
      }

      const noteCard: CardRecord = {
        ...card,
        q: rw(card.q),
        a: rw(card.a || (card as { answer?: string }).answer),
        prompt: rw(card.prompt),
        info: rw(card.info),
        clozeText: rw(card.clozeText),
        stem: rw(card.stem),
      };
      const noteRow = cardRecordToAnkiNote(noteCard);
      AnkiPackage.insertNoteRow(db, noteRow);
      notesExported++;

      const state = includeScheduling ? states[card.id] : undefined;

      if (card.type === "cloze") {
        const clozeIndices = AnkiPackage.extractClozeIndices(
          card.clozeText || (card as { prompt?: string }).prompt || ""
        );
        for (const idx of clozeIndices) {
          const ord = idx - 1;
          const cardRow = (state && includeScheduling)
            ? cardStateToAnkiCard(state, noteRow.id, deckId, ord, nowSec)
            : AnkiPackage.makeNewAnkiCard(noteRow.id, deckId, ord);
          AnkiPackage.insertCardRow(db, cardRow);
          cardsExported++;

          if (includeRevlog) {
            const cardRevlogs = revlogByCardId.get(card.id) || [];
            for (const rl of cardRevlogs) {
              const revlogRow = reviewLogToAnkiRevlog(rl, cardRow.id);
              AnkiPackage.insertRevlogRow(db, revlogRow);
              revlogEntriesCount++;
            }
          }
        }
      } else {
        const cardCountForNote = card.type === "reversed" ? 2 : 1;
        for (let ord = 0; ord < cardCountForNote; ord++) {
          const cardRow = (state && includeScheduling)
            ? cardStateToAnkiCard(state, noteRow.id, deckId, ord, nowSec)
            : AnkiPackage.makeNewAnkiCard(noteRow.id, deckId, ord);
          AnkiPackage.insertCardRow(db, cardRow);
          cardsExported++;

          if (includeRevlog) {
            const cardRevlogs = revlogByCardId.get(card.id) || [];
            for (const rl of cardRevlogs) {
              const revlogRow = reviewLogToAnkiRevlog(rl, cardRow.id);
              AnkiPackage.insertRevlogRow(db, revlogRow);
              revlogEntriesCount++;
            }
          }
        }
      }
    }

    // 7. Compress SQLite DB and bundle into ZIP
    await options.onProgress?.(85, "Packing .apkg archive…");
    const sqliteBytes = db.export();
    db.close();

    const mediaToPack = includeMedia ? bundledMedia : new Map<string, Uint8Array>();
    const apkgBytes = AnkiPackage.packZip(sqliteBytes, mediaToPack);

    await options.onProgress?.(100, "Export complete");

    const stats: AnkiPackageCreateStats = {
      notesExported,
      cardsExported,
      revlogEntries: revlogEntriesCount,
      mediaFiles: mediaToPack.size,
      mcqConverted,
      mcqSkipped,
      ioSkipped,
    };

    const modelsMap = new Map<number, AnkiModel>();
    for (const [idStr, m] of Object.entries(modelObjects)) {
      modelsMap.set(Number(idStr), m);
    }

    const decksMap = new Map<number, AnkiDeck>();
    for (const [idStr, d] of Object.entries(deckObjects)) {
      decksMap.set(Number(idStr), d);
    }

    return new AnkiPackage(
      apkgBytes,
      stats,
      modelsMap,
      decksMap,
      [],
      [],
      [],
      mediaToPack,
      nowSec,
    );
  }

  // ── Factory: Read ───────────────────────────────────────────────────────────

  static async read(bytes: Uint8Array): Promise<AnkiPackage> {
    const { sqliteBytes, media } = AnkiPackage.unpackZip(bytes);

    const SQL = await getSqlJs();
    const db = new SQL.Database(sqliteBytes);

    try {
      const models = AnkiPackage.readModelsFromDb(db);
      const decks = AnkiPackage.readDecksFromDb(db);
      const notes = AnkiPackage.readNotesFromDb(db);
      const cards = AnkiPackage.readCardsFromDb(db);
      const revlogs = AnkiPackage.readRevlogFromDb(db);
      const collectionCrt = AnkiPackage.readCollectionCrtFromDb(db);

      const stubReason = AnkiPackage.describeAnkiUpgradeStub(notes);
      if (stubReason) {
        throw new Error(stubReason);
      }

      return new AnkiPackage(
        bytes,
        null,
        models,
        decks,
        notes,
        cards,
        revlogs,
        media,
        collectionCrt,
      );
    } finally {
      db.close();
    }
  }

  // ── Inspection: Preview ─────────────────────────────────────────────────────

  preview(): AnkiPackagePreview {
    const deckNames: string[] = [];
    for (const deck of this._decks.values()) {
      if (deck.name && deck.name !== "Default") {
        deckNames.push(deck.name);
      }
    }
    deckNames.sort();

    const unknownModels: UnknownModelInfo[] = [];
    const modelNoteCounts = new Map<number, number>();
    for (const note of this._notes) {
      modelNoteCounts.set(note.mid, (modelNoteCounts.get(note.mid) || 0) + 1);
    }

    for (const [mid, model] of this._models) {
      const isStandard = Number(model.type) === 1 || isStandardBasicModel(model);
      if (!isStandard) {
        const count = modelNoteCounts.get(mid) || 0;
        if (count > 0) {
          unknownModels.push({
            modelId: mid,
            modelName: model.name || `Model ${mid}`,
            fieldNames: (model.flds || []).map((f) => f.name),
            noteCount: count,
          });
        }
      }
    }

    const warnings: string[] = [];
    if (this._notes.length > 10000) {
      warnings.push(`Package contains ${this._notes.length.toLocaleString()} notes, which may take several minutes.`);
    }

    let hasIo = false;
    for (const model of this._models.values()) {
      const name = (model.name || "").toLowerCase();
      if (name.includes("image occlusion") || name.includes("imageocclusion")) {
        hasIo = true;
        break;
      }
    }
    if (hasIo) {
      warnings.push("Image Occlusion notes were detected and will be skipped.");
    }

    let basicCount = 0;
    let clozeCount = 0;
    let ioCount = 0;
    let otherCount = 0;

    for (const note of this._notes) {
      const model = this._models.get(note.mid);
      if (!model) {
        otherCount++;
        continue;
      }
      const modelName = (model.name || "").toLowerCase();
      if (modelName.includes("image occlusion") || modelName.includes("imageocclusion")) {
        ioCount++;
      } else if (Number(model.type) === 1) {
        clozeCount++;
      } else if (isStandardBasicModel(model)) {
        basicCount++;
      } else {
        otherCount++;
      }
    }

    return {
      decks: deckNames,
      noteCount: this._notes.length,
      cardCount: this._cards.length,
      hasMedia: this._media.size > 0,
      mediaCount: this._media.size,
      unknownModels,
      warnings,
      totalNotes: this._notes.length,
      totalCards: this._cards.length,
      basicCount,
      clozeCount,
      ioCount,
      otherCount,
      deckNames,
    };
  }

  // ── Extraction: Pure In-Memory ──────────────────────────────────────────────

  extract(options: AnkiPackageExtractOptions = {}): AnkiPackageExtractResult {
    const targetFolder = options.targetFolder || "Imported";
    const duplicateStrategy = options.duplicateStrategy || "skip";
    const existingHashes = options.existingCardHashes || new Set<string>();
    const importScheduling = options.importScheduling !== false;

    const fieldMappingByModel = new Map<number, ModelFieldMapping>();
    if (options.fieldMappings) {
      for (const fm of options.fieldMappings) {
        fieldMappingByModel.set(fm.modelId, fm);
      }
    }

    const cardsByNoteId = new Map<number, AnkiCardRow[]>();
    for (const card of this._cards) {
      const list = cardsByNoteId.get(card.nid) || [];
      list.push(card);
      cardsByNoteId.set(card.nid, list);
    }

    // Media sanitization map: filename -> vault sanitized relative path
    const mediaNameMap = new Map<string, string>();
    const mediaFolder = `${targetFolder}/Attachments`;
    for (const filename of this._media.keys()) {
      mediaNameMap.set(filename, `${mediaFolder}/${filename}`);
    }

    type DeckBucket = {
      deckId: number;
      deckName: string;
      notes: { note: AnkiNoteRow; model: AnkiModel; cards: AnkiCardRow[] }[];
    };

    const deckBuckets = new Map<number, DeckBucket>();

    let ioSkipped = 0;
    let otherSkipped = 0;
    let duplicates = 0;

    for (const note of this._notes) {
      const model = this._models.get(note.mid) || makeFallbackModel(note.mid);
      const modelName = (model.name || "").toLowerCase();
      if (modelName.includes("image occlusion") || modelName.includes("imageocclusion")) {
        ioSkipped++;
        continue;
      }

      const isStandard = Number(model.type) === 1 || isStandardBasicModel(model);
      if (!isStandard && !fieldMappingByModel.has(model.id)) {
        otherSkipped++;
        continue;
      }

      const noteCards = cardsByNoteId.get(note.id) || [];
      const deckId = noteCards.length > 0 ? noteCards[0].did : DEFAULT_DECK_ID;
      const deck = this._decks.get(deckId);
      const deckName = deck?.name || "Default";

      if (!deckBuckets.has(deckId)) {
        deckBuckets.set(deckId, { deckId, deckName, notes: [] });
      }

      deckBuckets.get(deckId)!.notes.push({
        note,
        model,
        cards: noteCards,
      });
    }

    const extractedDecks: AnkiPackageDeckExtraction[] = [];
    let importedTotal = 0;

    for (const bucket of deckBuckets.values()) {
      const { folder, file: filePath } = deckToFolderAndFile(bucket.deckName, targetFolder);
      const groupDeckName = options.groupMapping === "tags-only" ? "" : bucket.deckName;

      const cardBlocks: string[] = [];
      const deckCards: CardRecord[] = [];
      const deckCardStates: Record<string, CardState> = {};

      for (const { note, model, cards: noteCards } of bucket.notes) {
        // Rewrite media refs in fields
        let flds = note.flds;
        if (mediaNameMap.size > 0) {
          const fieldParts = flds.split(ANKI_FIELD_SEPARATOR);
          const rewritten = fieldParts.map((f) => AnkiPackage.rewriteFieldForLearnKit(f, mediaNameMap));
          flds = rewritten.join(ANKI_FIELD_SEPARATOR);
        }
        const rewrittenNote: AnkiNoteRow = { ...note, flds };

        const mapping = fieldMappingByModel.get(model.id);
        const lineOffset = cardBlocks.length * 6 + 1;
        const cardRecord = ankiNoteToCardRecord(
          rewrittenNote,
          model,
          groupDeckName,
          filePath,
          lineOffset,
          mapping,
        );
        if (!cardRecord) {
          otherSkipped++;
          continue;
        }

        if (!cardRecord.id) {
          cardRecord.id = `${filePath}#${note.id}`;
        }

        // Duplicate check
        if (duplicateStrategy === "skip") {
          const hash = computeCardContentHash(cardRecord);
          if (hash && existingHashes.has(hash)) {
            duplicates++;
            continue;
          }
          if (hash) existingHashes.add(hash);
        }

        // Build markdown block
        const blockMd = AnkiPackage.buildMarkdownBlock(cardRecord);
        cardBlocks.push(blockMd);
        deckCards.push(cardRecord);
        importedTotal++;

        // Scheduling state
        if (importScheduling && noteCards.length > 0) {
          const firstCard = noteCards[0];
          const state = ankiCardToCardState(firstCard, cardRecord.id, this._collectionCrt);
          if (state) {
            deckCardStates[cardRecord.id] = state;
          }
        }
      }

      if (cardBlocks.length > 0) {
        const fileContent = cardBlocks.join("\n\n") + "\n";
        extractedDecks.push({
          deckId: bucket.deckId,
          deckName: bucket.deckName,
          targetFolder: folder,
          targetFilePath: filePath,
          markdownContent: fileContent,
          cards: deckCards,
          cardStates: deckCardStates,
          noteCount: bucket.notes.length,
          cardCount: deckCards.length,
        });
      }
    }

    return {
      decks: extractedDecks,
      media: this._media,
      mediaNameMap,
      imported: importedTotal,
      skipped: ioSkipped + otherSkipped,
      duplicates,
      ioSkipped,
      otherSkipped,
      warnings: [],
    };
  }

  // ── Media Rewriting Helpers (Pure) ──────────────────────────────────────────

  static collectMediaRefs(fields: (string | null | undefined)[]): Set<string> {
    const refs = new Set<string>();
    for (const field of fields) {
      if (!field) continue;
      let m: RegExpExecArray | null;
      const wikiRe = new RegExp(WIKI_IMAGE_RE.source, "g");
      while ((m = wikiRe.exec(field)) !== null) {
        const ref = (m[1] || "").split("|")[0].trim();
        if (ref) refs.add(ref);
      }
      const mdRe = new RegExp(MD_IMAGE_RE.source, "g");
      while ((m = mdRe.exec(field)) !== null) {
        const ref = (m[2] || "").trim();
        if (ref && !ref.startsWith("http://") && !ref.startsWith("https://")) {
          refs.add(ref);
        }
      }
    }
    return refs;
  }

  static rewriteFieldForAnki(field: string): string {
    if (!field) return field;
    let text = field;
    text = text.replace(/!\[\[([^\]]+)\]\]/g, (_match, ref: string) => {
      const filename = (ref || "").split("|")[0].trim();
      const baseName = filename.split("/").pop() || filename;
      return `<img src="${baseName}">`;
    });
    text = text.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_match, _alt: string, path: string) => {
      if (path.startsWith("http://") || path.startsWith("https://")) return _match;
      const baseName = path.split("/").pop() || path;
      return `<img src="${baseName}">`;
    });
    return text;
  }

  static rewriteFieldForLearnKit(html: string, mediaNameMap: Map<string, string>): string {
    if (!html) return html;
    let text = html;
    text = text.replace(new RegExp(ANKI_IMG_RE.source, "gi"), (_match, src: string) => {
      const vaultPath = mediaNameMap.get(src) || src;
      return `![[${vaultPath}]]`;
    });
    text = text.replace(new RegExp(ANKI_SOUND_RE.source, "g"), (_match, src: string) => {
      const vaultPath = mediaNameMap.get(src) || src;
      return `![[${vaultPath}]]`;
    });
    return text;
  }

  static buildMarkdownBlock(card: CardRecord): string {
    const out: string[] = [];
    const escapePipe = (s: string) =>
      String(s ?? "")
        .replace(/\\/g, "\\\\")
        .replace(/\|/g, "\\|");

    if (card.title) out.push(`T| ${escapePipe(card.title)} |`);

    if (card.type === "cloze") {
      const cloze = card.clozeText || (card as { prompt?: string }).prompt || "";
      if (cloze) out.push(`CQ| ${escapePipe(cloze)} |`);
    } else {
      const q = card.q || (card as { prompt?: string }).prompt || "";
      const a = card.a || (card as { answer?: string }).answer || "";
      if (q) out.push(`Q| ${escapePipe(q)} |`);
      if (a) out.push(`A| ${escapePipe(a)} |`);
    }

    if (card.info) out.push(`I| ${escapePipe(card.info)} |`);

    const groups = normalizeGroups(card.groups);
    if (groups.length > 0) {
      out.push(`G| ${groups.join(", ")} |`);
    }

    return out.join("\n");
  }

  static makeNewAnkiCard(noteId: number, deckId: number, ord: number): AnkiCardRow {
    return {
      id: generateAnkiId(),
      nid: noteId,
      did: deckId,
      ord,
      mod: Math.floor(Date.now() / 1000),
      usn: -1,
      type: 0,
      queue: 0,
      due: 0,
      ivl: 0,
      factor: 0,
      reps: 0,
      lapses: 0,
      left: 0,
      odue: 0,
      odid: 0,
      flags: 0,
      data: "",
    };
  }

  static extractClozeIndices(text: string): number[] {
    const matches = text.matchAll(/\{\{c(\d+)::/gi);
    const indices = new Set<number>();
    for (const m of matches) {
      const n = parseInt(m[1], 10);
      if (!isNaN(n) && n > 0) indices.add(n);
    }
    return indices.size > 0 ? Array.from(indices).sort((a, b) => a - b) : [1];
  }

  // ── Internal ZIP Mechanics (Pure) ───────────────────────────────────────────

  static packZip(sqliteBytes: Uint8Array, media: Map<string, Uint8Array>): Uint8Array {
    const files: Record<string, Uint8Array> = {};
    files["collection.anki2"] = sqliteBytes;

    const mediaManifest: Record<string, string> = {};
    let idx = 0;
    for (const [filename, fileBytes] of media) {
      const key = String(idx);
      mediaManifest[key] = filename;
      files[key] = fileBytes;
      idx++;
    }

    files["media"] = strToU8(JSON.stringify(mediaManifest));
    return zipSync(files, { level: 6 });
  }

  static unpackZip(apkgBytes: Uint8Array): { sqliteBytes: Uint8Array; media: Map<string, Uint8Array> } {
    const files = unzipSync(apkgBytes);
    const names = Object.keys(files);

    const rankedNames: string[] = [];
    for (const preferred of COLLECTION_NAMES_BY_PREFERENCE) {
      for (const name of names) {
        if (name === preferred || name.endsWith(`/${preferred}`)) {
          if (!rankedNames.includes(name)) rankedNames.push(name);
        }
      }
    }

    if (rankedNames.length === 0) {
      throw new Error("Invalid Anki file: no .anki2 database found");
    }

    let sqliteBytes: Uint8Array | null = null;
    for (const name of rankedNames) {
      const candidate = files[name];
      if (!candidate) continue;
      const looksModern = name.endsWith("anki21b");
      if (looksModern) {
        sqliteBytes = decodeCollectionBytes(name, candidate);
        break;
      }
      if (startsWithSqliteMagic(candidate)) {
        sqliteBytes = candidate;
        break;
      }
    }

    if (!sqliteBytes) {
      sqliteBytes =
        rankedNames.length === 1
          ? files[rankedNames[0]]
          : decodeCollectionBytes(rankedNames[0], files[rankedNames[0]]);
    }

    // Media manifest
    const media = new Map<string, Uint8Array>();
    let mediaJson = "";
    if (files["media"]) {
      mediaJson = strFromU8(files["media"]);
    } else {
      const key = names.find((n) => n.endsWith("/media"));
      if (key && files[key]) mediaJson = strFromU8(files[key]);
    }

    if (mediaJson) {
      try {
        const manifest = JSON.parse(mediaJson) as Record<string, string>;
        for (const [key, origName] of Object.entries(manifest)) {
          const fileData = files[key];
          if (fileData) {
            media.set(origName, fileData);
          }
        }
      } catch {
        // media manifest parsing failure is non-fatal
      }
    }

    return { sqliteBytes, media };
  }

  // ── Internal SQLite Helpers (Pure) ──────────────────────────────────────────

  private static initializeSchema(db: Database): void {
    db.run(`
      CREATE TABLE col (
        id integer primary key,
        crt integer not null,
        mod integer not null,
        scm integer not null,
        ver integer not null,
        dty integer not null,
        usn integer not null,
        ls integer not null,
        conf text not null,
        models text not null,
        decks text not null,
        dconf text not null,
        tags text not null
      );
    `);

    db.run(`
      CREATE TABLE notes (
        id integer primary key,
        guid text not null,
        mid integer not null,
        mod integer not null,
        usn integer not null,
        tags text not null,
        flds text not null,
        sfld integer not null,
        csum integer not null,
        flags integer not null,
        data text not null
      );
    `);

    db.run(`
      CREATE TABLE cards (
        id integer primary key,
        nid integer not null,
        did integer not null,
        ord integer not null,
        mod integer not null,
        usn integer not null,
        type integer not null,
        queue integer not null,
        due integer not null,
        ivl integer not null,
        factor integer not null,
        reps integer not null,
        lapses integer not null,
        left integer not null,
        odue integer not null,
        odid integer not null,
        flags integer not null,
        data text not null
      );
    `);

    db.run(`
      CREATE TABLE revlog (
        id integer primary key,
        cid integer not null,
        usn integer not null,
        ease integer not null,
        ivl integer not null,
        lastIvl integer not null,
        factor integer not null,
        time integer not null,
        type integer not null
      );
    `);

    db.run(`
      CREATE TABLE graves (
        usn integer not null,
        oid integer not null,
        type integer not null
      );
    `);

    db.run("CREATE INDEX ix_cards_nid ON cards (nid);");
    db.run("CREATE INDEX ix_cards_sched ON cards (did, queue, due);");
    db.run("CREATE INDEX ix_cards_usn ON cards (usn);");
    db.run("CREATE INDEX ix_notes_csum ON notes (csum);");
    db.run("CREATE INDEX ix_notes_usn ON notes (usn);");
    db.run("CREATE INDEX ix_revlog_cid ON revlog (cid);");
    db.run("CREATE INDEX ix_revlog_usn ON revlog (usn);");
  }

  private static insertCollectionRow(
    db: Database,
    opts: {
      creationTimestamp: number;
      models: Record<string, AnkiModel>;
      decks: Record<string, AnkiDeck>;
      fsrsParams?: number[];
      desiredRetention: number;
    },
  ): void {
    const now = Math.floor(Date.now() / 1000);
    const crt = opts.creationTimestamp;

    const dconf: Record<string, unknown> = {
      "1": {
        autoplay: true,
        dyn: false,
        id: 1,
        lapse: { delays: [10], leechAction: 1, leechFails: 8, minInt: 1, mult: 0 },
        maxTaken: 60,
        mod: 0,
        name: "Default",
        new: { bury: false, delays: [1, 10], initialFactor: 2500, ints: [1, 4, 0], order: 1, perDay: 20, separate: true },
        replayq: true,
        rev: { bury: false, ease4: 1.3, fuzz: 0.05, ivlFct: 1, maxIvl: 36500, minSpace: 1, perDay: 200 },
        desiredRetention: opts.desiredRetention,
        fsrsWeights: [],
        fsrsParams5: [],
        fsrsParams6: opts.fsrsParams ?? [],
        sm2Retention: 0.9,
        easyDaysPercentages: [1, 1, 1, 1, 1, 1, 1],
        timer: 0,
        usn: -1,
      },
    };

    const conf = JSON.stringify({
      activeDecks: [1],
      curDeck: 1,
      newSpread: 0,
      collapseTime: 1200,
      timeLim: 0,
      estTimes: true,
      dueCounts: true,
      curModel: String(BASIC_MODEL_ID),
      nextPos: 1,
      sortType: "noteFld",
      sortBackwards: false,
      addToCur: true,
    });

    db.run(
      `INSERT INTO col VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        1,
        crt,
        now * 1000,
        now * 1000,
        ANKI_SCHEMA_VERSION,
        0,
        -1,
        0,
        conf,
        JSON.stringify(opts.models),
        JSON.stringify(opts.decks),
        JSON.stringify(dconf),
        "{}",
      ],
    );
  }

  private static insertNoteRow(db: Database, note: AnkiNoteRow): void {
    db.run(`INSERT INTO notes VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
      note.id, note.guid, note.mid, note.mod, note.usn, note.tags,
      note.flds, note.sfld, note.csum, note.flags, note.data,
    ]);
  }

  private static insertCardRow(db: Database, card: AnkiCardRow): void {
    db.run(
      `INSERT INTO cards VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        card.id, card.nid, card.did, card.ord, card.mod, card.usn,
        card.type, card.queue, card.due, card.ivl, card.factor,
        card.reps, card.lapses, card.left, card.odue, card.odid,
        card.flags, card.data,
      ],
    );
  }

  private static insertRevlogRow(db: Database, entry: AnkiRevlogRow): void {
    db.run(`INSERT INTO revlog VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
      entry.id, entry.cid, entry.usn, entry.ease, entry.ivl,
      entry.lastIvl, entry.factor, entry.time, entry.type,
    ]);
  }

  private static readModelsFromDb(db: Database): Map<number, AnkiModel> {
    const results = db.exec("SELECT models FROM col LIMIT 1");
    if (!results.length || !results[0].values.length) return new Map();
    const modelsJson = String(results[0].values[0][0]);
    const models = parseJsonObject<AnkiModel>(modelsJson);
    const map = new Map<number, AnkiModel>();
    for (const [key, model] of Object.entries(models)) {
      const id = Number(key);
      if (Number.isFinite(id)) map.set(id, model);
    }
    return map;
  }

  private static readDecksFromDb(db: Database): Map<number, AnkiDeck> {
    const results = db.exec("SELECT decks FROM col LIMIT 1");
    if (!results.length || !results[0].values.length) return new Map();
    const decksJson = String(results[0].values[0][0]);
    const decks = parseJsonObject<AnkiDeck>(decksJson);
    const map = new Map<number, AnkiDeck>();
    for (const [key, deck] of Object.entries(decks)) {
      const id = Number(key);
      if (Number.isFinite(id)) map.set(id, deck);
    }
    return map;
  }

  private static readNotesFromDb(db: Database): AnkiNoteRow[] {
    const results = db.exec(
      "SELECT id, guid, mid, mod, usn, tags, flds, sfld, csum, flags, data FROM notes",
    );
    if (!results.length) return [];
    return results[0].values.map((row: SqlValue[]) => ({
      id: Number(row[0]),
      guid: String(row[1]),
      mid: Number(row[2]),
      mod: Number(row[3]),
      usn: Number(row[4]),
      tags: String(row[5]),
      flds: String(row[6]),
      sfld: String(row[7]),
      csum: Number(row[8]),
      flags: Number(row[9]),
      data: String(row[10]),
    }));
  }

  private static readCardsFromDb(db: Database): AnkiCardRow[] {
    const results = db.exec(
      "SELECT id, nid, did, ord, mod, usn, type, queue, due, ivl, factor, reps, lapses, left, odue, odid, flags, data FROM cards",
    );
    if (!results.length) return [];
    return results[0].values.map((row: SqlValue[]) => ({
      id: Number(row[0]),
      nid: Number(row[1]),
      did: Number(row[2]),
      ord: Number(row[3]),
      mod: Number(row[4]),
      usn: Number(row[5]),
      type: Number(row[6]),
      queue: Number(row[7]),
      due: Number(row[8]),
      ivl: Number(row[9]),
      factor: Number(row[10]),
      reps: Number(row[11]),
      lapses: Number(row[12]),
      left: Number(row[13]),
      odue: Number(row[14]),
      odid: Number(row[15]),
      flags: Number(row[16]),
      data: String(row[17]),
    }));
  }

  private static readRevlogFromDb(db: Database): AnkiRevlogRow[] {
    const results = db.exec(
      "SELECT id, cid, usn, ease, ivl, lastIvl, factor, time, type FROM revlog",
    );
    if (!results.length) return [];
    return results[0].values.map((row: SqlValue[]) => ({
      id: Number(row[0]),
      cid: Number(row[1]),
      usn: Number(row[2]),
      ease: Number(row[3]),
      ivl: Number(row[4]),
      lastIvl: Number(row[5]),
      factor: Number(row[6]),
      time: Number(row[7]),
      type: Number(row[8]),
    }));
  }

  private static readCollectionCrtFromDb(db: Database): number {
    const results = db.exec("SELECT crt FROM col LIMIT 1");
    if (!results.length || !results[0].values.length) return Math.floor(Date.now() / 1000);
    return Number(results[0].values[0][0]) || Math.floor(Date.now() / 1000);
  }

  static describeAnkiUpgradeStub(notes: AnkiNoteRow[]): string | null {
    if (notes.length !== 1) return null;
    const flds = String(notes[0]?.flds ?? "").toLowerCase();
    if (!flds.includes("please update to the latest anki version")) return null;
    return (
      "This file only contains Anki's placeholder note, not your decks. That means it was " +
      "exported from a collection Anki itself could not open, so the cards are not in the file. " +
      "Restore your collection from an Anki backup (.colpkg or an automatic backup), then export the .apkg again."
    );
  }
}

// ── Vault Adapters (Preserved Public Interface) ───────────────────────────────

export type ExportOptions = {
  scope: "all" | "deck" | "group" | "note";
  groupKeys?: string[];
  deckPath?: string;
  noteKey?: string;
  includeScheduling: boolean;
  includeRevlog: boolean;
  mcqStrategy: "convert-to-basic" | "skip";
  defaultDeckName: string;
  includeMedia: boolean;
  onProgress?: (pct: number, message: string) => void | Promise<void>;
};

export type ExportResult = {
  apkgBytes: Uint8Array;
  stats: AnkiPackageCreateStats;
};

export type ImportOptions = {
  targetFolder: string;
  preserveScheduling?: boolean;
  groupMapping?: "tags-only" | "deck-as-group";
  duplicateStrategy: "allow" | "skip" | "import-anyway";
  importScheduling?: boolean;
  fieldMappings?: ModelFieldMapping[];
  onProgress?: (pct: number, message: string) => void | Promise<void>;
};

export type ImportPreview = AnkiPackagePreview;

export type ImportResult = {
  imported: number;
  skipped: number;
  duplicates: number;
  ioSkipped: number;
  otherSkipped: number;
  filesCreated: string[];
  warnings: string[];
};

/**
 * High-level export function called by AnkiExportModal.
 */
export async function exportToApkg(
  plugin: LearnKitPlugin,
  options: ExportOptions,
): Promise<ExportResult> {
  const store = plugin.store;
  const allCards = store.getAllCards();

  // Scope filter
  let cards = allCards;
  if (options.scope === "deck" && options.deckPath) {
    const dp = options.deckPath;
    cards = cards.filter((c) => {
      const sp = c.sourceNotePath ?? "";
      return sp.startsWith(dp + "/") || sp === dp || sp.replace(/\.md$/i, "") === dp;
    });
  } else if (options.scope === "group" && options.groupKeys?.length) {
    const gks = options.groupKeys.map((g) => g.toLowerCase());
    cards = cards.filter((c) => {
      if (!Array.isArray(c.groups)) return false;
      return gks.some((gk) =>
        c.groups!.some((g) => g.toLowerCase() === gk || g.toLowerCase().startsWith(gk + "/")),
      );
    });
  } else if (options.scope === "note" && options.noteKey) {
    cards = cards.filter((c) => c.sourceNotePath === options.noteKey);
  }

  // Resolve media from vault
  const mediaMap = new Map<string, Uint8Array>();
  if (options.includeMedia && plugin.app?.vault) {
    await options.onProgress?.(5, "Scanning vault media…");
    const refs = AnkiPackage.collectMediaRefs(
      cards.flatMap((c) => [c.q, c.a, c.prompt, (c as { answer?: string }).answer, c.info, c.clozeText, c.stem]),
    );
    const readBinary = plugin.app.vault.readBinary?.bind(plugin.app.vault);
    if (readBinary) {
      const fromNotePaths = [...new Set(cards.map((c) => c.sourceNotePath).filter(Boolean))] as string[];
      for (const ref of refs) {
        let resolved = false;
        for (const notePath of fromNotePaths) {
          const file = plugin.app.metadataCache?.getFirstLinkpathDest?.(ref, notePath);
          if (file instanceof TFile) {
            try {
              const bytes = await readBinary(file);
              mediaMap.set(file.name, new Uint8Array(bytes));
              resolved = true;
              break;
            } catch {
              // skip
            }
          }
        }
        if (!resolved) {
          const file = plugin.app.vault.getAbstractFileByPath?.(ref);
          if (file instanceof TFile) {
            try {
              const bytes = await readBinary(file);
              mediaMap.set(file.name, new Uint8Array(bytes));
            } catch {
              // skip
            }
          }
        }
      }
    }
  }

  const pkg = await AnkiPackage.create({
    cards,
    states: store.data?.states,
    revlogs: store.data?.reviewLog,
    media: mediaMap,
    defaultDeckName: options.defaultDeckName,
    mcqStrategy: options.mcqStrategy,
    includeScheduling: options.includeScheduling,
    includeRevlog: options.includeRevlog,
    includeMedia: options.includeMedia,
    schedulerSettings: plugin.settings?.scheduling,
    onProgress: options.onProgress,
  });

  return {
    apkgBytes: pkg.toBytes(),
    stats: pkg.stats!,
  };
}

/**
 * High-level preview function called by AnkiImportModal.
 */
export async function previewApkg(apkgBytes: Uint8Array): Promise<ImportPreview> {
  const pkg = await AnkiPackage.read(apkgBytes);
  return pkg.preview();
}

/**
 * High-level import function called by AnkiImportModal.
 */
export async function importFromApkg(
  plugin: LearnKitPlugin,
  apkgBytes: Uint8Array,
  options: ImportOptions,
): Promise<ImportResult> {
  const pkg = await AnkiPackage.read(apkgBytes);

  // Compute hashes for duplicate detection
  const existingCardHashes = new Set<string>();
  const isSkipDupes = options.duplicateStrategy === "skip";
  if (isSkipDupes && plugin.store) {
    for (const card of plugin.store.getAllCards()) {
      const hash = computeCardContentHash(card);
      if (hash) existingCardHashes.add(hash);
    }
  }

  const importScheduling = options.preserveScheduling ?? options.importScheduling ?? true;

  const extracted = pkg.extract({
    fieldMappings: options.fieldMappings,
    groupMapping: options.groupMapping,
    duplicateStrategy: isSkipDupes ? "skip" : "allow",
    existingCardHashes,
    importScheduling,
    targetFolder: options.targetFolder,
    onProgress: options.onProgress,
  });

  // Save extracted media to vault
  await options.onProgress?.(10, "Saving media to vault…");
  const mediaFolder = `${options.targetFolder}/Attachments`;
  if (plugin.app?.vault?.createBinary && extracted.media.size > 0) {
    try {
      if (!plugin.app.vault.getAbstractFileByPath(mediaFolder)) {
        await plugin.app.vault.createFolder(mediaFolder);
      }
    } catch {
      // already exists
    }
    for (const [filename, bytes] of extracted.media) {
      const vaultPath = `${mediaFolder}/${filename}`;
      try {
        if (!plugin.app.vault.getAbstractFileByPath(vaultPath)) {
          await plugin.app.vault.createBinary(vaultPath, bytes.buffer as ArrayBuffer);
        }
      } catch {
        // skip
      }
    }
  }

  // Write deck markdown files and sync with store
  const filesCreated: string[] = [];
  const totalDecks = extracted.decks.length;
  let idx = 0;

  for (const deck of extracted.decks) {
    idx++;
    const pct = 25 + Math.round((idx / Math.max(1, totalDecks)) * 65);
    await options.onProgress?.(pct, `Writing deck ${idx}/${totalDecks}: ${deck.deckName}`);

    // Ensure folder exists
    try {
      if (!plugin.app.vault.getAbstractFileByPath(deck.targetFolder)) {
        await plugin.app.vault.createFolder(deck.targetFolder);
      }
    } catch {
      // already exists
    }

    const existingFile = plugin.app.vault.getAbstractFileByPath(deck.targetFilePath);
    let file: TFile;
    if (existingFile instanceof TFile) {
      const oldContent = await plugin.app.vault.read(existingFile);
      const combined = oldContent.trimEnd() + "\n\n" + deck.markdownContent;
      await plugin.app.vault.modify(existingFile, combined);
      file = existingFile;
    } else {
      file = await plugin.app.vault.create(deck.targetFilePath, deck.markdownContent);
    }
    filesCreated.push(file.path);

    // Sync note with store
    await syncOneFile(plugin, file);
    try {
      plugin.notifyWidgetCardsSynced?.();
    } catch {
      // non-fatal
    }

    // Restore scheduling state if requested
    if (importScheduling && plugin.store) {
      const cardsInFile = plugin.store.getAllCards().filter((c) => c.sourceNotePath === file.path);
      for (const card of cardsInFile) {
        for (const [ankiCardId, state] of Object.entries(deck.cardStates)) {
          // Match by content
          if (card.prompt === state.id || (card.prompt && card.prompt.includes(state.id)) || computeCardContentHash(card) === ankiCardId) {
            const patchedState = { ...state, id: card.id };
            plugin.store.upsertState(patchedState);
          }
        }
      }
    }
  }

  return {
    imported: extracted.imported,
    skipped: extracted.skipped,
    duplicates: extracted.duplicates,
    ioSkipped: extracted.ioSkipped,
    otherSkipped: extracted.otherSkipped,
    filesCreated,
    warnings: extracted.warnings,
  };
}

// ── Legacy Compatibility Helpers ──────────────────────────────────────────────

export function packApkg(
  sqliteBytes: Uint8Array,
  media: Map<string, Uint8Array> = new Map(),
): Uint8Array {
  return AnkiPackage.packZip(sqliteBytes, media);
}

export function unpackApkg(
  apkgBytes: Uint8Array,
): { db: Uint8Array; media: Map<string, Uint8Array> } {
  const { sqliteBytes, media } = AnkiPackage.unpackZip(apkgBytes);
  return { db: sqliteBytes, media };
}

export function describeAnkiUpgradeStub(notes: AnkiNoteRow[]): string | null {
  return (AnkiPackage as unknown as { describeAnkiUpgradeStub(n: AnkiNoteRow[]): string | null }).describeAnkiUpgradeStub(notes);
}

export function collectMediaRefs(fields: Array<string | null | undefined>): Set<string> {
  return AnkiPackage.collectMediaRefs(fields);
}

export function rewriteFieldForAnki(field: string, _mediaNames?: Set<string>): string {
  return AnkiPackage.rewriteFieldForAnki(field);
}

export function rewriteFieldForLearnKit(html: string, mediaNameMap: Map<string, string>): string {
  return AnkiPackage.rewriteFieldForLearnKit(html, mediaNameMap);
}

export async function resolveVaultMedia(
  app: App,
  refs: Set<string>,
  fromNotePaths: string[],
): Promise<Map<string, Uint8Array>> {
  const media = new Map<string, Uint8Array>();
  const readBinary = app.vault?.readBinary?.bind(app.vault);
  if (!readBinary) return media;
  const resolvedPaths = new Set<string>();

  for (const ref of refs) {
    let resolved = false;
    for (const notePath of fromNotePaths) {
      const file = app.metadataCache?.getFirstLinkpathDest?.(ref, notePath);
      if (file instanceof TFile && !resolvedPaths.has(file.path)) {
        try {
          const bytes = await readBinary(file);
          media.set(file.name, new Uint8Array(bytes));
          resolvedPaths.add(file.path);
          resolved = true;
          break;
        } catch {
          // skip
        }
      }
    }
    if (!resolved) {
      const file = app.vault?.getAbstractFileByPath?.(ref);
      if (file instanceof TFile && !resolvedPaths.has(file.path)) {
        try {
          const bytes = await readBinary(file);
          media.set(file.name, new Uint8Array(bytes));
          resolvedPaths.add(file.path);
        } catch {
          // skip
        }
      }
    }
  }
  return media;
}

export async function saveMediaToVault(
  app: App,
  media: Map<string, Uint8Array>,
  targetFolder: string,
): Promise<Map<string, string>> {
  const nameMap = new Map<string, string>();
  const mediaFolder = `${targetFolder}/Attachments`;
  if (!app.vault?.createBinary || media.size === 0) return nameMap;

  try {
    if (!app.vault.getAbstractFileByPath(mediaFolder)) {
      await app.vault.createFolder(mediaFolder);
    }
  } catch {
    // folder already exists
  }

  for (const [ankiName, bytes] of media) {
    const vaultPath = `${mediaFolder}/${ankiName}`;
    try {
      if (!app.vault.getAbstractFileByPath(vaultPath)) {
        await app.vault.createBinary(vaultPath, bytes.buffer as ArrayBuffer);
      }
      nameMap.set(ankiName, vaultPath);
    } catch {
      // skip
    }
  }
  return nameMap;
}
