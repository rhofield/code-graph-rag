import grpc
import user_pb2
import user_pb2_grpc

def fetch_user(channel, user_id):
    user_service = user_pb2_grpc.UserServiceStub(channel)
    user_service_helper = user_pb2_grpc.UserServiceHelperStub(channel)
    response = user_service_helper.GetUser(user_pb2.GetUserRequest(id=user_id))
    return response.name
