import { getCachedUser, getShippedOrder } from "./store";

export const resolvers = {
  Query: {
    realisticUser: (_parent: unknown, args: { id: string }) => {
      return getCachedUser(args.id) ?? null;
    },
    realisticShippedOrder: (_parent: unknown, args: { orderId: string }) => {
      return getShippedOrder(args.orderId) ?? null;
    },
  },
};
