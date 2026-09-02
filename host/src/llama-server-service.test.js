import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLlamaServerService } from './llama-server-service.js';

/** @returns {any} deps with every dependency stubbed. */
function makeDeps(overrides = {}) {
  return {
    platform: 'win32',
    batPath: 'C:\\fake\\llama-server-load.bat',
    port: 8080,
    getListeningPids: () => [],
    // Default: server not running. start() must reach the launcher, so /health
    // must NOT report ok. Tests that assert on a live server override this.
    fetch: async () => { throw new Error('no server'); },
    // Default: WMI launch succeeds and returns a real PID.
    spawnSync: () => ({ status: 0, stdout: '12345' }),
    writeFile: () => {},
    spawn: () => ({ pid: 54321, unref() {} }),
    isProcessAlive: () => false,
    stopProcessTreeGracefully: async () => 'gone',
    ...overrides,
  };
}

test('status reports running when /health is ok', async () => {
  const svc = createLlamaServerService(
    makeDeps({
      fetch: async () => ({ ok: true, json: async () => ({ status: 'ok' }) }),
    }),
  );
  const s = await svc.status();
  assert.equal(s.running, true);
  assert.equal(s.health, 'ok');
  assert.equal(s.port, 8080);
});

test('status reports running when listeners exist even if /health fails', async () => {
  const svc = createLlamaServerService(
    makeDeps({
      fetch: async () => { throw new Error('no server'); },
      getListeningPids: () => [9999],
    }),
  );
  const s = await svc.status();
  // A port listener alone does NOT mean running — another process (e.g. Caddy)
  // may occupy the port. Only /health ok or owned pid alive means running.
  assert.equal(s.running, false);
  assert.equal(s.health, null);
  assert.deepEqual(s.listeningPids, [9999]);
});

test('status reports not running when /health fails and no listeners', async () => {
  const svc = createLlamaServerService(
    makeDeps({
      fetch: async () => { throw new Error('no server'); },
      getListeningPids: () => [],
    }),
  );
  const s = await svc.status();
  assert.equal(s.running, false);
});

test('status reports running when owned pid is still alive', async () => {
  const svc = createLlamaServerService(
    makeDeps({
      isProcessAlive: (pid) => pid === 12345,
      fetch: async () => { throw new Error('no server'); },
      getListeningPids: () => [],
    }),
  );
  await svc.start();
  const s = await svc.status();
  assert.equal(s.running, true);
  assert.equal(s.pid, 12345);
});

test('start writes a UTF-8 launcher bat that inlines config and calls the real bat, then WMI-launches it', async () => {
  const written = [];
  let wmiArgs = null;
  const svc = createLlamaServerService(
    makeDeps({
      writeFile: (path, data) => { written.push({ path, data }); },
      spawnSync: (cmd, args) => {
        wmiArgs = { cmd, args };
        return { status: 0, stdout: '12345' };
      },
    }),
  );
  const result = await svc.start({ effort: 'medium', contextLength: 131072, parallel: 2 });
  assert.equal(result.ok, true);
  assert.equal(result.pid, 12345);
  assert.equal(written.length, 1);
  const data = written[0].data;
  // Launcher bat: @echo off + chcp 65001 + config set lines + call real bat.
  assert.match(data, /^@echo off\r\nchcp 65001 >nul\r\nsetlocal EnableDelayedExpansion/);
  assert.match(data, /set "REASONING_EFFORT=medium"/);
  assert.match(data, /set "CONTEXT_LENGTH=131072"/);
  assert.match(data, /set "PARALLEL=2"/);
  assert.match(data, /set "SERVER_PORT=8080"/);
  assert.match(data, /call "C:\\fake\\llama-server-load.bat"/);
  assert.match(data, /del "%~f0" >nul 2>&1/);
  // WMI via powershell -EncodedCommand (base64 UTF-16LE).
  assert.equal(wmiArgs.cmd, 'powershell.exe');
  assert.ok(wmiArgs.args.includes('-EncodedCommand'));
});

