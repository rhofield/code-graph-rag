package com.example.userservice;

import com.example.proto.UserServiceGrpc;
import com.example.proto.User.GetUserRequest;
import com.example.proto.User.GetUserResponse;
import com.example.proto.User.CreateUserRequest;
import com.example.proto.User.CreateUserResponse;

public class UserServiceImpl extends UserServiceGrpc.UserServiceImplBase {
    @Override
    public GetUserResponse getUser(GetUserRequest request) {
        return GetUserResponse.newBuilder()
            .setId(request.getId())
            .setName("Alice")
            .build();
    }

    @Override
    public CreateUserResponse createUser(CreateUserRequest request) {
        return CreateUserResponse.newBuilder()
            .setId("new-id")
            .build();
    }
}
