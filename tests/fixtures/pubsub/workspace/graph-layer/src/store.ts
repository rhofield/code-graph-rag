import { UserCreated } from "./gen/events_pb";

const users = new Map<string, UserCreated>();

export function saveCachedUser(user: UserCreated): void {
  users.set(user.id, user);
}

export function getCachedUser(id: string): UserCreated | undefined {
  return users.get(id);
}
