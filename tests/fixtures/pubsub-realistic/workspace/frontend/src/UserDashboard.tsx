import { useQuery } from "@apollo/client";
import { GET_REALISTIC_USER } from "./queries";

export function UserDashboard({ id }: { id: string }) {
  const { data } = useQuery(GET_REALISTIC_USER, { variables: { id } });
  return <div>{data?.realisticUser?.name}</div>;
}
