import { after } from 'next/server';
import { sql } from '@/lib/db';
import { SLEEP_MODEL, activeRun } from '@/lib/sleep-run';

// The sleeping agent's model, an OpenAI-compatible chat completions endpoint for Pi. The sandbox never holds the
// OpenRouter key: this route adds it, pins the model, requires zero-data-retention providers and counts the cost.
export const maxDuration = 300;

async function meter(stream: ReadableStream<Uint8Array>, day: string) {
  let tail = '';
  const reader = stream.pipeThrough(new TextDecoderStream() as unknown as TransformStream<Uint8Array, string>).getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    tail = (tail + value).slice(-4000);
  }
  const costs = [...tail.matchAll(/"cost":\s*([0-9.eE+-]+)/g)];
  const cost = Number(costs.at(-1)?.[1] ?? 0);
  if (cost > 0) await sql()`UPDATE sleep_days SET cost_usd = cost_usd + ${cost} WHERE day = ${day}`;
}

export async function POST(request: Request) {
  const run = await activeRun(request.headers.get('x-eleagent-run'), { finished: true });
  if (!run) return Response.json({ error: { message: 'This sleep run is not active' } }, { status: 401 });
  const body = await request.json() as Record<string, unknown>;
  const upstream = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`, 'Content-Type': 'application/json', 'X-Title': 'Eleagent sleep',
      'HTTP-Referer': 'https://github.com/okou-ai/eleagent' },
    body: JSON.stringify({ ...body, model: SLEEP_MODEL, provider: { zdr: true, data_collection: 'deny' }, usage: { include: true },
      reasoning: { effort: 'medium' } }),
    signal: request.signal,
  });
  if (!upstream.body) return new Response(await upstream.text(), { status: upstream.status });
  const [toAgent, toMeter] = upstream.body.tee();
  after(() => meter(toMeter, run.day).catch(() => {}));
  return new Response(toAgent, { status: upstream.status, headers: { 'Content-Type': upstream.headers.get('content-type') ?? 'application/json' } });
}
