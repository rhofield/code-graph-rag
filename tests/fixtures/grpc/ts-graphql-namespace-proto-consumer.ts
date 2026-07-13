import * as userv1 from "@buf/example_user.bufbuild_es/user/v1/user_pb";

export const resolvers = {
  Query: {
    user: (_parent: unknown, args: { id: string }): userv1.GetUserResponse => {
      return userv1.GetUserResponse.fromJson({ id: args.id, name: "Ada" });
    },
  },
};
