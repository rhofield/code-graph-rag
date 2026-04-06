// tests/fixtures/cross-file-a.ts
export function validateToken(token: string): boolean {
  return token.length > 0;
}

export class AuthService {
  authenticate(token: string): boolean {
    return validateToken(token);
  }
}
