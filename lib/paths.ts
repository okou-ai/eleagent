// Only same-site paths: "/x" but never "//host" or "/\host".
export function safeReturnTo(value: unknown): string {
  return typeof value === 'string' && /^\/(?![/\\])/.test(value) ? value : '/';
}
