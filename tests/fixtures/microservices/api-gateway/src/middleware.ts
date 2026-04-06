export function authMiddleware(token: string): boolean {
  return token.length > 0;
}

export function rateLimiter(clientId: string): boolean {
  // Simple stub: allow all requests
  return true;
}
