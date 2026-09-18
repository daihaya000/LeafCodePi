// One bounded, deterministic decode probe; run serially on an idle server.
// Usage: node scripts/llama-server-bench.mjs [http://127.0.0.1:18081]
// Fixed output length measures throughput, not answer quality or long-context speed.
const base = new URL(process.argv[2] ?? 'http://127.0.0.1:18081');
if (!['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname)) {
  throw new Error('Benchmark only accepts a loopback server');
}
const started = performance.now();
const response = await fetch(new URL('/v1/chat/completions', base), {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  signal: AbortSignal.timeout(25_000),
  body: JSON.stringify({
    messages: [{ role: 'user', content: 'Write a Python merge_sorted(a, b) function that merges two sorted lists in linear time. Include a docstring, comments, and tests for empty inputs and duplicates.' }],
    chat_template_kwargs: { enable_thinking: false },
    temperature: 0,
    seed: 42,
    max_tokens: 192,
    ignore_eos: true,
    cache_prompt: false,
    stream: false,
  }),
});
if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`);
const result = await response.json();
if (!result.timings || result.usage?.completion_tokens !== 192) {
  throw new Error('Expected llama.cpp timings and exactly 192 generated tokens');
}
console.log(JSON.stringify({
  model: result.model,
  elapsed_ms: Math.round(performance.now() - started),
  usage: result.usage,
  timings: result.timings,
  output: result.choices?.[0]?.message,
}, null, 2));