test('start preserves an explicitly empty reasoning effort for the Windows launcher', async () => {
  let written = '';
  const svc = createLlamaServerService(
    makeDeps({
      writeFile: (path, data) => { written = data; },
    }),
  );
  const result = await svc.start({ effort: '' });
  assert.equal(result.ok, true);
  assert.match(written, /set "REASONING_EFFORT="/);
  assert.match(written, /set "LEAFCODE_PI_EMPTY_EFFORT=1"/);
});

test('start maps llama.cpp path, model dir and model file into the launcher bat', async () => {
  let written = '';
  const svc = createLlamaServerService(
    makeDeps({
      writeFile: (path, data) => { written = data; },
    }),
  );
  const result = await svc.start({
    llamaServerBin: 'D:\\tools\\llama.cpp\\llama-server.exe',
    modelDir: 'D:\\models\\llm',
    modelFile: 'repoA\\model-Q4_K_S.gguf',
    llamaServerHost: '0.0.0.0',
  });
  assert.equal(result.ok, true);
  assert.match(written, /set "LLAMA_SERVER_BIN=D:\\tools\\llama.cpp\\llama-server.exe"/);
  assert.match(written, /set "MODEL_DIR=D:\\models\\llm"/);
  assert.match(written, /set "MODEL_FILE=repoA\\model-Q4_K_S.gguf"/);
  assert.match(written, /set "LLAMA_SERVER_HOST=0.0.0.0"/);
});

test('start falls back to an in-process cmd.exe spawn when WMI fails', async () => {
  let spawned = null;
  const svc = createLlamaServerService(
    makeDeps({
      spawnSync: () => ({ status: 1, stdout: '' }),
      spawn: (cmd, args, opts) => {
        spawned = { cmd, args, opts };
        return { pid: 54321, unref() {} };
      },
    }),
  );
  const result = await svc.start();
  assert.equal(result.ok, true);
  assert.equal(result.pid, 54321);
  assert.equal(spawned.cmd, 'cmd.exe');
  assert.ok(spawned.args.length === 2 && spawned.args[0] === '/c');
  assert.match(spawned.args[1], /llama-launch-[0-9a-f]+\.bat$/);
});

test('start launches the standalone tray via WMI when trayScript is set', async () => {
  const wmiCalls = [];
  const svc = createLlamaServerService(
    makeDeps({
      trayScript: 'C:\\fake\\llama-server-tray.mjs',
      spawnSync: (cmd, args) => {
        wmiCalls.push({ cmd, args });
        return { status: 0, stdout: '12345' };
      },
    }),
  );
  const result = await svc.start();
  assert.equal(result.ok, true);
  assert.equal(result.pid, 12345);
  assert.equal(result.trayPid, 12345);
  // First WMI call launches the server launcher; second launches the tray.
  assert.equal(wmiCalls.length, 2);
  assert.ok(wmiCalls[1].args.includes('-EncodedCommand'));
});

test('start does not fail when the tray cannot be launched', async () => {
  // spawnSync returns the server PID first, then a failure for the tray.
  let calls = 0;
  const svc = createLlamaServerService(
    makeDeps({
      trayScript: 'C:\\fake\\llama-server-tray.mjs',
      spawnSync: () => {
        calls += 1;
        return calls === 1 ? { status: 0, stdout: '12345' } : { status: 1, stdout: '' };
      },
    }),
  );
  const result = await svc.start();
  assert.equal(result.ok, true);
  assert.equal(result.pid, 12345);
  assert.equal(result.trayPid, null);
});

test('start skips the tray when trayScript is not set', async () => {
  const wmiCalls = [];
  const svc = createLlamaServerService(
    makeDeps({
      spawnSync: (cmd, args) => {
        wmiCalls.push({ cmd, args });
        return { status: 0, stdout: '12345' };
      },
    }),
  );
  const result = await svc.start();
  assert.equal(result.ok, true);
  assert.equal(result.trayPid, null);
  assert.equal(wmiCalls.length, 1);
});

