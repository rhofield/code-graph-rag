// tests/fixtures/sample.ts

/** Greets a user by name */
export function greet(name: string): string {
  return `Hello, ${name}!`;
}

export class UserService {
  /** Creates a new user */
  createUser(name: string, email: string): User {
    const validated = validateEmail(email);
    return { name, email: validated };
  }

  getUser(id: number): User | null {
    return null;
  }
}

function validateEmail(email: string): string {
  if (!email.includes("@")) {
    throw new Error("Invalid email");
  }
  return email.toLowerCase();
}

interface User {
  name: string;
  email: string;
}
