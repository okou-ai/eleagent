import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { SCOPE_NAMES, listGrants, ownerSession } from '@/lib/auth';
import { getAuth } from '@/lib/auth-server';
import { sql } from '@/lib/db';
import { okou } from '@/lib/okou-server';

// The owner's connections: the MCP address to give agents, and the agents that may read this memory.
export default async function Account({ searchParams }: PageProps<'/account'>) {
  const { sleeping, okou: okouResult } = await searchParams;
  const requestHeaders = await headers();
  const auth = await getAuth();
  const session = await ownerSession(auth, requestHeaders);
  if (!session) redirect('/login?return_to=/account');
  const grants = await listGrants(auth, session.user.id);
  const okouStatus = await okou().status();
  const handoffs = await sql()`SELECT heard_at, request, status FROM handoffs ORDER BY heard_at DESC LIMIT 5`;
  const nights = await sql()`SELECT day::text AS day, status, cost_usd, error FROM sleep_days ORDER BY day DESC LIMIT 3`;
  const OKOU_MESSAGES: Record<string, string> = { connected: 'Okou is connected.', failed: 'Connecting Okou did not work; try again.',
    refused: 'Okou did not accept the connection. Connect again, and choose your organization when Okou asks.',
    unavailable: 'Okou could not be reached; try again later.' };
  return (
    <main className="signin">
      <h1>Eleagent</h1>
      <h2>Connect an agent</h2>
      <p className="hint">Add this MCP server address in your agent. It will ask you here to allow access.</p>
      <code>{auth.resource}</code>
      <h2>Connected agents</h2>
      {grants.length === 0 && <p className="hint">None yet.</p>}
      {grants.map((grant) => (
        <form key={grant.clientId} className="grant" method="post" action="/api/account/revoke">
          <strong>{grant.clientName}</strong>
          <span>{grant.scopes.map((scope) => SCOPE_NAMES[scope] ?? scope).join(' · ')}</span>
          <input type="hidden" name="client_id" value={grant.clientId} />
          <button type="submit" className="quiet">Disconnect</button>
        </form>
      ))}
      <h2>Okou</h2>
      <p className="hint">While recording, say “Hey Okou” or tap the Okou mark and say what you want: Eleagent hands the
        request to Okou in one conversation there.</p>
      {typeof okouResult === 'string' && OKOU_MESSAGES[okouResult] && <p className="hint" role="status">{OKOU_MESSAGES[okouResult]}</p>}
      {okouStatus.connected
        ? <p className="hint">Connected{okouStatus.since ? ` since ${new Date(okouStatus.since).toLocaleString('en')}` : ''}.</p>
        : <p className="hint">Not connected.</p>}
      {handoffs.map((handoff) => (
        <p key={String(handoff.heard_at)} className="hint">{new Date(handoff.heard_at).toLocaleString('en')} · {String(handoff.status)}: {String(handoff.request)}</p>
      ))}
      <form className="signin" method="post" action={okouStatus.connected ? '/api/okou/disconnect' : '/api/okou/connect'}>
        <button type="submit" className="quiet">{okouStatus.connected ? 'Disconnect Okou' : 'Connect Okou'}</button>
      </form>
      <h2>Memory</h2>
      <p className="hint">Each night Eleagent turns the day&apos;s recordings into memories and a diary. You can also do it now
        for today so far; it takes a few minutes.</p>
      {typeof sleeping === 'string' && <p className="hint" role="status">Writing the diary for {sleeping}…</p>}
      {nights.map((night) => (
        <p key={String(night.day)} className="hint" data-sleep-day={String(night.day)} data-sleep-status={String(night.status)}>
          {String(night.day)} · {String(night.status)} · ${Number(night.cost_usd).toFixed(4)}{night.error ? ` · ${String(night.error).slice(0, 300)}` : ''}
        </p>
      ))}
      <form className="signin" method="post" action="/api/sleep">
        <button type="submit" className="quiet">Write today&apos;s diary now</button>
      </form>
      {/* The capture page is a route handler serving plain HTML, not a Next.js page: navigate to it fully. */}
      {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
      <a href="/">Back to recording</a>
      <form className="signin" method="post" action="/api/auth/logout">
        <button type="submit" className="quiet">Sign out</button>
      </form>
    </main>
  );
}
