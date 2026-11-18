import { describe, expect, test } from "bun:test";
import { INPUT_FILE_MAX } from "../../src/core/sprout";
import { goalLeaves, kindOf, linksOf, projectFilesWhy, projectForm, projectHasInput } from "./newbox";

const file = (name: string, type: string, size = 10) => ({ name, type, size });

describe("the new box", () => {
  test("a stored kind is a project only when it says so", () => {
    expect(kindOf("project")).toBe("project");
    expect(kindOf("goal")).toBe("goal");
    expect(kindOf(null)).toBe("goal");
    expect(kindOf("repo")).toBe("goal");
  });

  test("a project takes audio, images, pdf, text and markdown under the size, and says which file it cannot take", () => {
    expect(projectFilesWhy([])).toBeNull();
    expect(projectFilesWhy([file("memo.m4a", "audio/mp4"), file("shot.png", "image/png"), file("notes.md", "")])).toBeNull();
    expect(projectFilesWhy([file("build.zip", "application/zip")])).toBe(
      "A project cannot take this file: build.zip is not audio, an image, a pdf, text or markdown. Remove it, or start a goal.",
    );
    const two = projectFilesWhy([file("a.zip", "application/zip"), file("big.png", "image/png", INPUT_FILE_MAX + 1)]);
    expect(two).toStartWith("A project cannot take these files: a.zip is not audio");
    expect(two).toContain("big.png is over");
    expect(two).toEndWith("Remove them, or start a goal.");
    // five files at the limit each come to more than a project takes in all
    expect(projectFilesWhy(Array.from({ length: 5 }, (_, i) => file(`p${i}.png`, "image/png", INPUT_FILE_MAX)))).toStartWith("The files come to");
  });

  test("the goal side says what of the project side it leaves, and nothing when there is none", () => {
    expect(goalLeaves("", "  ")).toBeNull();
    expect(goalLeaves("https://a.example", "")).toBe("A goal does not take the link from the project side; put a link in the words, or name a repo with @.");
    expect(goalLeaves("https://a.example\nhttps://b.example", "https://git.example/x")).toBe(
      "A goal does not take the 2 links or the repo url from the project side; put a link in the words, or name a repo with @.",
    );
  });

  test("the project's form carries the words, each link, the repo and each file, as the intake sheet's did", () => {
    const memo = new File(["x"], "memo.m4a", { type: "audio/mp4" });
    const form = projectForm({ text: "a shop", links: " https://a.example\nhttps://b.example ", repo: " https://git.example/x ", files: [memo] });
    expect(form.get("text")).toBe("a shop");
    expect(form.getAll("url")).toEqual(["https://a.example", "https://b.example"]);
    expect(form.get("repo")).toBe("https://git.example/x");
    expect((form.get("file") as File).name).toBe("memo.m4a");
    expect(form.get("via")).toBe("sheet");
    const bare = projectForm({ text: "  ", links: "", repo: "", files: [] });
    expect(bare.has("text")).toBe(false);
    expect(bare.has("repo")).toBe(false);
    expect(linksOf("  ")).toEqual([]);
  });

  test("a project starts from words, a link, a file or a repo, and from nothing else", () => {
    expect(projectHasInput({ text: " ", links: "", repo: "", files: 0 })).toBe(false);
    expect(projectHasInput({ text: "x", links: "", repo: "", files: 0 })).toBe(true);
    expect(projectHasInput({ text: "", links: "https://a.example", repo: "", files: 0 })).toBe(true);
    expect(projectHasInput({ text: "", links: "", repo: "", files: 1 })).toBe(true);
    expect(projectHasInput({ text: "", links: "", repo: "https://git.example/x", files: 0 })).toBe(true);
  });
});
