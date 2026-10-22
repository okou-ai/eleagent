import { oauthQueryOf } from '@/lib/oauth-query';

const MESSAGES: Record<string, string> = {
  wrong: 'Wrong password.',
  locked: 'Too many attempts. Try again in 15 minutes.',
  unconfigured: 'Set OWNER_PASSWORD in the project settings and redeploy.',
  expired: 'This request has expired. Start connecting again from the app that asked.',
  invalid: 'Please try again.',
};

export default async function Login({ searchParams }: PageProps<'/login'>) {
  const params = await searchParams;
  const error = typeof params.error === 'string' ? MESSAGES[params.error] : undefined;
  // An agent's authorization sent the owner here: signing in continues it.
  const oauthQuery = oauthQueryOf(params);
  const returnTo = typeof params.return_to === 'string' ? params.return_to : '/';
  return (
    <form className="signin" method="post" action="/api/auth/login">
      <h1>Eleagent</h1>
      {oauthQuery && <p className="hint">Sign in to connect an app to your memory.</p>}
      {error && <p className="error" role="alert">{error}</p>}
      <input type="password" name="password" placeholder="Password" autoComplete="current-password" required autoFocus />
      {oauthQuery ? <input type="hidden" name="oauth_query" value={oauthQuery} /> : <input type="hidden" name="return_to" value={returnTo} />}
      <button type="submit">Sign in</button>
    </form>
  );
}
