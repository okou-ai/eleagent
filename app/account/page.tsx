import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { SCOPE_NAMES, listGrants, ownerSession } from '@/lib/auth';
import { getAuth } from '@/lib/auth-server';

// The owner's connections: the MCP address to give agents, and the agents that may read this memory.
export default async function Account({ searchParams }: PageProps<'/account'>) {
  const { sleeping } = await searchParams;
  const requestHeaders = await headers();
  const auth = await getAuth();
  const session = await ownerSession(auth, requestHeaders);
  if (!session) redirect('/login?return_to=/account');
  const grants = await listGrants(auth, session.user.id);
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
      <h2>Memory</h2>
      <p className="hint">Each night Eleagent turns the day&apos;s recordings into memories and a diary. You can also do it now
        for today so far; it takes a few minutes.</p>
      {typeof sleeping === 'string' && <p className="hint" role="status">Writing the diary for {sleeping}…</p>}
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
