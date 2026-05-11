import { gql, useMutation, useQuery } from "@apollo/client";
import GetImportedUser from "./UserFields.graphql";

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
