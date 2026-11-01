/**
 * @file tests/anki-sql-real.test.ts
 * @summary End-to-end Anki .apkg round-trip through the REAL sql.js WASM path.
 *
 * Every other SQLite suite mocks `anki-sql` wholesale, so nothing exercised the
 * thing that actually ships: inflate the deflated WASM that is inlined in
 * main.js, hand it to initSqlJs, build a schema-v11 database, write an .apkg,
 * read it back.
 *
 * tests/setup-vitest.ts mocks `sql.js/dist/sql-wasm.wasm` with an empty
 * Uint8Array because Vitest cannot import a raw .wasm. This file overrides that
 * mock with the *real* binary, deflated exactly the way
 * tooling/esbuild.config.js deflates it at build time. So if the build stops
 * deflating, or anki-sql stops inflating, or the codec pairing changes, this
 * fails instead of silently producing an unopenable database.
 */

import { describe, it, expect, vi } from "vitest";

// Override setup-vitest.ts's empty-Uint8Array mock with the real deflated binary.
vi.mock("sql.js/dist/sql-wasm.wasm", async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const zlib = await import("node:zlib");
  const raw = new Uint8Array(
    fs.readFileSync(path.resolve(process.cwd(), "node_modules/sql.js/dist/sql-wasm.wasm")),
  );
  return {
    default: new Uint8Array(zlib.deflateSync(raw, { level: zlib.constants.Z_BEST_COMPRESSION })),
  };
});

import {
  getSqlJs,
  createEmptyAnkiDb,
  insertCollection,
  insertNote,
  insertCard,
  readNotes,
  readCards,
  readCollectionCrt,
} from "../src/platform/integrations/anki/anki-sql";
import { packApkg, unpackApkg } from "../src/platform/integrations/anki/anki-package";
import type { AnkiNoteRow, AnkiCardRow } from "../src/platform/integrations/anki/anki-constants";

const EXPECTED_FLDS = "Front text\u001fBack text";
const NOTE_ID = 1700000000001;

function makeNote(): AnkiNoteRow {
  return {
    id: NOTE_ID,
    guid: "guidlearnkit0001",
    mid: 1,
    mod: 1700000000,
    usn: -1,
    tags: " learnkit test",
    flds: EXPECTED_FLDS,
    sfld: "Front text",
    csum: 123456,
    flags: 0,
    data: "",
  };
}

function makeCard(): AnkiCardRow {
  return {
    id: 1700000000002,
    nid: NOTE_ID,
    did: 1,
    ord: 0,
    mod: 1700000000,
    usn: -1,
    type: 0,
    queue: 0,
    due: 1,
    ivl: 0,
    factor: 2500,
    reps: 0,
    lapses: 0,
    left: 0,
    odue: 0,
    odid: 0,
    flags: 0,
    data: "",
  };
}

describe("Anki .apkg round-trip through the real sql.js WASM", () => {
  it("initialises sql.js from the deflated WASM inlined in main.js", async () => {
    const SQL = await getSqlJs();
    expect(SQL).toBeTruthy();
    // Proves the WASM actually instantiated, not just that a promise resolved.
    const db = new SQL.Database();
    try {
      const res = db.exec("SELECT sqlite_version();");
      expect(String(res[0].values[0][0])).toMatch(/^\d+\.\d+\.\d+$/);
    } finally {
      db.close();
    }
  });

  it("creates the Anki schema v11 and round-trips a note and card", async () => {
    const db = await createEmptyAnkiDb();
    try {
      insertCollection(db, { creationTimestamp: 1700000000 });
      insertNote(db, makeNote());
      insertCard(db, makeCard());

      const notes = readNotes(db);
      expect(notes).toHaveLength(1);
      expect(notes[0].flds).toBe(EXPECTED_FLDS);
      expect(notes[0].guid).toBe("guidlearnkit0001");

      const cards = readCards(db);
      expect(cards).toHaveLength(1);
      expect(cards[0].nid).toBe(NOTE_ID);

      expect(readCollectionCrt(db)).toBe(1700000000);
    } finally {
      db.close();
    }
  });

  it("survives packApkg -> unpackApkg and reopens with the note intact", async () => {
    const db = await createEmptyAnkiDb();
    insertCollection(db, { creationTimestamp: 1700000000 });
    insertNote(db, makeNote());
    insertCard(db, makeCard());
    const sqliteBytes = db.export();
    db.close();

    // Write an .apkg (real fflate zip) ...
    const apkg = packApkg(new Uint8Array(sqliteBytes));
    expect(apkg.length).toBeGreaterThan(0);

    // ... and read it back the way the importer does.
    const { db: dbBytes, media } = unpackApkg(apkg);
    expect(dbBytes.length).toBeGreaterThan(0);
    expect(media.size).toBe(0);

    const SQL = await getSqlJs();
    const reopened = new SQL.Database(dbBytes);
    try {
      const notes = readNotes(reopened);
      expect(notes).toHaveLength(1);
      expect(notes[0].flds).toBe(EXPECTED_FLDS);
      expect(readCards(reopened)).toHaveLength(1);
    } finally {
      reopened.close();
    }
  });

  it("carries media through the archive unchanged", async () => {
    const db = await createEmptyAnkiDb();
    insertCollection(db, { creationTimestamp: 1700000000 });
    const bytes = new Uint8Array(db.export());
    db.close();

    const media = new Map<string, Uint8Array>([
      ["front.png", new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])],
    ]);
    const { media: out } = unpackApkg(packApkg(bytes, media));

    expect(out.size).toBe(1);
    expect(Array.from(out.get("front.png")!)).toEqual([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
  });
});
