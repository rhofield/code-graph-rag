import grpc
import user_pb2
import user_pb2_grpc

def fetch_user(channel, user_id):
    stub = user_pb2_grpc.UserServiceStub(channel)
    response = stub.GetUser(user_pb2.GetUserRequest(id=user_id))
    return response.name
