/**
 * @file tests/derived-card-generator.test.ts
 * @summary Unit tests for the pure DerivedCardGenerator module.
 */

import { describe, it, expect } from "vitest";
import { DerivedCardGenerator } from "../src/platform/integrations/sync/derived-card-generator";
import type { CardRecord } from "../src/platform/types/card";

describe("DerivedCardGenerator", () => {
  it("generates cloze child cards from parent cloze indices", () => {
    const parent: CardRecord = {
      id: "parent-cloze-1",
      type: "cloze",
      title: "Chemistry",
      clozeText: "Water boils at {{c1::100}} C at {{c2::1 atm}}.",
      sourceNotePath: "Notes/Chem.md",
      sourceStartLine: 1,
      createdAt: 1000,
      updatedAt: 1000,
    };

    const children = DerivedCardGenerator.generateChildren(parent, 2000);
    expect(children.length).toBe(2);
    expect(children[0].id).toBe("parent-cloze-1::cloze::c1");
    expect(children[0].type).toBe("cloze-child");
    expect(children[0].clozeIndex).toBe(1);
    expect(children[1].id).toBe("parent-cloze-1::cloze::c2");
    expect(children[1].type).toBe("cloze-child");
    expect(children[1].clozeIndex).toBe(2);
  });

  it("generates forward and back reversed child cards", () => {
    const parent: CardRecord = {
      id: "parent-rev-1",
      type: "reversed",
      title: "French",
      q: "bonjour",
      a: "hello",
      sourceNotePath: "Notes/French.md",
      sourceStartLine: 1,
      createdAt: 1000,
      updatedAt: 1000,
    };

    const children = DerivedCardGenerator.generateChildren(parent, 2000);
    expect(children.length).toBe(2);
    expect(children[0].id).toBe("parent-rev-1::reversed::forward");
    expect(children[0].q).toBe("bonjour");
    expect(children[0].a).toBe("hello");
    expect(children[1].id).toBe("parent-rev-1::reversed::back");
    expect(children[1].q).toBe("hello");
    expect(children[1].a).toBe("bonjour");
  });

  it("generates IO child cards from stored occlusion rects", () => {
    const parent: CardRecord = {
      id: "parent-io-1",
      type: "io",
      title: "Anatomy Heart",
      imageRef: "LK-IO-Heart.png",
      sourceNotePath: "Notes/Heart.md",
      sourceStartLine: 1,
      createdAt: 1000,
      updatedAt: 1000,
    };

    const ioDef = {
      imageRef: "LK-IO-Heart.png",
      maskMode: "solo" as const,
      rects: [
        { rectId: "r1", x: 10, y: 10, w: 50, h: 50, groupKey: "aorta", shape: "rect" as const },
        { rectId: "r2", x: 70, y: 70, w: 50, h: 50, groupKey: "ventricle", shape: "rect" as const },
      ],
    };

    const children = DerivedCardGenerator.generateChildren(parent, 2000, {
      ioDefinitions: { "parent-io-1": ioDef },
    });

    expect(children.length).toBe(2);
    expect(children.some((c) => c.groupKey === "aorta")).toBe(true);
    expect(children.some((c) => c.groupKey === "ventricle")).toBe(true);
  });
});
