import { PubSub } from "@google-cloud/pubsub";
import { UserCreated } from "./gen/events_pb";

const USER_CREATED_TOPIC = "user-created";

const pubsub = new PubSub();

export async function publishUserCreated(user: UserCreated): Promise<string> {
  const data = Buffer.from(user.toBinary());
  return pubsub.topic(USER_CREATED_TOPIC).publishMessage({ data });
}
