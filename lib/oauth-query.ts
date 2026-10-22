// The signed authorization request the OAuth provider passes to /login and /consent, minus this app's own `error`.
export function oauthQueryOf(params: Record<string, string | string[] | undefined>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (key === 'error') continue;
    for (const item of ([] as (string | undefined)[]).concat(value)) if (item !== undefined) query.append(key, item);
  }
  return query.has('sig') ? query.toString() : '';
}
