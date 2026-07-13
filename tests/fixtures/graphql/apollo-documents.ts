import { gql } from "@apollo/client";

export const GET_APOLLO_USER = gql`
  query GetApolloUser($id: ID!) {
    user(id: $id) {
      id
      name
    }
  }
`;

export const UPDATE_APOLLO_USER = gql`
  mutation UpdateApolloUser($id: ID!, $name: String!) {
    updateUser(id: $id, name: $name) {
      id
      name
    }
  }
`;
