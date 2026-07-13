import { ApolloServer } from "@apollo/server";
import { resolvers } from "./resolvers";

const typeDefs = `#graphql
  type User {
    id: ID!
    name: String!
    email: String!
  }

  type ShippedOrder {
    orderId: ID!
    userId: ID!
  }

  type Query {
    realisticUser(id: ID!): User
    realisticShippedOrder(orderId: ID!): ShippedOrder
  }
`;

export const server = new ApolloServer({ typeDefs, resolvers });
