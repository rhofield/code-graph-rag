import { SharedResponse } from "@buf/example_user.bufbuild_es/user/v1/user_pb";

export const resolvers = {
  Query: {
    user: (_parent: unknown): SharedResponse => {
      return {} as SharedResponse;
    },
  },
};
