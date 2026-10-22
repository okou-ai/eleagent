// The models behind hearing and seeing, all through OpenRouter with zero-data-retention providers only.

const API = 'https://openrouter.ai/api/v1';
export const SPEECH_MODEL = 'elevenlabs/scribe-v2';
export const PERCEPTION_MODEL = 'xiaomi/mimo-v2.6-flash';

async function call(path: string, body: object, timeoutMs = 120_000): Promise<Record<string, unknown>> {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error('OPENROUTER_API_KEY is not set');
  const response = await fetch(API + path, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'X-Title': 'Eleagent',
      'HTTP-Referer': 'https://github.com/okou-ai/eleagent' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`OpenRouter ${path} ${response.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

const costOf = (result: Record<string, unknown>) => Number((result.usage as { cost?: unknown } | undefined)?.cost ?? 0) || 0;

export interface Word { text: string; start: number; end: number; speaker: string | null }

// Speech with speaker labels (consistent only within this audio). Times are seconds from the audio's start.
export async function transcribe(mp3: Buffer): Promise<{ words: Word[]; cost: number }> {
  const result = await call('/audio/transcriptions', {
    model: SPEECH_MODEL, input_audio: { data: mp3.toString('base64'), format: 'mp3' },
    diarize: true, response_format: 'verbose_json', provider: { zdr: true },
  });
  const raw = Array.isArray(result.words) ? result.words as Record<string, unknown>[] : [];
  const words = raw.map((word) => {
    // scribe-v2 numbers speakers from 0.
    const speaker = word.speaker ?? word.speaker_id ?? null;
    return {
      text: word.type === 'spacing' ? ' ' : String(word.word ?? word.text ?? ''),
      start: Number(word.start), end: Number(word.end ?? word.start),
      speaker: speaker === null ? null : typeof speaker === 'number' ? `speaker_${speaker}` : String(speaker),
    };
  }).filter((word) => word.text && Number.isFinite(word.start));
  return { words, cost: costOf(result) };
}

export interface PerceiveInput {
  camera: 'front' | 'back';
  frames: { offset: number; jpeg: Buffer }[];
  audio: Buffer | null;
  transcript: string;
  /** What the previous minutes of this recording looked like, for continuity. */
  context: string;
  language: string;
}

const prompt = ({ camera, language, transcript, context }: PerceiveInput) => `You are the perception layer of a personal memory \
system. The owner wears or holds a phone that records the day. You get up to one minute of it: still frames in time \
order, each labelled with its time in seconds from the start, the minute's audio, and a transcript of its speech \
(speaker labels are anonymous and only consistent within this minute). This recording uses the ${camera} camera: \
${camera === 'front' ? 'it shows the owner and what is behind them' : 'it shows what the owner faces'}.

Describe what a careful observer would remember about this minute, so the owner can later recall where they were, \
what they did, who was there, what they handled, read or heard. Report only what the frames and audio support; say \
"unclear" rather than guess. Speech from a screen, a call or a broadcast is not a conversation in the room. Write every \
value in ${language}, but copy visible text verbatim in its own language.

Earlier in this recording (other minutes' descriptions, for continuity only; they can be wrong, and this minute may
differ):
${context || '(this is the start of the recording)'}

Transcript:
${transcript || '(no speech recognised)'}

Reply with JSON only:
{"summary": "one sentence: where the owner is, what is happening, with whom",
 "place": "...", "activity": "...", "attention": "what the owner looks at, handles or listens to",
 "people": [{"description": "...", "doing": "...", "speaking": true}],
 "objects": [{"name": "...", "detail": "colour, brand, label", "interaction": "held | used | in view"}],
 "visible_text": [{"text": "verbatim", "on": "where it appears"}],
 "sounds": "ambient sounds", "speech_gist": "what was said, by whom if clear",
 "timeline": [{"t": "0-15s", "event": "..."}], "notable": "anything worth remembering"}`;

// A structured description of the minute from its stills, sound and transcript.
export async function perceive(input: PerceiveInput): Promise<{ perception: Record<string, unknown>; cost: number }> {
  const content: object[] = [{ type: 'text', text: prompt(input) }];
  for (const frame of input.frames) {
    content.push({ type: 'text', text: `t=${frame.offset.toFixed(1)}s` });
    content.push({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${frame.jpeg.toString('base64')}` } });
  }
  if (input.audio) content.push({ type: 'input_audio', input_audio: { data: input.audio.toString('base64'), format: 'mp3' } });
  const result = await call('/chat/completions', {
    model: PERCEPTION_MODEL, messages: [{ role: 'user', content }], max_tokens: 2500, temperature: 0.2,
    response_format: { type: 'json_object' }, reasoning: { enabled: false },
    provider: { zdr: true, data_collection: 'deny' }, usage: { include: true },
  });
  const reply = String((result.choices as { message?: { content?: unknown } }[] | undefined)?.[0]?.message?.content ?? '');
  const json = reply.slice(reply.indexOf('{'), reply.lastIndexOf('}') + 1);
  let perception: Record<string, unknown>;
  try { perception = JSON.parse(json); } catch { throw new Error('The perception model did not return JSON'); }
  return { perception, cost: costOf(result) };
}

// A text model's JSON answer (for sleep and handing requests to Okou). Now and then a reply is not JSON: try again,
// then once more with the perception model.
export async function completeJson(model: string, system: string, user: string, maxTokens: number) {
  for (const attempt of [model, model]) {
    try { return await completeJsonOnce(attempt, system, user, maxTokens); } catch { /* next attempt */ }
  }
  return completeJsonOnce(PERCEPTION_MODEL, system, user, maxTokens);
}

async function completeJsonOnce(model: string, system: string, user: string, maxTokens: number) {
  const result = await call('/chat/completions', {
    model, messages: [{ role: 'system', content: system }, { role: 'user', content: user }], max_tokens: maxTokens,
    temperature: 0.3, response_format: { type: 'json_object' }, provider: { zdr: true, data_collection: 'deny' }, usage: { include: true },
  }, 240_000);
  const reply = String((result.choices as { message?: { content?: unknown } }[] | undefined)?.[0]?.message?.content ?? '');
  try {
    return { json: JSON.parse(reply.slice(reply.indexOf('{'), reply.lastIndexOf('}') + 1)) as Record<string, unknown>, cost: costOf(result) };
  } catch {
    throw new Error(`${model} did not return JSON`);
  }
}
