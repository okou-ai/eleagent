import { after } from 'next/server';
import { signDownload } from '@/lib/blob';
import { sql } from '@/lib/db';
import { framesFromUrl } from '@/lib/frames';
import { activeRun, sleepNext } from '@/lib/sleep-run';
import { ToolInputError, runTool } from '@/lib/sleep-tools';

// The sleeping agent's tool calls, from its sandbox (the firewall adds the run's token).
export const maxDuration = 300;

export async function POST(request: Request) {
  const run = await activeRun(request.headers.get('x-eleagent-run'));
  if (!run) return Response.json({ text: 'Error: this sleep run is not active; stop.' }, { status: 401 });
  const { tool, args } = await request.json().catch(() => ({})) as { tool?: string; args?: Record<string, unknown> };
  try {
    const result = await runTool({ query: sql().query, signDownload, extractFrames: framesFromUrl }, run, String(tool), args ?? {});
    // Pi takes one more model turn after finish, then exits and reports (/api/sleep/report stops the sandbox).
    if (tool === 'finish' && result.text.startsWith('The night is complete')) after(sleepNext);
    return Response.json(result);
  } catch (error) {
    return Response.json({ text: `Error: ${error instanceof ToolInputError ? error.message : 'the tool failed; try again or continue without it'}` });
  }
}
