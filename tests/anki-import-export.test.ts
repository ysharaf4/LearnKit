/**
 * @file tests/anki-import-export.test.ts
 * @summary Integration tests for anki import/export modal adapters.
 */

import { describe, it, expect, vi } from "vitest";
import { TFile } from "obsidian";

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

vi.mock("../src/platform/integrations/sync/sync-engine", () => {
  return {
    syncOneFile: vi.fn(async () => ({
      idsInserted: 0,
      anchorsRemoved: 0,
      newCount: 1,
      updatedCount: 0,
      sameCount: 0,
      quarantinedCount: 0,
      quarantinedIds: [],
      removed: 0,
      tagsDeleted: 0,
    })),
  };
});

import { importFromApkg, exportToApkg, AnkiPackage } from "../src/platform/integrations/anki/anki-package";

class MemoryVault {
  files = new Map<string, { file: TFile; content: string }>();
  configDir = ".obsidian";
  adapter: unknown = null;

  getAbstractFileByPath(path: string) {
    return this.files.get(path)?.file || null;
  }

  async read(file: TFile): Promise<string> {
    return this.files.get(file.path)?.content || "";
  }

  async modify(file: TFile, content: string): Promise<void> {
    this.files.set(file.path, { file, content });
  }

  async create(path: string, content: string): Promise<TFile> {
    const file = new TFile();
    file.path = path;
    file.name = path.split("/").pop() || "";
    file.basename = file.name.replace(/\.md$/i, "");
    file.extension = file.name.split(".").pop() || "";
    this.files.set(path, { file, content });
    return file;
  }

  async createFolder(_path: string): Promise<void> {}
}

function makePlugin(vault: MemoryVault) {
  return {
    app: { vault },
    manifest: { id: "" },
    store: {
      getAllCards: () => [],
    },
    settings: { scheduler: { learningStepsMinutes: [10], relearningStepsMinutes: [], requestRetention: 0.9 } },
    notifyWidgetCardsSynced: vi.fn(),
  } as any;
}

describe("anki import/export pipelines", () => {
  it("imports a basic note into markdown", async () => {
    const createdPkg = await AnkiPackage.create({
      cards: [
        {
          id: "card-1",
          type: "basic",
          q: "Front",
          a: "Back",
          info: "Extra",
          groups: ["Deck/Sub"],
          sourceNotePath: "Deck/Sub.md",
        },
      ],
      defaultDeckName: "Deck::Sub",
    });

    const vault = new MemoryVault();
    const plugin = makePlugin(vault);

    const res = await importFromApkg(plugin, createdPkg.toBytes(), {
      targetFolder: "Anki Import",
      preserveScheduling: false,
      groupMapping: "deck-as-group",
      duplicateStrategy: "skip",
    });

    expect(res.imported).toBe(1);
    expect(res.filesCreated.length).toBe(1);

    const createdPath = res.filesCreated[0];
    const file = vault.getAbstractFileByPath(createdPath) as TFile;
    const content = await vault.read(file);
    expect(content).toContain("Q|");
    expect(content).toContain("A|");
  });

  it("exports cards to apkg bytes", async () => {
    const plugin: any = {
      app: { vault: new MemoryVault() },
      settings: { scheduler: { learningStepsMinutes: [10], relearningStepsMinutes: [], requestRetention: 0.9 } },
      store: {
        getAllCards: () => [
          {
            id: "1",
            type: "basic",
            title: null,
            q: "Q",
            a: "A",
            info: null,
            groups: ["Deck"],
            sourceNotePath: "Notes/Deck.md",
            sourceStartLine: 1,
            createdAt: 1,
            updatedAt: 2,
          },
        ],
        getState: () => null,
        data: {
          reviewLog: [
            { id: "1", at: 1000, prevDue: 0, nextDue: 86400000, result: "good", meta: null },
          ],
        },
      },
    };

    const res = await exportToApkg(plugin, {
      scope: "all",
      includeScheduling: false,
      includeRevlog: true,
      mcqStrategy: "convert-to-basic",
      defaultDeckName: "Default",
      includeMedia: false,
    });

    expect(res.apkgBytes).toBeInstanceOf(Uint8Array);
    expect(res.apkgBytes.length).toBeGreaterThan(100);
    expect(res.stats.notesExported).toBe(1);
    expect(res.stats.cardsExported).toBe(1);
    expect(res.stats.revlogEntries).toBe(1);
  });
});
