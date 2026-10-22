const MESSAGES: Record<string, string> = {
  wrong: 'Wrong password.',
  locked: 'Too many attempts. Try again in 15 minutes.',
  unconfigured: 'Set OWNER_PASSWORD in the project settings and redeploy.',
  invalid: 'Please try again.',
};

export default async function Login({ searchParams }: PageProps<'/login'>) {
  const params = await searchParams;
  const error = typeof params.error === 'string' ? MESSAGES[params.error] : undefined;
  const returnTo = typeof params.return_to === 'string' ? params.return_to : '/';
  return (
    <form className="signin" method="post" action="/api/auth/login">
      <h1>Eleagent</h1>
      {error && <p className="error" role="alert">{error}</p>}
      <input type="password" name="password" placeholder="Password" autoComplete="current-password" required autoFocus />
      <input type="hidden" name="return_to" value={returnTo} />
      <button type="submit">Sign in</button>
    </form>
  );
}
