package com.example.gateway;

import com.example.proto.UserServiceGrpc;
import com.example.proto.User.GetUserRequest;
import com.example.proto.User.GetUserResponse;
import io.grpc.ManagedChannel;

public class UserClient {
    private final UserServiceGrpc.UserServiceBlockingStub stub;

    public UserClient(ManagedChannel channel) {
        this.stub = UserServiceGrpc.newBlockingStub(channel);
    }

    public String fetchUserName(String userId) {
        GetUserResponse response = stub.getUser(
            GetUserRequest.newBuilder().setId(userId).build()
        );
        return response.getName();
    }
}