test('stop kills the tray pid together with the server', async () => {
  const killed = [];
  const svc = createLlamaServerService(
    makeDeps({
      trayScript: 'C:\\fake\\llama-server-tray.mjs',
      isProcessAlive: (pid) => pid === 12345,
      getListeningPids: () => [],
      stopProcessTreeGracefully: async ({ pid }) => { killed.push(pid); return 'soft'; },
    }),
  );
  await svc.start();
  // trayPid is the same as the server pid in this stub; ensure stop kills it.
  const result = await svc.stop();
  assert.equal(result.ok, true);
  assert.ok(killed.length > 0);
  assert.ok(killed.includes(12345));
});

test('stop kills a tray pid that differs from the server pid', async () => {
  // Regression: `let trayPid = null` inside start() shadowed the closure
  // variable, so stop() never knew the tray PID when it differed from the
  // server PID and left the tray process running.
  let call = 0;
  const killed = [];
  const svc = createLlamaServerService(
    makeDeps({
      trayScript: 'C:\\fake\\llama-server-tray.mjs',
      // First WMI call (launcher) returns 12345, second (tray) returns 67890.
      spawnSync: () => {
        call += 1;
        return { status: 0, stdout: call === 1 ? '12345' : '67890' };
      },
      isProcessAlive: (pid) => pid === 12345 || pid === 67890,
      getListeningPids: () => [],
      stopProcessTreeGracefully: async ({ pid }) => { killed.push(pid); return 'soft'; },
    }),
  );
  const startResult = await svc.start();
  assert.equal(startResult.pid, 12345);
  assert.equal(startResult.trayPid, 67890);

  const result = await svc.stop();
  assert.equal(result.ok, true);
  assert.ok(killed.includes(12345), 'server launcher must be killed');
  assert.ok(killed.includes(67890), 'tray must be killed');
});

test('start refuses a path value cmd.exe could reinterpret', async () => {
  for (const config of [
    { modelDir: 'D:\\m" & calc & "' },
    { modelFile: 'x%PATH%.gguf' },
    { llamaServerBin: 'D:\\a!b!\\llama-server.exe' },
    { modelDir: `D:\\${'a'.repeat(400)}` },
  ]) {
    let spawnCalled = false;
    const svc = createLlamaServerService(
      makeDeps({
        spawn: () => { spawnCalled = true; return { pid: 1, unref() {} }; },
      }),
    );
    const result = await svc.start(config);
    assert.equal(result.ok, false, `expected rejection for ${JSON.stringify(config)}`);
    assert.match(result.error, /unsafe llama-server path value/);
    assert.equal(spawnCalled, false);
  }
});

test('start does not inline config values the caller did not set', async () => {
  let written = '';
  const svc = createLlamaServerService(
    makeDeps({
      writeFile: (path, data) => { written = data; },
    }),
  );
  await svc.start();
  assert.doesNotMatch(written, /REASONING_EFFORT/);
  assert.doesNotMatch(written, /CONTEXT_LENGTH/);
  assert.doesNotMatch(written, /PARALLEL/);
  assert.doesNotMatch(written, /LLAMA_SERVER_BIN/);
  assert.doesNotMatch(written, /MODEL_DIR/);
  assert.doesNotMatch(written, /MODEL_FILE/);
});

test('start returns ok=false with error message when WMI throws', async () => {
  const svc = createLlamaServerService(
    makeDeps({
      spawnSync: () => { throw new Error('boom'); },
    }),
  );
  // spawnSync throwing makes launchViaWmi return null; the fallback spawn then
  // runs. Force both to fail by stubbing spawn to throw as well.
  const svc2 = createLlamaServerService(
    makeDeps({
      spawnSync: () => { throw new Error('boom'); },
      spawn: () => { throw new Error('spawn boom'); },
    }),
  );
  const result = await svc2.start();
  assert.equal(result.ok, false);
  assert.match(result.error, /boom/);
});

test('start rejects a double-start when the owned pid is still alive', async () => {
  const svc = createLlamaServerService(
    makeDeps({
      isProcessAlive: (pid) => pid === 12345,
    }),
  );
  await svc.start();
  const result = await svc.start();
  assert.equal(result.ok, false);
  assert.match(result.error, /already running/);
});

