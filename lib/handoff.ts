import type { Query } from './mcp.ts';
import type { Complete } from './sleep.ts';
import { localTime } from './sleep.ts';

// Handing requests to Okou: the owner asks Okou, their AI assistant, to do something out loud while recording
// ("Okou, find the brand of these eye drops"). After each minute is heard and seen, a model reads the recent speech,
// decides whom the newest words were for, and when they were a request for Okou writes one message Okou can act on
// without the recording. It goes into one standing Okou conversation through Okou's MCP server (send_chat_message).

export interface HandoffDeps {
  query: Query;
  complete: Complete;
  timeZone: () => Promise<string>;
  /** A current access token for Okou's MCP server, or null when Okou is not connected. */
  okouToken: () => Promise<string | null>;
  callOkou: (token: string, tool: string, args: Record<string, unknown>) => Promise<unknown>;
  /** OKOU_AGENT_ID: which Okou agent gets the requests (otherwise the one named Okou, or the first). */
  agentId?: string;
  /** Speech to text, for requests spoken to Okou directly. */
  transcribe?: (wav: Buffer) => Promise<string>;
  /** Drops the Okou connection after Okou refused its token, so that the owner connects again. */
  forgetOkou?: () => Promise<void>;
}

// Okou refused the token itself (not the request): retrying cannot help, connecting again can.
export const refused = (error: unknown) => /invalid_token|insufficient_scope/.test(String((error as Error)?.message ?? error));

const MIN_CONFIDENCE = 0.8;
const CONTEXT_MINUTES = 2;

const SETTING = `Eleagent is a personal memory assistant. The owner carries a phone camera that records their day, and \
speech recognition turns what is said into text, minute by minute: sentences can be cut, words misheard (names \
especially; "Okou" itself can come out as a sound-alike such as "OK", "欧扣" or "包括"), and speaker labels are \
anonymous guesses that only hold within one minute.

What the owner says is for one of several listeners: mostly the people around them, or themselves. Some of it is for \
Okou, their AI assistant, which acts for them in their accounts (calendar, mail, messages, documents, the web): they \
ask Okou out loud to do something, the way they would ask a person, calling it by name, in any language. Speech from \
other people, a call, a video or a broadcast is not the owner asking Okou, even if it mentions Okou.`;

const SYSTEM = `${SETTING}

You are the ear that notices requests for Okou. You get the speech of the last few minutes, with the newest minute \
marked, a description of what is happening, and what was already handed to Okou during this recording. Decide whom \
the newest minute's words are for. Handing Okou talk that was not for it makes Okou act on things the owner never \
asked for; missing a request makes the owner repeat it. A request that Okou already has is not new.

When the newest minute holds a new request for Okou, also write the message Okou gets. Okou does not hear the \
recording and does not know where the owner is or who is with them: say what the owner wants, in their words, and \
the facts that make it clear (the date and time meant, where they are, the few lines of conversation that matter). \
Leave the how to Okou and say what is unclear rather than guessing. Write it in the owner's language.

Reply with JSON only:
{"for": "Okou | people present | themselves", "confidence": 0.0-1.0, "quote": "the words of the request, or null",
 "message": "the message for Okou, or null", "screen": "a short line for the owner's screen saying what was handed over, or null"}`;

type Row = Record<string, unknown>;
const iso = (value: unknown) => new Date(value as string).toISOString();

async function okouAgent(deps: HandoffDeps, token: string, remembered: Row | null): Promise<string> {
  if (deps.agentId) return deps.agentId;
  if (typeof remembered?.agentId === 'string') return remembered.agentId;
  const listed = await deps.callOkou(token, 'list_agents', {});
  const agents = (Array.isArray(listed) ? listed : []) as Row[];
  const chosen = agents.find((agent) => /okou/i.test(String(agent.name ?? agent.displayName ?? ''))) ?? agents[0];
  const id = chosen?.id ?? chosen?.agentId;
  if (typeof id !== 'string') throw new Error('Okou has no agent to hand requests to');
  return id;
}

