import { UserServiceClient } from "./generated/user_grpc_pb";

async function loadUser(client: UserServiceClient, userId: string) {
  const response = await client.getUser({ id: userId });
  return response.name;
}
