// TEST ONLY: a fake resource-auth boundary for graph/backend and MCP protocol
// tests, not an OAuth implementation or evidence of OAuth security. Real OAuth
// verification is covered by auth.test.mjs and oauth-integration.test.mjs.
// Keep this test-* module out of the runtime image's explicit Docker COPY list.
export function resourceAuth(token) {
  if (typeof token !== 'string' || !token) throw new TypeError('A synthetic fixture token is required');
  const authPublicUrl = 'https://graph-protocol-fixture.invalid';
  const granted = ['graph:read', 'media:read'];
  const challenge = (status, scopes) => Response.json({
    error: {
      code: status === 401 ? 'unauthorized' : 'insufficient_scope',
      message: status === 401 ? 'Synthetic fixture bearer required' : 'Fixture scope not granted',
    },
  }, {
    status,
    headers: { 'WWW-Authenticate': `Bearer resource_metadata="${authPublicUrl}/.well-known/oauth-protected-resource/mcp", scope="${scopes.join(' ')}"` },
  });
  return {
    authPublicUrl,
    authService: {
      async verify(request, { scopes = [] } = {}) {
        if (request.headers.get('authorization') !== `Bearer ${token}`) return challenge(401, scopes);
        if (scopes.some((scope) => !granted.includes(scope))) return challenge(403, scopes);
        return { userId: 'synthetic-resource-owner', scopes: [...granted] };
      },
    },
  };
}
