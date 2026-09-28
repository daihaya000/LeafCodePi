// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import Markdown from "react-markdown";
import {
  classifyMarkdownImageSource,
  MarkdownImage,
  MarkdownImageScope,
  markdownImageUrlTransform,
} from "./MarkdownImage";

afterEach(cleanup);

describe("classifyMarkdownImageSource", () => {
  it("accepts task-local paths and Windows/file URL paths", () => {
    expect(classifyMarkdownImageSource("renders/final%20image.png")).toEqual({
      kind: "local",
      path: "renders/final image.png",
    });
    expect(classifyMarkdownImageSource("C:%5CUsers%5Cme%5Cshot.png")).toEqual({
      kind: "local",
      path: "C:\\Users\\me\\shot.png",
    });
    expect(classifyMarkdownImageSource("file:///tmp/shot.png")).toEqual({
      kind: "local",
      path: "/tmp/shot.png",
    });
  });

  it("requires explicit loading for safe external image URLs and rejects unsafe URLs", () => {
    expect(classifyMarkdownImageSource("https://images.example/render.png?size=large")).toMatchObject({
      kind: "remote",
      host: "images.example",
    });
    expect(classifyMarkdownImageSource("https://user:pass@example.com/x.png").kind).toBe("invalid");
    expect(classifyMarkdownImageSource("//example.com/x.png").kind).toBe("invalid");
    expect(classifyMarkdownImageSource("\\\\server\\share\\x.png").kind).toBe("invalid");
    expect(classifyMarkdownImageSource("/\\\\server\\share\\x.png").kind).toBe("invalid");
    expect(classifyMarkdownImageSource("data:image/png;base64,AAAA").kind).toBe("invalid");
    expect(classifyMarkdownImageSource("javascript:alert(1)").kind).toBe("invalid");
  });

  it("preserves image paths while retaining the default link URL sanitizer", () => {
    expect(markdownImageUrlTransform("C:%5Cimages%5Cshot.png", "src")).toBe("C:%5Cimages%5Cshot.png");
    expect(markdownImageUrlTransform("javascript:alert(1)", "src")).toBe("");
    expect(markdownImageUrlTransform("javascript:alert(1)", "href")).toBe("");
  });
});

describe("MarkdownImage", () => {
  it("renders local Markdown images through the task image endpoint", () => {
    render(
      <MarkdownImageScope taskId="task-1">
        <Markdown components={{ img: MarkdownImage }} urlTransform={markdownImageUrlTransform}>
          {"![render](renders/final%20image.png)"}
        </Markdown>
      </MarkdownImageScope>,
    );
    expect(screen.getByRole("img", { name: "render" }).getAttribute("src")).toBe(
      "/api/tasks/task-1/image?path=renders%2Ffinal%20image.png",
    );
  });

  it("does not load an external image until the user clicks", () => {
    render(
      <MarkdownImageScope taskId="task-1">
        <Markdown components={{ img: MarkdownImage }} urlTransform={markdownImageUrlTransform}>
          {"![preview](https://images.example/render.png)"}
        </Markdown>
      </MarkdownImageScope>,
    );
    expect(screen.queryByRole("img", { name: "preview" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "外部画像を読み込む: images.example" }));
    expect(screen.getByRole("img", { name: "preview" }).getAttribute("src")).toBe(
      "https://images.example/render.png",
    );
  });
});
