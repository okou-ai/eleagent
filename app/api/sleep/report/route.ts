import { after } from 'next/server';
import { sql } from '@/lib/db';
import { activeRun, sleepNext, stopSandbox } from '@/lib/sleep-run';

// The sandbox reports when Pi has exited. A run that is still active never reached finish: it failed.
export async function POST(request: Request) {
  const token = request.headers.get('x-eleagent-run');
  const running = await activeRun(token);
  const run = running ?? await activeRun(token, { finished: true });
  if (run) {
    const report = (await request.text()).slice(0, 1500);
    // The token is no longer needed either way.
    if (running) {
      await sql()`UPDATE sleep_days SET status = 'failed', error = ${`The agent stopped before finishing. ${report}`},
        run_token_hash = NULL, claimed_at = NULL, updated_at = now() WHERE day = ${run.day}`;
    } else {
      await sql()`UPDATE sleep_days SET run_token_hash = NULL WHERE day = ${run.day}`;
    }
    after(async () => { await stopSandbox(run.sandbox); if (running) await sleepNext(); });
  }
  return new Response(null, { status: 204 });
}
