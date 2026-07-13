import { gql } from "@apollo/client";

export const GET_PUBSUB_USER = gql`
  query GetPubsubUser($id: ID!) {
    pubsubUser(id: $id) {
      id
      name
      email
    }
  }
`;
