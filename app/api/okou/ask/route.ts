import { NextResponse, type NextRequest } from 'next/server';
import { getOwnerSession } from '@/lib/auth-server';
import { handleSpokenRequest } from '@/lib/handoff';
import { handoffDeps } from '@/lib/okou-server';
import { jsonError, sameOrigin } from '@/lib/request';

// A request the owner just spoke to Okou on the capture page ("Hey Okou", or a tap on the mark): 16 kHz WAV audio.
export const maxDuration = 60;
const MAX_BYTES = 3_000_000;
const CAPTURE_ID = /^web-[0-9a-f-]{36}-(front|back)$/;

export async function POST(request: NextRequest) {
  if (!sameOrigin(request)) return jsonError(403, 'cross_origin', 'Requests must come from this site');
  if (!(await getOwnerSession(request.headers))) return jsonError(401, 'sign_in_required', 'Sign in to continue');
  if (request.headers.get('content-type') !== 'audio/wav') return jsonError(415, 'not_wav', 'Send 16 kHz WAV audio');
  const wav = Buffer.from(await request.arrayBuffer());
  if (wav.length < 44 || wav.length > MAX_BYTES) return jsonError(413, 'audio_size', 'The recording is empty or too long');
  const at = new Date(request.nextUrl.searchParams.get('at') ?? '');
  const captureId = request.nextUrl.searchParams.get('capture_id');
  const result = await handleSpokenRequest(handoffDeps(), {
    wav, at: Number.isNaN(at.getTime()) || Math.abs(at.getTime() - Date.now()) > 600_000 ? new Date() : at,
    captureId: captureId && CAPTURE_ID.test(captureId) ? captureId : null,
  });
  if (result.status !== 200) return jsonError(result.status, 'not_handed_over', result.error ?? 'Okou could not take that');
  return NextResponse.json({ screen: result.screen }, { headers: { 'Cache-Control': 'no-store' } });
}
