import { ApolloServer } from "@apollo/server";
import { resolvers } from "./resolvers";

const typeDefs = `#graphql
  type User {
    id: ID!
    name: String!
    email: String!
  }

  type Query {
    pubsubUser(id: ID!): User
  }
`;

export const server = new ApolloServer({ typeDefs, resolvers });
