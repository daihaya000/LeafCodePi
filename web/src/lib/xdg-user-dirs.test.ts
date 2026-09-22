import { describe, expect, it } from "vitest";
import { parseXdgUserDirsFile, readXdgUserDirs } from "./xdg-user-dirs";

const SAMPLE = `
# This file is written by xdg-user-dirs-update
XDG_DESKTOP_DIR="$HOME/デスクトップ"
XDG_DOWNLOAD_DIR="$HOME/ダウンロード"
XDG_TEMPLATES_DIR="$HOME/テンプレート"
XDG_PUBLICSHARE_DIR="$HOME/公開"
XDG_DOCUMENTS_DIR="$HOME/ドキュメント"
XDG_MUSIC_DIR="$HOME/ミュージック"
XDG_PICTURES_DIR="$HOME/ピクチャ"
XDG_VIDEOS_DIR="$HOME/ビデオ"
`;

describe("parseXdgUserDirsFile", () => {
  it("expands $HOME and keeps the user-dir folders we care about", () => {
    expect(parseXdgUserDirsFile(SAMPLE, "/home/me")).toEqual({
      desktop: "/home/me/デスクトップ",
      documents: "/home/me/ドキュメント",
      downloads: "/home/me/ダウンロード",
      pictures: "/home/me/ピクチャ",
    });
  });

  it("accepts quoted values and ignores comments or unknown keys", () => {
    expect(
      parseXdgUserDirsFile(
        `XDG_DESKTOP_DIR="/home/me/Desktop"\n# skip\nXDG_VIDEOS_DIR="$HOME/Videos"\n`,
        "/home/me",
      ),
    ).toEqual({ desktop: "/home/me/Desktop" });
  });

  it("decodes xdg-user-dirs shell-escaped spaces", () => {
    expect(
      parseXdgUserDirsFile('XDG_DOCUMENTS_DIR="$HOME/My\\040Documents"\n', "/home/me"),
    ).toEqual({ documents: "/home/me/My Documents" });
  });
});

describe("readXdgUserDirs", () => {
  it("lets the config file override environment values", () => {
    expect(
      readXdgUserDirs({
        home: "/home/me",
        configPath: "/tmp/user-dirs.dirs",
        env: { XDG_DESKTOP_DIR: "$HOME/Desktop" },
        readFile: () => 'XDG_DESKTOP_DIR="$HOME/デスクトップ"\n',
      }),
    ).toEqual({ desktop: "/home/me/デスクトップ" });
  });

  it("falls back to env when the file is missing", () => {
    expect(
      readXdgUserDirs({
        home: "/home/me",
        configPath: "/missing/user-dirs.dirs",
        env: { XDG_DOWNLOAD_DIR: "$HOME/Downloads" },
        readFile: () => {
          throw new Error("ENOENT");
        },
      }),
    ).toEqual({ downloads: "/home/me/Downloads" });
  });
});
