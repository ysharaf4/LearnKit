/**
 * @file tests/anki-apkg-modern.test.ts
 * @summary Pins how an .apkg is unpacked across Anki export formats.
 *
 * A 2.1.62+ export carries the real collection in `collection.anki21b`
 * (zstd-compressed) *and* a legacy `collection.anki2` that holds nothing but
 * Anki's "Please update to the latest Anki version" note. Picking the wrong
 * entry, or failing to inflate zstd, imports that placeholder as a card - which
 * is exactly the symptom this suite exists to prevent regressing.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { zipSync, strToU8 } from "fflate";
import { decompress as zstdInflate } from "fzstd";

import { packApkg, unpackApkg, describeAnkiUpgradeStub } from "../src/platform/integrations/anki/anki-package";
import type { AnkiNoteRow } from "../src/platform/integrations/anki/anki-constants";

const SQLITE_MAGIC = "SQLite format 3\0";

/** Enough of a SQLite file for the decoder to accept it. */
function sqliteish(body: string): Uint8Array {
  return strToU8(SQLITE_MAGIC + body);
}

/**
 * A real zstd frame of `SQLite format 3\0REAL-COLLECTION`, generated once with
 * Node's zstd encoder and committed as a binary fixture.
 *
 * Node only gained `zlib.zstdCompressSync` in 22.15, so compressing at test time
 * would fail on the Node 20 that CI runs - and what matters is that the *reader*
 * inflates what Anki writes, not that this machine can write zstd. `fzstd`
 * inflates the fixture at run time, exactly as the importer does.
 */
const ZSTD_FIXTURE_PATH = path.join(__dirname, "fixtures", "collection.anki21b.zst");
const ZSTD_PLAINTEXT = "SQLite format 3\0REAL-COLLECTION";

function zstdFixture(): Uint8Array {
  return new Uint8Array(fs.readFileSync(ZSTD_FIXTURE_PATH));
}

function noteRow(flds: string): AnkiNoteRow {
  return {
    id: 1,
    guid: "g",
    mid: 1,
    mod: 0,
    usn: -1,
    tags: "",
    flds,
    sfld: "",
    csum: 0,
    flags: 0,
    data: "",
  };
}

describe("unpackApkg across Anki export formats", () => {
  it("carries a valid zstd fixture", () => {
    const inflated = zstdInflate(zstdFixture());
    expect(Buffer.from(inflated).toString("binary")).toBe(ZSTD_PLAINTEXT);
  });

  it("prefers the zstd collection over the legacy placeholder entry", () => {
    const real = strToU8(ZSTD_PLAINTEXT);
    const apkg = zipSync({
      // Deliberately listed first: the stub used to win because the old code
      // took the first matching name in ZIP order.
      "collection.anki2": sqliteish("PLACEHOLDER"),
      "collection.anki21b": zstdFixture(),
      media: strToU8("{}"),
    });

    const { db } = unpackApkg(apkg);
    expect(Array.from(db)).toEqual(Array.from(real));
  });

  it("prefers collection.anki21 over collection.anki2", () => {
    const modern = sqliteish("V18");
    const apkg = zipSync({
      "collection.anki2": sqliteish("V11"),
      "collection.anki21": modern,
    });

    const { db } = unpackApkg(apkg);
    expect(Array.from(db)).toEqual(Array.from(modern));
  });

  it("still reads a legacy .apkg that only has collection.anki2", () => {
    const legacy = sqliteish("V11-ONLY");
    const { db } = unpackApkg(packApkg(legacy));
    expect(Array.from(db)).toEqual(Array.from(legacy));
  });

  it("reads media from a modern archive as well", () => {
    const image = new Uint8Array([1, 2, 3, 4]);
    const apkg = zipSync({
      "collection.anki21b": zstdFixture(),
      media: strToU8(JSON.stringify({ 0: "pic.png" })),
      0: image,
    });

    const { media } = unpackApkg(apkg);
    expect(media.get("pic.png")).toEqual(image);
  });

  it("fails loudly when the zstd collection is unreadable, instead of importing the placeholder", () => {
    const apkg = zipSync({
      "collection.anki21b": strToU8("not a zstd frame"),
      "collection.anki2": sqliteish("PLACEHOLDER"),
    });

    expect(() => unpackApkg(apkg)).toThrow(/collection\.anki21b/);
  });

  it("rejects an archive with no collection database", () => {
    const apkg = zipSync({ media: strToU8("{}") });
    expect(() => unpackApkg(apkg)).toThrow(/no \.anki2 database found/);
  });
});

describe("describeAnkiUpgradeStub", () => {
  it("explains a lone Anki placeholder note", () => {
    const reason = describeAnkiUpgradeStub([
      noteRow("Please update to the latest Anki version, then import the .colpkg/.apkg file again."),
    ]);
    expect(reason).toMatch(/placeholder note/);
  });

  it("ignores a real deck", () => {
    expect(describeAnkiUpgradeStub([noteRow("Q\uff5c Capital of France \uff5cA\uff5c Paris")])).toBeNull();
  });

  it("ignores a deck that merely mentions the sentence", () => {
    expect(
      describeAnkiUpgradeStub([
        noteRow("Q\uff5c What does Anki say to update to the latest Anki version? \uff5cA\uff5c That."),
        noteRow("Q\uff5c Second card \uff5cA\uff5c Yes"),
      ]),
    ).toBeNull();
  });

  it("ignores an empty collection", () => {
    expect(describeAnkiUpgradeStub([])).toBeNull();
  });
});
