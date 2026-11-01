// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import * as obsidian from "obsidian";
import { parseCardsFromText } from "../src/engine/parser/parser";
import { buildCardBlockMarkdown } from "../src/views/reviewer/markdown-block";
import { formatAttachmentChipLabel } from "../src/views/shared/attachment-chip-label";
import { applyValueToCard, readCardField } from "../src/views/browser/data/browser-card-data";
import { createAudioPickerField } from "../src/platform/card-editor/card-editor";
import type { CardRecord } from "../src/platform/types/card";

describe("Audio Attachment Feature", () => {
  describe("Parser: AU pipe-field", () => {
    it("parses AU field from markdown card", () => {
      const markdown = `^learnkit-123456789
Q | What is bonjour? |
A | Hello |
AU | audio/bonjour.mp3 |
`;
      const { cards } = parseCardsFromText("notes/french.md", markdown);
      expect(cards.length).toBe(1);
      expect(cards[0].id).toBe("123456789");
      expect(cards[0].type).toBe("basic");
      expect(cards[0].q).toBe("What is bonjour?");
      expect(cards[0].a).toBe("Hello");
      expect(cards[0].audioRef).toBe("audio/bonjour.mp3");
    });

    it("parses AU field with wikilink format", () => {
      const markdown = `^learnkit-987654321
Q | German for dog? |
A | Hund |
AU | ![[hund.mp3]] |
`;
      const { cards } = parseCardsFromText("notes/german.md", markdown);
      expect(cards.length).toBe(1);
      expect(cards[0].audioRef).toBe("![[hund.mp3]]");
    });
  });

  describe("Serializer: buildCardBlockMarkdown", () => {
    it("serializes audioRef to AU field in markdown block", () => {
      const card: CardRecord = {
        id: "learnkit-abcde",
        type: "basic",
        title: null,
        q: "What is bonjour?",
        a: "Hello",
        audioRef: "audio/bonjour.mp3",
        info: null,
        groups: null,
        sourceNotePath: "notes/french.md",
        sourceStartLine: 0,
      };

      const lines = buildCardBlockMarkdown(card.id, card);
      const text = lines.join("\n");
      expect(text).toContain("AU | audio/bonjour.mp3 |");
    });

    it("round-trips parse -> serialize -> parse with audioRef", () => {
      const initialMarkdown = `^learnkit-111222333
Q | Test Question |
A | Test Answer |
AU | media/clip.m4a |
`;
      const { cards } = parseCardsFromText("test.md", initialMarkdown);
      expect(cards[0].audioRef).toBe("media/clip.m4a");

      const cardRecord: CardRecord = {
        id: cards[0].id!,
        type: cards[0].type,
        title: cards[0].title,
        q: cards[0].q,
        a: cards[0].a,
        audioRef: cards[0].audioRef,
        sourceNotePath: "test.md",
        sourceStartLine: 0,
      };

      const serialized = buildCardBlockMarkdown(cardRecord.id, cardRecord).join("\n");
      const reparsed = parseCardsFromText("test.md", serialized);

      expect(reparsed.cards[0].audioRef).toBe("media/clip.m4a");
      expect(reparsed.cards[0].q).toBe("Test Question");
      expect(reparsed.cards[0].a).toBe("Test Answer");
    });
  });

  describe("Attachment Chip Label", () => {
    it("recognizes audio file extensions", () => {
      expect(formatAttachmentChipLabel("sound.mp3")).toBe("Audio: sound");
      expect(formatAttachmentChipLabel("recording.m4a")).toBe("Audio: recording");
      expect(formatAttachmentChipLabel("sample.wav")).toBe("Audio: sample");
      expect(formatAttachmentChipLabel("audio.ogg")).toBe("Audio: audio");
      expect(formatAttachmentChipLabel("voice.flac")).toBe("Audio: voice");
    });
  });

  describe("Browser Card Data", () => {
    it("applies and reads audioRef field", () => {
      const card: CardRecord = {
        id: "test-card",
        type: "basic",
        title: "Test",
        q: "Question",
        a: "Answer",
        audioRef: null,
        sourceNotePath: "notes/test.md",
        sourceStartLine: 1,
      };

      const updated = applyValueToCard(card, "audioRef", "vault/sound.mp3");
      expect(updated.audioRef).toBe("vault/sound.mp3");

      const cleared = applyValueToCard(updated, "audioRef", "");
      expect(cleared.audioRef).toBeNull();
    });
  });

  describe("Audio UI: Speaker Icon & Playing State", () => {
    it("uses volume-2 speaker icon for audio picker chip", () => {
      const setIconSpy = vi.spyOn(obsidian, "setIcon");
      const mockPlugin = { app: {} } as any;

      createAudioPickerField("recordings/sample.mp3", mockPlugin);

      expect(setIconSpy).toHaveBeenCalledWith(
        expect.anything(),
        "volume-2"
      );
      setIconSpy.mockRestore();
    });

    it("renders interactive preview play button and remove button on audio chip", () => {
      const mockPlugin = {
        app: {
          vault: { getAbstractFileByPath: vi.fn(), getResourcePath: vi.fn() },
          metadataCache: { getFirstLinkpathDest: vi.fn() },
        },
        settings: { audio: { rate: 1.25 } },
      } as any;

      const { element, hiddenInput } = createAudioPickerField("recordings/test.mp3", mockPlugin);
      expect(hiddenInput.value).toBe("recordings/test.mp3");

      const playBtn = element.querySelector("button[aria-label='Play preview']") as HTMLButtonElement | null;
      expect(playBtn).not.toBeNull();
      expect(playBtn?.title).toBe("Play preview");

      const removeBtn = element.querySelector("button[aria-label='Remove audio']") as HTMLButtonElement | null;
      expect(removeBtn).not.toBeNull();

      // Clicking remove should clear hidden input
      removeBtn?.click();
      expect(hiddenInput.value).toBe("");
    });

    it("bindTtsPlayingState sets up idle speaker, equalizer wave, and stop icons", async () => {
      const { bindTtsPlayingState, markTtsButtonActive, clearActiveTtsButton } = await import(
        "../src/platform/integrations/audio/audio-player"
      );

      const btn = document.createElement("button");
      btn.setAttribute("aria-label", "Read aloud");
      document.body.appendChild(btn);

      bindTtsPlayingState(btn);

      const idle = btn.querySelector(".tts-icon-idle");
      const wave = btn.querySelector(".learnkit-sound-wave");
      const bars = btn.querySelectorAll(".learnkit-sound-bar");
      const stop = btn.querySelector(".tts-icon-stop");

      expect(idle).not.toBeNull();
      expect(wave).not.toBeNull();
      expect(bars.length).toBe(3);
      expect(stop).not.toBeNull();

      // Test active playing state
      markTtsButtonActive(btn);
      expect(btn.classList.contains("is-tts-playing")).toBe(true);
      expect(btn.getAttribute("aria-label")).toBe("Stop playing");

      // Test clearing active state
      clearActiveTtsButton();
      expect(btn.classList.contains("is-tts-playing")).toBe(false);
      expect(btn.getAttribute("aria-label")).toBe("Read aloud");

      btn.remove();
    });
  });
});
