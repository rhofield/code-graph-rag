import user_pb2
import user_pb2_grpc

class UserServiceServicer(user_pb2_grpc.UserServiceServicer):
    def GetUser(self, request, context):
        return user_pb2.GetUserResponse(id=request.id, name="Alice")

    def CreateUser(self, request, context):
        return user_pb2.CreateUserResponse(id="new-id")
