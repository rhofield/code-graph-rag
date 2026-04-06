import { authMiddleware, rateLimiter } from "./middleware.js";

export class Router {
  route(path: string, token: string): string {
    if (!rateLimiter("client")) {
      return "rate_limited";
    }
    if (!authMiddleware(token)) {
      return "unauthorized";
    }
    return `routed:${path}`;
  }
}
