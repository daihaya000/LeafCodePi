// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { mediaFormatForPath } from "@/lib/media-formats";
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

describe("Markdown media players", () => {
  it.each(["clip.mp4", "clip.MOV", "clip.webm", "music.wav", "music.mp3", "music.m4a", "music.flac", "music.opus", "music.weba"])(
    "renders %s with controls, a download and no autoplay/preload", (path) => {
      const { container } = render(
        <MarkdownImageScope taskId="task-1">
          <Markdown components={{ img: MarkdownImage }} urlTransform={markdownImageUrlTransform}>
            {`![完成メディア](<${path}>)`}
          </Markdown>
        </MarkdownImageScope>,
      );
      const kind = mediaFormatForPath(path)!.kind;
      const player = container.querySelector(kind)!;
      expect(player).not.toBeNull();
      expect(player.getAttribute("src")).toBe(`/api/tasks/task-1/media?path=${encodeURIComponent(path)}`);
      expect(player.hasAttribute("controls")).toBe(true);
      expect(player.hasAttribute("autoplay")).toBe(false);
      expect(player.getAttribute("preload")).toBe("none");
      expect(player.getAttribute("aria-label")).toBe("完成メディア");
      expect(screen.getByRole("link", { name: "ダウンロード" }).hasAttribute("download")).toBe(true);
      expect(container.querySelector("img")).toBeNull();
    },
  );
  it("keeps a download available when the browser cannot decode media", () => {
    const { container } = render(<MarkdownImageScope taskId="task"><MarkdownImage src="music.wav" alt="音楽" /></MarkdownImageScope>);
    fireEvent.error(container.querySelector("audio")!);
    expect(screen.getByRole("alert").textContent).toContain("再生できません");
    expect(screen.getByRole("link", { name: "ダウンロード" })).not.toBeNull();
  });
  it("never fetches remote media inline and opens it only via an explicit noreferrer link", () => {
    const { container } = render(<MarkdownImage src="https://media.example/clip.mp4?token=public" alt="動画" />);
    expect(container.querySelector("video,audio,img")).toBeNull();
    const link = screen.getByRole("link", { name: "外部動画を開く: 動画" });
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
  });
  it("requires task scope for local playback and refuses prototype keys as extensions", () => {
    render(<MarkdownImage src="clip.mp4" alt="動画" />);
    expect(screen.queryByRole("link", { name: "ダウンロード" })).toBeNull();
    expect(screen.getByText("タスクの動画を表示できません")).not.toBeNull();
    expect(mediaFormatForPath("file.constructor")).toBeUndefined();
  });
});
