import { gql } from "@apollo/client";

export const GET_REALISTIC_USER = gql`
  query GetRealisticUser($id: ID!) {
    realisticUser(id: $id) {
      id
      name
      email
    }
  }
`;
