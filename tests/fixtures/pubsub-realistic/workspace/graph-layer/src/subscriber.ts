import { PubSub, Message } from "@google-cloud/pubsub";
import { UserCreated, OrderShipped } from "./gen/events_pb";
import { saveCachedUser, saveShippedOrder } from "./store";

export function startSubscribers(): void {
  const ps = new PubSub();
  ps.subscription("user-created.graph-layer").on("message", handleUserCreated);
  // Inline anonymous handler — common in real subscriber setup code.
  ps.subscription("order-shipped.graph-layer").on("message", (message: Message) => {
    const evt = OrderShipped.fromBinary(message.data);
    saveShippedOrder(evt);
    message.ack();
  });
}

export function handleUserCreated(message: Message): void {
  const event = UserCreated.fromBinary(message.data);
  saveCachedUser(event);
  message.ack();
}
