import { getCachedUser } from "./store";

export const resolvers = {
  Query: {
    pubsubUser: (_parent: unknown, args: { id: string }) => {
      return getCachedUser(args.id) ?? null;
    },
  },
};
