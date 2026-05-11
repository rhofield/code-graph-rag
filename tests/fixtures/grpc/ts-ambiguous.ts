import { UserServiceClient, UserServiceHelperClient } from "./generated/user_grpc_pb";

export async function run(
  userService: UserServiceClient,
  userServiceHelper: UserServiceHelperClient
) {
  await userServiceHelper.getUser({ id: "x" }); // must resolve to UserServiceHelper, not UserService
}
