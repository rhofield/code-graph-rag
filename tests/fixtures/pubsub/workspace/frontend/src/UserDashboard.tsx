import { useQuery } from "@apollo/client";
import { GET_PUBSUB_USER } from "./queries";

export function UserDashboard({ id }: { id: string }) {
  const { data } = useQuery(GET_PUBSUB_USER, { variables: { id } });
  return <div>{data?.pubsubUser?.name}</div>;
}
