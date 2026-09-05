import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: mocks.spawn }));

import { runGit } from "./git";

it("decodes UTF-8 across stdout and stderr chunk boundaries", async () => {
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
  });
  mocks.spawn.mockReturnValue(child);
  const result = runGit(".", ["status"]);
  for (const byte of Buffer.from("変更😀\n", "utf8")) {
    child.stdout.write(Buffer.from([byte]));
    child.stderr.write(Buffer.from([byte]));
  }
  child.stdout.end();
  child.stderr.end();
  child.emit("close", 0);
  expect(await result).toEqual({ code: 0, stdout: "変更😀\n", stderr: "変更😀\n" });
});
