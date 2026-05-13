import { gql } from "@apollo/client";

export const GET_APOLLO_USER = gql`
  query GetApolloUser($id: ID!) {
    user(id: $id) {
      id
      name
    }
  }
`;

export function useGetApolloUserQuery(_args: unknown) {
  return { data: null };
}

export function useGetApolloUserLazyQuery(_args: unknown) {
  return [() => undefined, { data: null }] as const;
}

export function useGetApolloUserSuspenseQuery(_args: unknown) {
  return { data: null };
}
