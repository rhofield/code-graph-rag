import { UserCreated, OrderShipped } from "./gen/events_pb";

const users = new Map<string, UserCreated>();
const shippedOrders = new Map<string, OrderShipped>();

export function saveCachedUser(user: UserCreated): void {
  users.set(user.id, user);
}

export function getCachedUser(id: string): UserCreated | undefined {
  return users.get(id);
}

export function saveShippedOrder(order: OrderShipped): void {
  shippedOrders.set(order.orderId, order);
}

export function getShippedOrder(orderId: string): OrderShipped | undefined {
  return shippedOrders.get(orderId);
}
