import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { SCOPE_NAMES, consentRequest, ownerSession } from '@/lib/auth';
import { getAuth } from '@/lib/auth-server';
import { oauthQueryOf } from '@/lib/oauth-query';

// Where the OAuth provider asks the owner whether an agent may read this memory.
export default async function Consent({ searchParams }: PageProps<'/consent'>) {
  const params = await searchParams;
  const oauthQuery = oauthQueryOf(params);
  const requestHeaders = await headers();
  const auth = await getAuth();
  if (!(await ownerSession(auth, requestHeaders))) redirect(`/login?${oauthQuery}`);
  const request = oauthQuery ? await consentRequest(auth, oauthQuery) : null;
  if (!request) {
    return (
      <main className="signin">
        <h1>Eleagent</h1>
        <p className="error" role="alert">This request has expired or is invalid. Start connecting again from the app.</p>
        <a href="/account">Your account</a>
      </main>
    );
  }
  // A Client ID Metadata Document URL says who the client really is; a display name alone could be anything.
  const verified = URL.canParse(request.clientId) ? new URL(request.clientId).host : null;
  return (
    <form className="signin" method="post" action="/api/account/consent">
      <h1>Connect {request.clientName}?</h1>
      {verified && <p className="hint">Published by {verified}</p>}
      {params.error === 'expired' && <p className="error" role="alert">That took too long. Start connecting again from the app.</p>}
      <p>It will be able to:</p>
      <ul>{request.scopes.map((scope) => <li key={scope}>{SCOPE_NAMES[scope] ?? scope}</li>)}</ul>
      <input type="hidden" name="oauth_query" value={request.oauthQuery} />
      <button type="submit" name="accept" value="allow">Allow</button>
      <button type="submit" name="accept" value="deny" className="quiet">Deny</button>
    </form>
  );
}
