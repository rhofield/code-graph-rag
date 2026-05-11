import { db } from "./database";

export function GetUser(id: string) {
  return db.query("SELECT * FROM users WHERE id = ?", [id]);
}

export function fetchUser(id: string) {
  const user = GetUser(id);
  return user;
}
