package main

import (
	"context"
	"fmt"
	pb "myproject/proto/user/v1"
)

// FakeUserServiceServer: struct name contains both the service name
// ("UserService") AND the token "Server", satisfying the OLD loose heuristic
// (`receiverText.includes(svcName) && /Server[)\s,]/.test(...)`). However,
// it does NOT embed pb.UnimplementedUserServiceServer, so under the new
// embedding-based detection it must NOT be annotated as a handler.
type FakeUserServiceServer struct {
	name string
}

// GetUser shares a name with the proto RPC but this struct is not a real
// gRPC handler — it's just a struct whose name happens to end in "Server".
func (f *FakeUserServiceServer) GetUser(ctx context.Context, req *pb.GetUserRequest) error {
	fmt.Println(f.name)
	return nil
}

func (f *FakeUserServiceServer) CreateUser(ctx context.Context, req *pb.CreateUserRequest) error {
	return nil
}
