import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import type { Context } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { compactSkillsForPrompt, filterSkillsByState, writeSkillsState } from "@/lib/skills";

let root: string;
let agentDir: string;
let dataDir: string;
let skillsDir: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "leafcode-skill-disable-"));
  agentDir = join(root, "agent");
  dataDir = join(root, "data");
  skillsDir = join(root, "skills", "alpha");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(skillsDir, { recursive: true });
  writeFileSync(
    join(skillsDir, "SKILL.md"),
    "---\nname: alpha\ndescription: Alpha procedure\n---\nALPHA-BODY-MARKER do the alpha thing.\n",
    "utf8",
  );
  vi.stubEnv("LEAFCODE_PI_DATA_DIR", dataDir);
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

function lastUserText(context: Context): string {
  const users = context.messages.filter((message) => message.role === "user");
  const content = users.at(-1)?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        const text = (block as { text?: unknown }).text;
        return typeof text === "string" ? text : "";
      })
      .join("\n");
  }
  return "";
}

it("hides a settings-disabled skill from the catalog and /skill expansion after reload", async () => {
  const settingsManager = SettingsManager.inMemory();
  const loader = new DefaultResourceLoader({
    cwd: root,
    agentDir,
    settingsManager,
    noExtensions: true,
    noPromptTemplates: true,
    noThemes: true,
    additionalSkillPaths: [join(root, "skills")],
    // Same filter chain as sessionSkillsOverride in harness.ts.
    skillsOverride: (base) => ({
      ...base,
      skills: compactSkillsForPrompt(filterSkillsByState(base.skills, undefined, "code")),
    }),
  });
  await loader.reload();
  expect(loader.getSkills().skills.map((skill) => skill.name)).toContain("alpha");

  const faux = fauxProvider();
  const seen: string[] = [];
  const capture = (context: Context) => {
    seen.push(lastUserText(context));
    return fauxAssistantMessage("ok");
  };
  faux.setResponses([capture, capture]);
  const runtime = await ModelRuntime.create({
    authPath: join(dataDir, "auth.json"),
    modelsPath: null,
    refreshOnCreate: false,
  });
  runtime.registerNativeProvider(faux.provider);
  const { session } = await createAgentSession({
    cwd: root,
    agentDir,
    resourceLoader: loader,
    settingsManager,
    sessionManager: SessionManager.inMemory(root),
    modelRuntime: runtime,
    model: faux.getModel(),
    tools: ["read"],
  });
  try {
    await session.bindExtensions({});
    expect(session.systemPrompt).toContain("alpha");
    await session.prompt("/skill:alpha hi");
    expect(seen.at(-1)).toContain("ALPHA-BODY-MARKER");

    writeSkillsState({ code: { alpha: true }, bot: {} });
    await session.reload();
    expect(loader.getSkills().skills.map((skill) => skill.name)).not.toContain("alpha");
    expect(session.systemPrompt).not.toContain("alpha");
    await session.prompt("/skill:alpha hi");
    expect(seen.at(-1)).toBe("/skill:alpha hi");
  } finally {
    session.dispose();
  }
});
