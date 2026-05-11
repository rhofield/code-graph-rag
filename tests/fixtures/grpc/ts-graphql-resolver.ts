import { createPromiseClient } from "@connectrpc/connect";
import { UserService } from "@buf/example_user.connect";

const userClient = createPromiseClient(UserService, {} as never);

export const resolvers = {
  Query: {
    user: async (_parent: unknown, args: { id: string }) => {
      const response = await userClient.getUser({ id: args.id });
      return response;
    },
  },
};
