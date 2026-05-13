import { GetUserResponse } from "./types";

export const resolvers = {
  Query: {
    user: (_parent: unknown, args: { id: string }): GetUserResponse => {
      return { id: args.id, name: "Ada" };
    },
  },
};