test('start rejects a double-start when /health is ok but the owned pid is dead', async () => {
  // The normal running state: the launcher exited but llama-server.exe —
  // launched via `start` inside the bat — keeps serving /health.
  let spawnCalled = false;
  const svc = createLlamaServerService(
    makeDeps({
      spawnSync: () => { spawnCalled = true; return { status: 0, stdout: '1' }; },
      isProcessAlive: () => false,
      fetch: async () => ({ ok: true, json: async () => ({ status: 'ok' }) }),
    }),
  );
  const result = await svc.start();
  assert.equal(result.ok, false);
  assert.match(result.error, /already running/);
  assert.equal(spawnCalled, false);
});

test('stop kills the owned pid and every listener (WMI launcher + bat `start` reparents llama-server.exe)', async () => {
  const killed = [];
  let listeners = [];
  const svc = createLlamaServerService(
    makeDeps({
      spawnSync: () => { listeners = [200]; return { status: 0, stdout: '100' }; },
      isProcessAlive: (pid) => pid === 100,
      getListeningPids: () => listeners,
      isLlamaServerProcess: () => true,
      stopProcessTreeGracefully: async ({ pid }) => { killed.push(pid); return 'soft'; },
    }),
  );
  await svc.start();
  const result = await svc.stop();
  assert.equal(result.ok, true);
  assert.deepEqual(killed, [100, 200]);
  assert.deepEqual(result.killed, [100, 200]);
});

test('stop falls back to listeners when the owned pid is already dead', async () => {
  const killed = [];
  let listeners = [];
  const svc = createLlamaServerService(
    makeDeps({
      spawnSync: () => { listeners = [200, 201]; return { status: 0, stdout: '100' }; },
      isProcessAlive: () => false, // owned launcher has exited
      getListeningPids: () => listeners,
      isLlamaServerProcess: () => true,
      stopProcessTreeGracefully: async ({ pid }) => { killed.push(pid); return 'soft'; },
    }),
  );
  await svc.start();
  const result = await svc.stop();
  assert.equal(result.ok, true);
  assert.deepEqual(killed, [200, 201]);
});

test('stop deduplicates listeners and owned pid when they collide', async () => {
  const killed = [];
  let listeners = [];
  const svc = createLlamaServerService(
    makeDeps({
      spawnSync: () => { listeners = [200, 201]; return { status: 0, stdout: '200' }; },
      isProcessAlive: (pid) => pid === 200,
      getListeningPids: () => listeners,
      isLlamaServerProcess: () => true,
      stopProcessTreeGracefully: async ({ pid }) => { killed.push(pid); return 'soft'; },
    }),
  );
  await svc.start();
  const result = await svc.stop();
  assert.deepEqual(killed, [200, 201]);
});

test('stop leaves listeners that are not verified as llama-server untouched', async () => {
  const killed = [];
  const svc = createLlamaServerService(
    makeDeps({
      getListeningPids: () => [200],
      isLlamaServerProcess: () => false,
      stopProcessTreeGracefully: async ({ pid }) => { killed.push(pid); return 'soft'; },
    }),
  );
  const result = await svc.stop();
  assert.deepEqual(result.killed, []);
  assert.deepEqual(killed, []);
});

test('stop does not kill a PID that no longer matches the owned process', async () => {
  let alive = false;
  const killed = [];
  const svc = createLlamaServerService(
    makeDeps({
      isProcessAlive: () => alive,
      isOwnedProcess: () => false,
      stopProcessTreeGracefully: async ({ pid }) => { killed.push(pid); return 'soft'; },
    }),
  );
  await svc.start();
  alive = true;
  const result = await svc.stop();
  assert.deepEqual(result.killed, []);
  assert.deepEqual(killed, []);
});

test('stop with no owned pid and no listeners returns empty killed', async () => {
  const svc = createLlamaServerService(
    makeDeps({
      getListeningPids: () => [],
      stopProcessTreeGracefully: async () => 'gone',
    }),
  );
  const result = await svc.stop();
  assert.equal(result.ok, true);
  assert.deepEqual(result.killed, []);
});

