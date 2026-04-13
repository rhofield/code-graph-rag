package main

import (
	"context"
	"fmt"
	pb "myproject/proto/user/v1"
	"google.golang.org/grpc"
)

func fetchUser(ctx context.Context, client pb.UserServiceClient, id string) {
	resp, err := client.GetUser(ctx, &pb.GetUserRequest{Id: id})
	if err != nil {
		fmt.Println(err)
		return
	}
	fmt.Println(resp.Name)
}
