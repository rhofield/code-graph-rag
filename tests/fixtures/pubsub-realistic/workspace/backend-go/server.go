package server

import (
	"context"

	eventsv1 "example.com/backend/gen/events/v1"
	usersv1 "example.com/backend/gen/users/v1"
)

// UserServer implements users.v1.UserService and publishes lifecycle events.
type UserServer struct {
	usersv1.UnimplementedUserServiceServer
	store     *Store
	publisher *Publisher
}

func (s *UserServer) GetUser(ctx context.Context, req *usersv1.GetUserRequest) (*usersv1.GetUserReply, error) {
	u := s.store.Lookup(req.GetId())
	return &usersv1.GetUserReply{Id: u.Id, Name: u.Name}, nil
}

// CreateUser builds the event and hands it to the generic publisher: the
// proto.Marshal call lives in the wrapper, not here.
func (s *UserServer) CreateUser(ctx context.Context, name, email string) error {
	u := s.store.Insert(name, email)
	evt := &eventsv1.UserCreated{Id: u.Id, Name: u.Name, Email: u.Email}
	return s.publisher.PublishEvent(ctx, "user-created", evt)
}

func (s *UserServer) ShipOrder(ctx context.Context, orderID, userID string) error {
	evt := &eventsv1.OrderShipped{OrderId: orderID, UserId: userID}
	return s.publisher.PublishEvent(ctx, "order-shipped", evt)
}

type Store struct{}

type StoredUser struct {
	Id    string
	Name  string
	Email string
}

func (st *Store) Lookup(id string) *StoredUser {
	return &StoredUser{Id: id, Name: "Ada", Email: "ada@example.com"}
}

func (st *Store) Insert(name, email string) *StoredUser {
	return &StoredUser{Id: "u-1", Name: name, Email: email}
}
