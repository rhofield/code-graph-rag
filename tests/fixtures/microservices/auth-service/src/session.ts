import { validateToken } from "./auth.js";

export class SessionManager {
  private sessions = new Map<string, string>();

  createSession(token: string): string | null {
    if (!validateToken(token)) {
      return null;
    }
    const sessionId = `session-${Date.now()}`;
    this.sessions.set(sessionId, token);
    return sessionId;
  }

  getSession(sessionId: string): string | null {
    return this.sessions.get(sessionId) ?? null;
  }

  destroySession(sessionId: string): void {
    this.sessions.delete(sessionId);
  }
}
