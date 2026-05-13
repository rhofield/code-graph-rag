import { userClient } from "./clients";

async function getUserResolver(_parent: unknown, args: { id: string }) {
  return userClient.getUser({ id: args.id });
}

export const resolvers = {
  Query: {
    user(_parent: unknown, args: { id: string }) {
      return userClient.getUser({ id: args.id });
    },
    viewer: function (_parent: unknown, args: { id: string }) {
      return userClient.getUser({ id: args.id });
    },
    me: getUserResolver,
  },
};
