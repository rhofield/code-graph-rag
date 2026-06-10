import { PubSub, Message } from "@google-cloud/pubsub";
import { UserCreated } from "./gen/events_pb";
import { saveCachedUser } from "./store";

const USER_CREATED_SUBSCRIPTION = "user-created.graph-layer";

export function startUserCreatedSubscriber(): void {
  const subscription = new PubSub().subscription(USER_CREATED_SUBSCRIPTION);
  subscription.on("message", handleUserCreated);
}

export function handleUserCreated(message: Message): void {
  const event = UserCreated.fromBinary(message.data);
  saveCachedUser(event);
  message.ack();
}
