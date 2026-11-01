/**
 * @file tests/sync-coordinator.test.ts
 * @summary Unit tests for the SyncCoordinator orchestrator module.
 */

import { describe, it, expect } from "vitest";
import { TFile } from "obsidian";
import {
  SyncCoordinator,
  formatSyncNotice,
  shouldSyncFile,
  parseSyncFilterQuery,
  isFilterIdMatch,
} from "../src/platform/integrations/sync/sync-coordinator";

describe("SyncCoordinator", () => {
  describe("formatSyncNotice", () => {
    it("formats empty changes correctly", () => {
      const notice = formatSyncNotice("Sync complete", {
        newCount: 0,
        updatedCount: 0,
      });
      expect(notice).toBe("Sync complete - no changes");
    });

    it("formats multiple changes correctly", () => {
      const notice = formatSyncNotice(
        "Sync complete",
        {
          newCount: 3,
          updatedCount: 1,
          deletedDisplayCount: 2,
          idsInserted: 4,
        },
        { includeDeleted: true, includeIdsInserted: true },
      );
      expect(notice).toBe("Sync complete - 3 new cards; 1 updated card; 2 cards deleted; 4 IDs inserted");
    });
  });

  describe("scope filter query", () => {
    const dummyFile = {
      path: "Notes/Cardiology/Heart.md",
    } as unknown as TFile;

    it("parses include and exclude scopes correctly", () => {
      const query = "scope:vault path:Notes/Cardiology -tag:draft -prop:status=archived";
      const { include, exclude } = parseSyncFilterQuery(query, dummyFile);

      expect(include).toContain("vault::");
      expect(include).toContain("folder::Notes/Cardiology");
      expect(exclude).toContain("tag::draft");
      expect(exclude).toContain("prop::status=archived");
    });

    it("evaluates folder matching correctly", () => {
      const mockApp = {
        metadataCache: {
          getFileCache: () => null,
        },
      } as any;

      expect(isFilterIdMatch("folder::Notes/Cardiology", dummyFile, mockApp)).toBe(true);
      expect(isFilterIdMatch("folder::Notes/Neurology", dummyFile, mockApp)).toBe(false);
      expect(isFilterIdMatch("vault::", dummyFile, mockApp)).toBe(true);
    });

    it("shouldSyncFile defaults to true when query is empty", () => {
      const mockPlugin = {
        settings: {
          indexing: {
            syncFilterQuery: "",
          },
        },
        app: {
          metadataCache: { getFileCache: () => null },
        },
      } as any;

      expect(shouldSyncFile(mockPlugin, dummyFile)).toBe(true);
    });
  });

  describe("concurrency locking", () => {
    it("coordinates sequential execution across locks", async () => {
      const events: string[] = [];

      const p1 = SyncCoordinator.withFileSyncLock("file1.md", async () => {
        events.push("p1-start");
        await new Promise((resolve) => setTimeout(resolve, 20));
        events.push("p1-end");
      });

      const p2 = SyncCoordinator.withFileSyncLock("file1.md", async () => {
        events.push("p2-start");
        events.push("p2-end");
      });

      await Promise.all([p1, p2]);

      expect(events).toEqual(["p1-start", "p1-end", "p2-start", "p2-end"]);
    });
  });
});
