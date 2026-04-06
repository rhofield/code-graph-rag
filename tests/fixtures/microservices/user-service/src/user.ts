export class UserController {
  getUser(id: number): { id: number; name: string } | null {
    if (id <= 0) return null;
    return { id, name: `User ${id}` };
  }

  createUser(name: string, email: string): { id: number; name: string; email: string } {
    return { id: Math.floor(Math.random() * 1000), name, email };
  }

  deleteUser(id: number): boolean {
    return id > 0;
  }
}
