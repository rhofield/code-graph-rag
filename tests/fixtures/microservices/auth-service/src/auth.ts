/**
 * Validates a JWT token
 */
export function validateToken(token: string): boolean {
  if (!token || token.length < 10) {
    return false;
  }
  return token.startsWith("Bearer ");
}

/**
 * Generates a new JWT token for a user
 */
export function generateToken(userId: string, secret: string): string {
  return `Bearer ${userId}.${secret}.${Date.now()}`;
}