test('stop clears the owned pid so a subsequent status no longer reports it', async () => {
  const svc = createLlamaServerService(
    makeDeps({
      isProcessAlive: () => true,
      getListeningPids: () => [],
      stopProcessTreeGracefully: async () => 'soft',
    }),
  );
  await svc.start();
  let s = await svc.status();
  assert.equal(s.pid, 12345);
  await svc.stop();
  s = await svc.status();
  assert.equal(s.pid, null);
});

test('Linux starts llama-server directly without PowerShell or a tray', async () => {
  let spawned = null;
  const svc = createLlamaServerService(
    makeDeps({
      platform: 'linux',
      defaultBin: '/usr/local/bin/llama-server',
      defaultModelDir: '/home/test/models',
      trayScript: '/tmp/llama-server-tray.mjs',
      spawnSync: () => { throw new Error('PowerShell must not be called'); },
      spawn: (command, args, options) => {
        spawned = { command, args, options };
        return { pid: 2468, once() {}, unref() {} };
      },
    }),
  );
  const result = await svc.start({
    modelFile: 'repo/model-Q4_K_S.gguf',
    contextLength: 65536,
    parallel: 2,
    effort: 'medium',
  });
  assert.equal(result.ok, true);
  assert.equal(result.pid, 2468);
  assert.equal(result.trayPid, null);
  assert.equal(spawned.command, '/usr/local/bin/llama-server');
  assert.deepEqual(spawned.args, [
    '--host', '127.0.0.1', '--port', '8080', '-c', '65536', '-np', '2',
    '-ngl', '999', '-fa', 'on', '--temp', '0.6', '--top-p', '0.95', '--top-k', '20', '--jinja',
    '--chat-template-kwargs', '{"reasoning_effort":"medium"}',
    '-m', '/home/test/models/repo/model-Q4_K_S.gguf', '--alias', 'model-Q4_K_S',
  ]);
  assert.equal(spawned.options.detached, true);
});

test('Linux accepts POSIX path characters that do not reach a shell', async () => {
  let spawned = null;
  const svc = createLlamaServerService(
    makeDeps({
      platform: 'linux',
      defaultBin: '/usr/local/bin/llama-server',
      defaultModelDir: '/home/test/models',
      spawn: (command, args, options) => {
        spawned = { command, args, options };
        return { pid: 2468, once() {}, unref() {} };
      },
    }),
  );
  const result = await svc.start({
    llamaServerBin: '/opt/llama&tools/llama-server',
    modelDir: '/home/test/models&cache',
    modelFile: 'model&test.gguf',
  });
  assert.equal(result.ok, true);
  assert.equal(spawned.command, '/opt/llama&tools/llama-server');
  assert.ok(spawned.args.includes('/home/test/models&cache/model&test.gguf'));
});

test('Linux rejects model files outside the configured model directory', async () => {
  const svc = createLlamaServerService(makeDeps({ platform: 'linux' }));
  const result = await svc.start({ modelFile: '../secret.gguf' });
  assert.equal(result.ok, false);
  assert.match(result.error, /unsafe llama-server path value: modelFile/);
});

test('start rejects unavailable port state before spawning', async () => {
  let spawned = false;
  const svc = createLlamaServerService(makeDeps({
    platform: 'linux',
    defaultBin: '/usr/local/bin/llama-server',
    defaultModelDir: '/home/test/models',
    getPortListenerStatus: () => ({ available: false, listening: false, pids: [] }),
    spawn: () => { spawned = true; return { pid: 2468, unref() {} }; },
  }));
  const result = await svc.start();
  assert.equal(result.ok, false);
  assert.match(result.error, /port status is unavailable/);
  assert.equal(spawned, false);
});

