import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const bat = fileURLToPath(new URL('./llama-server-load.bat', import.meta.url));
test('launcher stays ASCII, CRLF and BOM-free', () => {
  const bytes = readFileSync(bat);
  assert.ok(bytes.every((byte) => byte < 128));
  assert.doesNotMatch(bytes.toString(), /(?<!\r)\n/);
});

/**
 * `cmd.exe /c ""prog" args >> log"` lets cmd drop the closing quote of the log
 * path, so `>>` reaches the server as an argv entry and it exits immediately with
 * `invalid argument: >>`. The launcher must use `/s /c` for the inner shell.
 */
test('launch lines quote the inner shell so the log redirect applies', { skip: process.platform !== 'win32' }, async () => {
  const text = readFileSync(bat, 'utf8');
  const lines = text.split(/\r?\n/).filter((line) => line.includes('start "llama-server"'));
  assert.equal(lines.length, 6);
  for (const line of lines) assert.match(line, /cmd\.exe \/s \/c ""%[A-Z_]+%"/);

  const line = lines.find((candidate) => candidate.includes('"single_plain"'));
  const dir = mkdtempSync(join(tmpdir(), 'llama-launch-'));
  try {
    const stub = join(dir, 'stub.cmd');
    const log = join(dir, 'server.log');
    writeFileSync(stub, '@echo off\r\necho STUB %*\r\n');
    writeFileSync(join(dir, 'probe.bat'), [
      '@echo off',
      'setlocal enabledelayedexpansion',
      'set "LAUNCH_MODE=single_plain"',
      `set "LLAMA_SERVER_BIN=${stub}"`,
      `set "MODEL_PATH=${stub}"`,
      'set "MODEL_ALIAS=probe"',
      'set "LLAMA_SERVER_HOST=127.0.0.1"',
      'set "SERVER_PORT=9"',
      'set "PARALLEL=1"',
      'set "DEVICE_ARGS="',
      'set "PERF_ARGS=--ctx-size 4096"',
      'set "CACHE_ARGS=--cache-type-k q8_0"',
      'set "SPEC_ARGS="',
      `set "LLAMA_SERVER_LOG=${log}"`,
      line,
      '',
    ].join('\r\n'));
    const result = spawnSync('cmd.exe', ['/c', 'call', join(dir, 'probe.bat')], { encoding: 'utf8', timeout: 10000 });
    assert.ifError(result.error);
    // `start` returns before the child writes, so poll briefly for its output.
    let captured = '';
    for (let attempt = 0; attempt < 40 && !captured; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      captured = existsSync(log) ? readFileSync(log, 'utf8') : '';
    }
    assert.match(captured, /^STUB /m);
    assert.doesNotMatch(captured, />>/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Qwen3.8 sampler is scoped and explicit overrides win', { skip: process.platform !== 'win32' }, () => {
  const run = (overrides) => {
    const env = { ...process.env };
    for (const key of Object.keys(env)) {
      if (/^(MODEL_|SAMPLING_|TOP_|MIN_P$|GPU_|IMAGE_)/i.test(key)) delete env[key];
    }
    const result = spawnSync('cmd.exe', ['/d', '/s', '/c', `""${bat}" /dry-run"`], {
      env: { ...env, ...overrides }, encoding: 'utf8', timeout: 5000, windowsVerbatimArguments: true,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };
  for (const model of ['Huihui-Qwen3.8-27B-abliterated-Q4_K.gguf', 'Qwen3.8-27B-Uncensored-Q4_K_S.gguf', 'QWEN3_8-27B.gguf']) {
    const output = run({ MODEL_FILE: model });
    assert.match(output, /sampling=temp 1\.0 top-p 0\.95 top-k 20 min-p 0\.0 repeat 1\.0 dry 0\.0/);
    assert.match(output, /--min-p 0\.0/);
    // Every layer must stay on the pinned GPU, never on the CPU or iGPU.
    assert.match(output, /device=--device Vulkan0/);
    assert.match(output, /--fit off/);
    assert.match(output, /--gpu-layers all --n-cpu-moe 0 /);
    // llama-server b10488 rejects --n-cpu-ffn, which aborts the launch.
    assert.doesNotMatch(output, /--n-cpu-ffn/);
    // Qwen-VL grounding needs the 1024-token image floor.
    assert.match(output, /--image-min-tokens 1024/);
  }
  assert.match(run({ MODEL_FILE: 'Qwen3.8.gguf', GPU_DEVICE: 'CUDA0' }), /device=--device CUDA0/);
  assert.match(run({ MODEL_FILE: 'Qwen3.8.gguf', IMAGE_MIN_TOKENS: '2048' }), /--image-min-tokens 2048/);
  for (const model of ['', 'Ornith-1.5.gguf', 'Qwen3.5.gguf']) {
    const output = run({ MODEL_FILE: model });
    assert.match(output, /sampling=temp 0\.6 top-p 0\.95 top-k 20 min-p 0\.05 repeat 1\.03 dry 0\.35/);
    assert.doesNotMatch(output, /--image-min-tokens/);
  }
  assert.match(run({ MODEL_FILE: 'Qwen3.8.gguf', SAMPLING_TEMP: '0.7', MIN_P: '0.1', SAMPLING_REPEAT_PENALTY: '1.02', SAMPLING_DRY_MULTIPLIER: '0.2' }),
    /sampling=temp 0\.7 top-p 0\.95 top-k 20 min-p 0\.1 repeat 1\.02 dry 0\.2/);
});
