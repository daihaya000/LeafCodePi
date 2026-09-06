# powershell-japanese-encoding

Install by extracting `powershell-japanese-encoding.zip` into an OpenCode skill directory so its final path is `skills/powershell-japanese-encoding/SKILL.md`, then restart OpenCode.

## Contents

```text
powershell-japanese-encoding/
├── SKILL.md                         # workflow and decisions
├── agents/openai.yaml               # agent skill metadata
├── references/powershell-encoding.md# edition/file-format reference
├── scripts/Test-EncodingRisks.ps1   # static risk detector
├── scripts/Test-JapaneseRoundTrip.ps1 # UTF-8 BOM/no-BOM, CP932, Unicode and LF test
├── examples/bad-and-good.ps1        # review examples
└── tests/Test-Skill.ps1             # runnable smoke tests
```

Run the tests on each supported host:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\tests\Test-Skill.ps1
pwsh -NoProfile -File .\tests\Test-Skill.ps1
```

The checker intentionally exits `1` when it finds risks. Its output is a review queue, not an instruction to change every encoding token blindly.