test('start refuses a port listener whose PID metadata is hidden', async () => {
  let spawned = false;
  const svc = createLlamaServerService(makeDeps({
    platform: 'linux',
    defaultBin: '/usr/local/bin/llama-server',
    defaultModelDir: '/home/test/models',
    getPortListenerStatus: () => ({ available: true, listening: true, pids: [] }),
    spawn: () => { spawned = true; return { pid: 2468, unref() {} }; },
  }));
  const result = await svc.start();
  assert.equal(result.ok, false);
  assert.match(result.error, /port is already in use/);
  assert.equal(spawned, false);
});

test('POSIX spawn errors are returned instead of reporting a successful start', async () => {
  const listeners = new Map();
  const child = {
    pid: 2468,
    once(event, handler) {
      const list = listeners.get(event) ?? [];
      list.push(handler);
      listeners.set(event, list);
    },
    on() { return this; },
    unref() {},
  };
  const svc = createLlamaServerService(makeDeps({
    platform: 'linux',
    defaultBin: '/missing/llama-server',
    defaultModelDir: '/home/test/models',
    spawn: () => {
      queueMicrotask(() => {
        for (const handler of listeners.get('error') ?? []) handler(new Error('ENOENT'));
      });
      return child;
    },
  }));
  const result = await svc.start();
  assert.equal(result.ok, false);
  assert.match(result.error, /ENOENT/);
});

test('resident POSIX ownership survives host recreation and is stopped once', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'leafcode-pi-owner-'));
  const ownershipFile = join(dir, 'llama-server-owner.json');
  const currentListeners = [];
  const starts = new Map([[2468, 'server-start']]);
  const killed = [];
  const common = {
    platform: 'linux',
    port: 8080,
    defaultBin: '/usr/local/bin/llama-server',
    defaultModelDir: '/home/test/models',
    ownershipFile,
    getProcessStartTime: (pid) => starts.get(pid) ?? null,
    getPortListenerStatus: () => ({
      available: true,
      listening: currentListeners.length > 0,
      pids: currentListeners,
    }),
    getListeningPids: () => currentListeners,
    isProcessAlive: (pid) => pid === 2468,
    isOwnedProcess: () => true,
    isLlamaServerProcess: () => true,
    stopProcessTreeGracefully: async ({ pid }) => { killed.push(pid); return 'soft'; },
    fetch: async () => { throw new Error('no server'); },
    spawn: () => ({ pid: 2468, unref() {} }),
  };
  try {
    const first = createLlamaServerService(common);
    assert.equal((await first.start()).ok, true);
    assert.equal(JSON.parse(readFileSync(ownershipFile, 'utf8')).pid, 2468);

    currentListeners.push(2468);
    const afterRestart = createLlamaServerService(common);
    const status = await afterRestart.status();
    assert.equal(status.running, true);
    assert.deepEqual((await afterRestart.stop()).killed, [2468]);
    assert.deepEqual(killed, [2468]);
    assert.throws(() => readFileSync(ownershipFile, 'utf8'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('restored ownership refuses a reused PID with a different start time', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'leafcode-pi-owner-'));
  const ownershipFile = join(dir, 'llama-server-owner.json');
  writeFileSync(ownershipFile, `${JSON.stringify({
    version: 1,
    port: 8080,
    pid: 2468,
    commandMarker: '/usr/local/bin/llama-server',
    serverCommandMarker: '/usr/local/bin/llama-server',
    pidStartTime: 'old-start',
    listeners: [{ pid: 2468, startTime: 'old-start' }],
  })}\n`);
  const killed = [];
  const svc = createLlamaServerService({
    platform: 'linux',
    port: 8080,
    ownershipFile,
    getPortListenerStatus: () => ({ available: true, listening: true, pids: [2468] }),
    getListeningPids: () => [2468],
    getProcessStartTime: () => 'new-start',
    isProcessAlive: () => true,
    isOwnedProcess: () => true,
    isLlamaServerProcess: () => true,
    fetch: async () => { throw new Error('no server'); },
    stopProcessTreeGracefully: async ({ pid }) => { killed.push(pid); return 'soft'; },
  });
  try {
    assert.equal((await svc.status()).running, false);
    assert.deepEqual((await svc.stop()).killed, []);
    assert.deepEqual(killed, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
