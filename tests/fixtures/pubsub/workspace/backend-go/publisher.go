package events

import (
	"context"

	"cloud.google.com/go/pubsub"
	"google.golang.org/protobuf/proto"

	pb "example.com/backend/proto/events/v1"
)

const UserCreatedTopic = "user-created"

type Publisher struct {
	topic *pubsub.Topic
}

func NewPublisher(client *pubsub.Client) *Publisher {
	return &Publisher{topic: client.Topic(UserCreatedTopic)}
}

func (p *Publisher) PublishUserCreated(ctx context.Context, user *pb.UserCreated) error {
	data, err := proto.Marshal(user)
	if err != nil {
		return err
	}
	result := p.topic.Publish(ctx, &pubsub.Message{Data: data})
	_, err = result.Get(ctx)
	return err
}
