import { UserController } from "./user.js";

export class ProfileService {
  private userController = new UserController();

  getProfile(userId: number): { user: object; bio: string } | null {
    const user = this.userController.getUser(userId);
    if (!user) return null;
    return { user, bio: `Bio for ${user.name}` };
  }

  updateProfile(userId: number, bio: string): boolean {
    const user = this.userController.getUser(userId);
    return user !== null;
  }
}
