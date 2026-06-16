import { createPromiseClient } from "@connectrpc/connect";
import { UserService } from "@buf/example_user.connect";

const client = createPromiseClient(UserService, {} as never);

export const resolvers = {
  Query: {
    user: async (_parent: unknown, args: { id: string }) => {
      return client.getUser({ id: args.id });
    },
  },
};
