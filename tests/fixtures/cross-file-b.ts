// tests/fixtures/cross-file-b.ts
import { validateToken, AuthService } from "./cross-file-a";

export function handleRequest(token: string): string {
  if (!validateToken(token)) {
    return "unauthorized";
  }
  return "ok";
}

export class Router {
  private auth = new AuthService();

  route(token: string): string {
    return handleRequest(token);
  }
}
