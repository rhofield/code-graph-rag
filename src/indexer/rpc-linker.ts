import type { DbConnection } from "../db/connection.js";
import type { RpcAnnotation } from "./rpc-detector.js";
import {
  batchSetRpcHandlerMeta,
  batchSetRpcCallerMeta,
  batchUpsertProtoUsageRelationships,
  resolveRpcEdges,
  clearRpcMetaForFiles,
} from "../db/queries.js";

export async function linkRpcEdges(
  db: DbConnection,
  annotations: RpcAnnotation[],
  touchedFilePaths: string[] = []
): Promise<number> {
  const session = db.session();
  try {
    if (touchedFilePaths.length > 0) {
      const clearQ = clearRpcMetaForFiles(touchedFilePaths);
      await session.run(clearQ.cypher, clearQ.params);
    }
    if (annotations.length === 0) return 0;
    const handlers = annotations.filter((a) => a.role === "handler");
    const callers = annotations.filter((a) => a.role === "caller");

    if (handlers.length > 0) {
      const handlerItems = handlers.map((h) => ({
        functionName: h.functionName,
        filePath: h.filePath,
        rpcService: h.serviceName,
        rpcMethod: h.methodName,
      }));
      const q = batchSetRpcHandlerMeta(handlerItems);
      await session.run(q.cypher, q.params);
    }

    if (callers.length > 0) {
      const callerMap = new Map<string, { services: string[]; methods: string[] }>();
      for (const c of callers) {
        const key = `${c.filePath}::${c.functionName}`;
        if (!callerMap.has(key)) {
          callerMap.set(key, { services: [], methods: [] });
        }
        const entry = callerMap.get(key)!;
        entry.services.push(c.serviceName);
        entry.methods.push(c.methodName);
      }

      const callerItems = [...callerMap.entries()].map(([key, val]) => {
        const sepIdx = key.indexOf("::");
        return {
          functionName: key.slice(sepIdx + 2),
          filePath: key.slice(0, sepIdx),
          rpcServices: val.services,
          rpcMethods: val.methods,
        };
      });
      const q = batchSetRpcCallerMeta(callerItems);
      await session.run(q.cypher, q.params);
    }

    const protoUsageItems = annotations.map((a) => ({
      functionName: a.functionName,
      filePath: a.filePath,
      serviceName: a.serviceName,
      methodName: a.methodName,
      role: a.role,
    }));
    const protoUsageQ = batchUpsertProtoUsageRelationships(protoUsageItems);
    await session.run(protoUsageQ.cypher, protoUsageQ.params);

    const resolveQ = resolveRpcEdges();
    const result = await session.run(resolveQ.cypher, resolveQ.params);
    const raw = result.records[0]?.get("edgesCreated");
    return typeof raw?.toNumber === "function" ? raw.toNumber() : (raw ?? 0);
  } finally {
    await session.close();
  }
}
