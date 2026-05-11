import { UserServiceServer } from "./generated/user_grpc_pb";
import { GetUserRequest, GetUserResponse, CreateUserRequest, CreateUserResponse } from "./generated/user_pb";

class UserServiceImpl implements UserServiceServer {
  getUser(req: GetUserRequest): GetUserResponse {
    return new GetUserResponse().setId(req.getId()).setName("Alice");
  }

  createUser(req: CreateUserRequest): CreateUserResponse {
    return new CreateUserResponse().setId("new-id");
  }
}
