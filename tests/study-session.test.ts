import { describe, it, expect, vi, beforeEach } from "vitest";
import { StudySession } from "../src/engine/study-session/study-session";
import { JsonStore } from "../src/platform/core/store";
import type { CardRecord } from "../src/platform/types/card";
import type { CardState } from "../src/platform/types/scheduler";
import type { Scope } from "../src/views/reviewer/types";

function makeTestPlugin(
  cards: CardRecord[] = [],
  states: Record<string, CardState> = {},
) {
  const plugin: any = {
    app: { vault: { getFiles: () => [], getMarkdownFiles: () => [] } },
    manifest: { id: "learnkit" },
    settings: {
      study: {
        dailyNewLimit: Infinity,
        dailyReviewLimit: Infinity,
        treatFolderNotesAsDecks: false,
        randomizeMcqOptions: true,
      },
      indexing: { ignoreInCodeFences: false },
    },
    saveAll: vi.fn(async () => {}),
    loadData: vi.fn(async () => ({})),
  };
  plugin.store = new JsonStore(plugin);

  for (const c of cards) plugin.store.upsertCard(c);
  for (const [id, st] of Object.entries(states)) plugin.store.upsertState(st);

  return plugin;
}

function makeCard(id: string, notePath = "Notes/A.md", type: string = "basic"): CardRecord {
  return {
    id,
    type: type as CardRecord["type"],
    title: `Card ${id}`,
    q: "Question?",
    a: "Answer!",
    sourceNotePath: notePath,
  };
}

describe("StudySession Domain Module", () => {
  const scope: Scope = { type: "vault", key: "", name: "Vault" };

  it("initializes queue from cards and resolves current card", async () => {
    const plugin = makeTestPlugin([
      makeCard("c1"),
      makeCard("c2"),
    ]);

    const session = await StudySession.start({
      scope,
      store: plugin.store,
      settings: plugin.settings,
      now: 1000,
    });

    expect(session.isComplete).toBe(false);
    expect(session.stats.total).toBe(2);
    expect(session.stats.done).toBe(0);
    expect(session.currentCard?.id).toBe("c1");
  });

  it("grades card, persists next state, appends review log and analytics, and advances", async () => {
    const plugin = makeTestPlugin([
      makeCard("c1"),
      makeCard("c2"),
    ]);

    const session = await StudySession.start({
      scope,
      store: plugin.store,
      settings: plugin.settings,
      now: 1000,
    });

    expect(session.canUndo).toBe(false);

    const gradeRes = await session.grade("good", { source: "test" }, 2500);

    expect(gradeRes.rating).toBe("good");
    expect(session.canUndo).toBe(true);
    expect(session.isAnswerRevealed).toBe(true);
    expect(session.stats.done).toBe(1);

    // Verify store mutations
    const savedState = plugin.store.getState("c1");
    expect(savedState).toBeDefined();
    expect(savedState?.stage).not.toBe("new");

    expect(plugin.store.data.reviewLog.length).toBe(1);
    expect(plugin.store.data.reviewLog[0].id).toBe("c1");
    expect(plugin.store.data.reviewLog[0].result).toBe("good");

    expect(plugin.store.data.analytics.events.length).toBe(1);
    expect((plugin.store.data.analytics.events[0] as any).msToAnswer).toBe(2500);

    // Advance to next card
    const hasNext = session.nextCard();
    expect(hasNext).toBe(true);
    expect(session.currentCard?.id).toBe("c2");
    expect(session.isAnswerRevealed).toBe(false);
  });

  it("undo restores previous scheduling state, review log, and analytics", async () => {
    const plugin = makeTestPlugin([
      makeCard("c1"),
    ]);

    const session = await StudySession.start({
      scope,
      store: plugin.store,
      settings: plugin.settings,
      now: 1000,
    });

    const prevState = plugin.store.getState("c1")?.stage;
    await session.grade("easy");

    expect(plugin.store.getState("c1")?.stage).not.toBe(prevState);
    expect(plugin.store.data.reviewLog.length).toBe(1);
    expect(plugin.store.data.analytics.events.length).toBe(1);

    const undone = await session.undo();
    expect(undone).not.toBeNull();
    expect(undone?.id).toBe("c1");

    // State reverted
    expect(plugin.store.getState("c1")?.stage).toBe(prevState ?? "new");
    expect(plugin.store.data.reviewLog.length).toBe(0);
    expect(plugin.store.data.analytics.events.length).toBe(0);
    expect(session.stats.done).toBe(0);
    expect(session.canUndo).toBe(false);
  });

  it("practice session records analytics but bypasses scheduling state and review log", async () => {
    const plugin = makeTestPlugin([
      makeCard("c1"),
    ]);

    const initialStage = plugin.store.getState("c1")?.stage ?? "new";

    const session = await StudySession.start({
      scope,
      store: plugin.store,
      settings: plugin.settings,
      practice: true,
      now: 1000,
    });

    expect(session.isPractice).toBe(true);
    await session.grade("good");

    // Scheduling state unchanged in practice mode
    expect(plugin.store.getState("c1")?.stage ?? "new").toBe(initialStage);
    expect(plugin.store.data.reviewLog.length).toBe(0);
    expect(plugin.store.data.analytics.events.length).toBe(1);
  });

  it("buryCurrent persists bury state and removes card from remaining queue", async () => {
    const plugin = makeTestPlugin([
      makeCard("c1"),
      makeCard("c2"),
    ]);

    const session = await StudySession.start({
      scope,
      store: plugin.store,
      settings: plugin.settings,
      now: 1000,
    });

    const nextState = await session.buryCurrent(1000);
    expect(nextState?.buriedUntil).toBeGreaterThan(1000);

    // Queue size decreases and moves to next card
    expect(session.currentCard?.id).toBe("c2");
    expect(session.queue.length).toBe(1);
  });

  it("suspendCurrent persists suspended stage and removes card from remaining queue", async () => {
    const plugin = makeTestPlugin([
      makeCard("c1"),
      makeCard("c2"),
    ]);

    const session = await StudySession.start({
      scope,
      store: plugin.store,
      settings: plugin.settings,
      now: 1000,
    });

    const nextState = await session.suspendCurrent(1000);
    expect(nextState?.stage).toBe("suspended");

    expect(session.currentCard?.id).toBe("c2");
    expect(session.queue.length).toBe(1);
  });

  it("skipCurrent postpones card and tracks skip count", async () => {
    const cards = Array.from({ length: 10 }, (_, i) => makeCard(`c${String(i + 1).padStart(2, "0")}`));
    const plugin = makeTestPlugin(cards);

    const session = await StudySession.start({
      scope,
      store: plugin.store,
      settings: plugin.settings,
      now: 1000,
    });

    expect(session.currentCard?.id).toBe("c01");
    const res = session.skipCurrent();

    expect(res.skipped).toBe(true);
    expect(res.promptBury).toBe(false);
    expect(res.skipCount).toBe(1);
    expect(session.currentCard?.id).toBe("c02");

    // c01 is moved towards the back of the queue
    expect(session.queue.some((c) => c.id === "c01")).toBe(true);
  });
});
