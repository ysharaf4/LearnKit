/** @vitest-environment jsdom */
import { describe, it, expect } from "vitest";
import { parseLearnKitCard, type LearnKitCard } from "../src/views/reading/reading-helpers";
import { buildFlashcardContentHTML } from "../src/views/reading/reading-view";
import { bindAudioPlayingState, markAudioButtonActive, clearActiveAudioButton } from "../src/platform/integrations/audio/audio-player";

describe("Reading View Flashcard Audio Button", () => {
  it("parses AU field into card.audioRef", () => {
    const markdown = `^learnkit-123456789
Q | Bonjour |
A | Hello |
AU | audio/bonjour.mp3 |
`;
    const card = parseLearnKitCard(markdown);
    expect(card).not.toBeNull();
    expect(card?.audioRef).toBe("audio/bonjour.mp3");
    expect(card?.fields.AU).toBe("audio/bonjour.mp3");
  });

  it("parses AU field with wikilink format ![[...]]", () => {
    const markdown = `^learnkit-987654321
Q | Hund |
A | Dog |
AU | ![[hund.mp3]] |
`;
    const card = parseLearnKitCard(markdown);
    expect(card).not.toBeNull();
    expect(card?.audioRef).toBe("![[hund.mp3]]");
  });

  it("renders audio button on front and back when card has audioRef", () => {
    const card: LearnKitCard = {
      anchorId: "123456",
      type: "basic",
      title: "French",
      audioRef: "audio/bonjour.mp3",
      fields: {
        Q: "Bonjour",
        A: "Hello",
        AU: "audio/bonjour.mp3",
      },
    };

    const html = buildFlashcardContentHTML(card, {
      includeSpeakerButton: true,
      includeEditButton: true,
    });

    expect(html).toContain("learnkit-flashcard-speak-btn");
    expect(html).toContain('data-learnkit-tts-side="front"');
    expect(html).toContain('data-learnkit-tts-side="back"');
    expect(html).toContain(`data-learnkit-audio-ref="${encodeURIComponent("audio/bonjour.mp3")}"`);
    expect(html).toContain('aria-label="Read aloud"');
    expect(html).toContain("lucide-volume-2");
  });

  it("omits audio button when card has no audio attachment", () => {
    const card: LearnKitCard = {
      anchorId: "654321",
      type: "basic",
      title: "Math",
      fields: {
        Q: "2 + 2",
        A: "4",
      },
    };

    const html = buildFlashcardContentHTML(card, {
      includeSpeakerButton: true,
      includeEditButton: true,
    });

    expect(html).not.toContain("learnkit-flashcard-speak-btn");
  });

  it("omits audio button when includeSpeakerButton is false even if card has audio", () => {
    const card: LearnKitCard = {
      anchorId: "112233",
      type: "basic",
      title: "Spanish",
      audioRef: "audio/hola.mp3",
      fields: {
        Q: "Hola",
        A: "Hello",
        AU: "audio/hola.mp3",
      },
    };

    const html = buildFlashcardContentHTML(card, {
      includeSpeakerButton: false,
      includeEditButton: true,
    });

    expect(html).not.toContain("learnkit-flashcard-speak-btn");
  });

  it("bindAudioPlayingState provides animated sound wave and stop icon on button", () => {
    const btn = document.createElement("button");
    btn.className = "learnkit-flashcard-speak-btn";
    btn.innerHTML = `<svg class="speaker-icon"></svg>`;
    document.body.appendChild(btn);

    bindAudioPlayingState(btn);

    const idle = btn.querySelector(".tts-icon-idle");
    const wave = btn.querySelector(".learnkit-sound-wave");
    const bars = btn.querySelectorAll(".learnkit-sound-bar");
    const stop = btn.querySelector(".tts-icon-stop");

    expect(idle).not.toBeNull();
    expect(wave).not.toBeNull();
    expect(bars.length).toBe(3);
    expect(bars[0].classList.contains("bar-1")).toBe(true);
    expect(bars[0].classList.contains("learnkit-sound-bar-1")).toBe(true);
    expect(bars[1].classList.contains("bar-2")).toBe(true);
    expect(bars[2].classList.contains("bar-3")).toBe(true);
    expect(stop).not.toBeNull();

    // Mark active
    markAudioButtonActive(btn);
    expect(btn.classList.contains("is-audio-playing")).toBe(true);
    expect(btn.getAttribute("aria-label")).toBe("Stop playing");

    // Clear active
    clearActiveAudioButton();
    expect(btn.classList.contains("is-audio-playing")).toBe(false);
    expect(btn.getAttribute("aria-label")).toBe("Read aloud");

    btn.remove();
  });

  it("bindAudioPlayingState automatically populates volume-2 speaker SVG when button has no children", () => {
    const btn = document.createElement("button");
    btn.className = "learnkit-flashcard-speak-btn";
    document.body.appendChild(btn);

    bindAudioPlayingState(btn);

    const idle = btn.querySelector(".tts-icon-idle");
    expect(idle).not.toBeNull();
    const svg = idle?.querySelector("svg");
    expect(svg).not.toBeNull();
    expect(svg?.getAttribute("class")).toContain("lucide-volume-2");

    btn.remove();
  });

  it("activates wave animation when R key is pressed on speak button", () => {
    const btn = document.createElement("button");
    btn.className = "learnkit-flashcard-speak-btn";
    document.body.appendChild(btn);

    bindAudioPlayingState(btn);

    let clicked = false;
    btn.addEventListener("click", () => {
      clicked = true;
      markAudioButtonActive(btn);
    });

    btn.addEventListener("keydown", (ev) => {
      if (ev.key !== "Enter" && ev.key !== " " && ev.key.toLowerCase() !== "r") return;
      ev.preventDefault();
      btn.click();
    });

    // Press 'r'
    btn.dispatchEvent(new KeyboardEvent("keydown", { key: "r", bubbles: true }));
    expect(clicked).toBe(true);
    expect(btn.classList.contains("is-audio-playing")).toBe(true);

    clearActiveAudioButton();
    expect(btn.classList.contains("is-audio-playing")).toBe(false);
    btn.remove();
  });

  it("marks all matching buttons across faces active when audio plays", () => {
    const frontBtn = document.createElement("button");
    frontBtn.className = "learnkit-flashcard-speak-btn";
    const backBtn = document.createElement("button");
    backBtn.className = "learnkit-flashcard-speak-btn";

    document.body.appendChild(frontBtn);
    document.body.appendChild(backBtn);

    markAudioButtonActive(frontBtn);
    markAudioButtonActive(backBtn);

    expect(frontBtn.classList.contains("is-audio-playing")).toBe(true);
    expect(backBtn.classList.contains("is-audio-playing")).toBe(true);
    expect(frontBtn.querySelector(".learnkit-sound-wave")).not.toBeNull();
    expect(backBtn.querySelector(".learnkit-sound-wave")).not.toBeNull();

    clearActiveAudioButton();
    expect(frontBtn.classList.contains("is-audio-playing")).toBe(false);
    expect(backBtn.classList.contains("is-audio-playing")).toBe(false);

    frontBtn.remove();
    backBtn.remove();
  });
});
