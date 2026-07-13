import { gql, useMutation, useQuery } from "@apollo/client";
import GetImportedUser from "./UserFields.graphql";
import { GET_APOLLO_USER, UPDATE_APOLLO_USER as RENAMED_APOLLO_UPDATE } from "./apollo-documents";
import { GET_APOLLO_USER as BARREL_APOLLO_USER } from "./apollo-barrel";

const AVATAR_FIELDS = gql`
  fragment AvatarFields on User {
    avatarUrl
  }
`;

const USER_FIELDS = gql`
  ${AVATAR_FIELDS}
  fragment UserFields on User {
    id
    name
    ...AvatarFields
  }
`;

const GET_USER = gql`
  ${USER_FIELDS}
  query GetUser($id: ID!) {
    user(id: $id) {
      ...UserFields
    }
  }
`;

const UPDATE_USER = gql`
  mutation UpdateUser($id: ID!, $name: String!) {
    updateUser(id: $id, name: $name) {
      id
      name
    }
  }
`;

export function UserCard({ id }: { id: string }) {
  const { data } = useQuery(GET_USER, { variables: { id } });
  return <div>{data?.user?.name}</div>;
}

export function ImportedUserCard({ id }: { id: string }) {
  const { data } = useQuery(GetImportedUser, { variables: { id } });
  return <div>{data?.user?.name}</div>;
}

export function RenameUser({ id }: { id: string }) {
  const [rename] = useMutation(UPDATE_USER);
  return <button onClick={() => rename({ variables: { id, name: "Ada" } })}>Rename</button>;
}

export function InlineApolloUserCard({ id }: { id: string }) {
  const { data } = useQuery(gql`
    query InlineApolloUser($id: ID!) {
      user(id: $id) {
        id
        name
      }
    }
  `, { variables: { id } });
  return <div>{data?.user?.name}</div>;
}

export function ImportedApolloUserCard({ id, client }: { id: string; client: { query(args: unknown): unknown } }) {
  client.query({ query: GET_APOLLO_USER, variables: { id } });
  return <div>{id}</div>;
}

export function ImportedApolloRename({ id }: { id: string }) {
  const [rename] = useMutation(RENAMED_APOLLO_UPDATE);
  return <button onClick={() => rename({ variables: { id, name: "Grace" } })}>Rename</button>;
}

export function BarrelApolloUserCard({ id }: { id: string }) {
  const { data } = useQuery(BARREL_APOLLO_USER, { variables: { id } });
  return <div>{data?.user?.name}</div>;
}

export function GeneratedApolloUserCard({ id }: { id: string }) {
  const { data } = useGetApolloUserQuery({ variables: { id } });
  return <div>{data?.user?.name}</div>;
}
