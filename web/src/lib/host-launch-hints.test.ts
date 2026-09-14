import { describe, expect, it } from "vitest";
import {
  HOST_LAUNCH_REQUIRED_HINT_ANY,
  HOST_RESTART_READY_HINT_ANY,
  hostLaunchCheckHint,
  hostLaunchRequiredHint,
  hostRestartReadyHint,
  llamaServerHostCheckHint,
} from "./host-launch-hints";

describe("host-launch-hints", () => {
  it("keeps Windows tray-host copy", () => {
    expect(hostLaunchRequiredHint("win32")).toBe("start.bat（トレイホスト）経由の起動が必要です。");
    expect(hostLaunchCheckHint("win32")).toBe(
      "start.bat（トレイホスト）経由で起動しているか確認してください",
    );
    expect(llamaServerHostCheckHint("win32")).toBe(
      "start.bat（トレイホスト）が起動しているか確認してください",
    );
    expect(hostRestartReadyHint("win32")).toBe("トレイメニューの Restart WebUI と同じ操作です。");
  });

  it("names start.sh / npm run host on Linux and macOS", () => {
    expect(hostLaunchRequiredHint("linux")).toContain("./start.sh");
    expect(hostLaunchRequiredHint("linux")).toContain("npm run host");
    expect(hostLaunchCheckHint("darwin")).toContain("./start.sh");
    expect(llamaServerHostCheckHint("linux")).toContain("npm run host");
    expect(hostRestartReadyHint("linux")).toContain("設定画面から WebUI を再起動します");
  });

  it("exposes a dual-OS hint for browser UI", () => {
    expect(HOST_LAUNCH_REQUIRED_HINT_ANY).toContain("start.bat");
    expect(HOST_LAUNCH_REQUIRED_HINT_ANY).toContain("./start.sh");
    expect(HOST_RESTART_READY_HINT_ANY).toContain("Restart WebUI");
  });
});
