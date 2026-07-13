package server

import (
	"context"

	"cloud.google.com/go/pubsub"
	"google.golang.org/protobuf/proto"
)

// Publisher is a generic event publisher: it marshals any proto message, so
// no concrete message name ever appears in this file.
type Publisher struct {
	client *pubsub.Client
}

func NewPublisher(client *pubsub.Client) *Publisher {
	return &Publisher{client: client}
}

func (p *Publisher) PublishEvent(ctx context.Context, topic string, msg proto.Message) error {
	data, err := proto.Marshal(msg)
	if err != nil {
		return err
	}
	result := p.client.Topic(topic).Publish(ctx, &pubsub.Message{Data: data})
	_, err = result.Get(ctx)
	return err
}
