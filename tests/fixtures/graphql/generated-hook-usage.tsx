import {
  useGetApolloUserLazyQuery,
  useGetApolloUserQuery,
  useGetApolloUserSuspenseQuery,
} from "./apollo-generated-hooks";

export function ImportedGeneratedApolloUserCard({ id }: { id: string }) {
  const { data } = useGetApolloUserQuery({ variables: { id } });
  return <div>{data?.user?.name}</div>;
}

export function ImportedGeneratedApolloLazyUserCard({ id }: { id: string }) {
  const [loadUser] = useGetApolloUserLazyQuery({ variables: { id } });
  return <button onClick={() => loadUser()}>Load</button>;
}

export function ImportedGeneratedApolloSuspenseUserCard({ id }: { id: string }) {
  const { data } = useGetApolloUserSuspenseQuery({ variables: { id } });
  return <div>{data?.user?.name}</div>;
}