// Sends one message into the standing Okou conversation, remembering which agent and thread it went to.
async function deliver(deps: HandoffDeps, token: string, prompt: string): Promise<Row> {
  const { query } = deps;
  const remembered = (await query("SELECT value FROM app_settings WHERE key = 'okou_thread'", []))[0]?.value;
  const thread = remembered ? JSON.parse(String(remembered)) as Row : null;
  const agentId = await okouAgent(deps, token, thread);
  const args: Record<string, unknown> = { agentId, prompt };
  if (typeof thread?.threadId === 'string' && thread.agentId === agentId) args.threadId = thread.threadId;
  const result = (await deps.callOkou(token, 'send_chat_message', args) ?? {}) as Row;
  if (typeof result.threadId === 'string') {
    await query(`INSERT INTO app_settings (key, value) VALUES ('okou_thread', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [JSON.stringify({ threadId: result.threadId, agentId })]);
  }
  return result;
}

const SPOKEN_SYSTEM = `${SETTING}

The owner has just spoken a request to Okou through Eleagent: they said "Hey Okou" or tapped the Okou mark, then said \
what they want. You get the transcript (it may begin with the wake word and may contain misheard words), the time, \
and what their phone's camera has been seeing. Write the message Okou gets: what the owner wants, in their words and \
language, with the facts that make it clear (dates and times meant, resolved against now; where they are). Repair \
misheard words only where the context makes them clear, and never add requests of your own.

Reply with JSON only:
{"message": "the message for Okou", "screen": "a short line in the owner's language for the phone, saying what was handed over"}`;

export interface SpokenResult { status: number; screen?: string; error?: string }

// A request the owner spoke to Okou on purpose: transcribe it, write it up with its moment, and hand it over.
export async function handleSpokenRequest(deps: HandoffDeps, { wav, at, captureId }: { wav: Buffer; at: Date; captureId: string | null }):
Promise<SpokenResult> {
  const { query } = deps;
  const token = await deps.okouToken();
  if (!token) return { status: 409, error: 'Connect Okou first' };
  let heard: string;
  try { heard = (await deps.transcribe!(wav)).trim(); } catch { return { status: 502, error: 'Could not transcribe that; try again' }; }
  if (!heard) return { status: 422, error: 'Did not hear anything' };
  const timeZone = await deps.timeZone();
  const [scene] = await query(`SELECT summary, perception->>'place' AS place FROM observations WHERE status = 'done'
    AND ($1::text IS NULL OR capture_id = $1) AND minute > $2::timestamptz - interval '15 minutes' ORDER BY minute DESC LIMIT 1`,
  [captureId, at.toISOString()]);
  const user = `Now: ${at.toISOString()} (${timeZone}, local ${localTime(at, timeZone)}).\n` +
    `What the camera has been seeing: ${scene ? `${scene.summary ?? ''}${scene.place ? ` (place: ${scene.place})` : ''}` : 'not known'}\n\n` +
    `What the owner said:\n${heard}`;
  // Without the write-up, Okou still gets the owner's own words.
  const { json } = await deps.complete(SPOKEN_SYSTEM, user, 1200).catch(() => ({ json: {} as Row }));
  const message = typeof json.message === 'string' && json.message.trim() ? json.message.trim() : heard;
  const screen = typeof json.screen === 'string' && json.screen.trim() ? json.screen.trim().slice(0, 200) : 'Handed to Okou';
  const footer = `\n\n— Said to Okou through Eleagent at ${localTime(at, timeZone)} (${timeZone})` +
    (captureId ? ` while recording ${captureId}. To see or hear the moment, use the Eleagent MCP (list_observations or ` +
      'get_video_frames with this capture_id and the time).' : '.');
  const [row] = await query(`INSERT INTO handoffs (source, capture_id, minute, heard_at, request, message, screen, status)
    VALUES ('spoken', $1, date_trunc('minute', $2::timestamptz), $2, $3, $4, $5, 'sending') RETURNING id`,
  [captureId, at.toISOString(), heard.slice(0, 1000), message, screen]);
  try {
    const result = await deliver(deps, token, message + footer);
    await query(`UPDATE handoffs SET status = 'sent', okou_thread_id = $2, okou_event_id = $3 WHERE id = $1`,
      [row.id, result.threadId ?? null, result.eventId ?? null]);
    return { status: 200, screen };
  } catch (error) {
    await query(`UPDATE handoffs SET status = 'failed', error = $2 WHERE id = $1`, [row.id, String((error as Error).message ?? error).slice(0, 500)]);
    if (refused(error)) {
      await deps.forgetOkou?.();
      return { status: 409, error: 'Okou needs connecting again: tap the Okou mark' };
    }
    return { status: 502, error: 'Okou could not take it; try again' };
  }
}

// Looks at one processed minute; sends at most one request to Okou for it. Never throws.
export async function considerHandoff(deps: HandoffDeps, captureId: string, minute: string): Promise<string> {
  const { query } = deps;
  try {
    const token = await deps.okouToken();
    if (!token) return 'not_connected';
    if ((await query(`SELECT 1 FROM handoffs WHERE capture_id = $1 AND minute = $2 AND source = 'minute'`, [captureId, minute])).length) return 'already_handled';
    const rows = await query(`SELECT minute, summary, transcript FROM observations WHERE capture_id = $1 AND status = 'done'
      AND minute <= $2::timestamptz AND minute >= $2::timestamptz - make_interval(mins => ${CONTEXT_MINUTES}) ORDER BY minute`, [captureId, minute]);
    const newest = rows.find((row) => iso(row.minute) === minute);
    const turns = (newest?.transcript ?? []) as { start: string; speaker: string | null; text: string }[];
    if (!newest || !turns.length) return 'no_speech';
    const timeZone = await deps.timeZone();
    const sent = await query(`SELECT request FROM handoffs WHERE capture_id = $1 AND status = 'sent' ORDER BY heard_at`, [captureId]);
    const speech = rows.map((row) => {
      const lines = ((row.transcript ?? []) as typeof turns).map((turn) => `[${localTime(new Date(turn.start), timeZone)}] ${turn.speaker ?? 'speaker'}: ${turn.text}`);
      return `${iso(row.minute) === minute ? '## Newest minute' : '## Earlier'} (${localTime(new Date(iso(row.minute)), timeZone)})\n${lines.join('\n') || '(no speech)'}`;
    }).join('\n\n');
    const user = `Now: ${new Date(minute).toISOString()} (${timeZone}, local ${localTime(new Date(minute), timeZone)}).\n` +
      `What is happening: ${newest.summary ?? 'unknown'}\n\nAlready handed to Okou during this recording:\n` +
      `${sent.map((row) => `- ${row.request}`).join('\n') || '(nothing)'}\n\n${speech}`;
    const { json } = await deps.complete(SYSTEM, user, 1500);
    const message = typeof json.message === 'string' ? json.message.trim() : '';
    if (json.for !== 'Okou' || Number(json.confidence) < MIN_CONFIDENCE || !message) return 'nothing_for_okou';

    const heardAt = turns[0].start;
    const footer = `\n\n— Eleagent heard this at ${localTime(new Date(heardAt), timeZone)} (${timeZone}) in recording ${captureId}. ` +
      'To see or hear the moment, use the Eleagent MCP: list_observations with this capture_id and a time window, or ' +
      'get_video_frames with this capture_id and the times.';
    const request = String(json.quote ?? message).slice(0, 1000);
    await query(`INSERT INTO handoffs (capture_id, minute, heard_at, request, message, screen, status)
      VALUES ($1, $2, $3, $4, $5, $6, 'sending')`, [captureId, minute, heardAt, request, message, String(json.screen ?? '').slice(0, 200)]);
    try {
      const result = await deliver(deps, token, message + footer);
      await query(`UPDATE handoffs SET status = 'sent', okou_thread_id = $3, okou_event_id = $4
        WHERE capture_id = $1 AND minute = $2 AND source = 'minute'`, [captureId, minute, result.threadId ?? null, result.eventId ?? null]);
      return 'sent';
    } catch (error) {
      // Not retried: Okou's send has no safe retry after a lost acknowledgement.
      await query(`UPDATE handoffs SET status = 'failed', error = $3 WHERE capture_id = $1 AND minute = $2 AND source = 'minute'`,
        [captureId, minute, String((error as Error).message ?? error).slice(0, 500)]);
      if (refused(error)) await deps.forgetOkou?.();
      return 'failed';
    }
  } catch {
    return 'error';
  }
}
