export interface ProtoRpcDef {
  serviceName: string;
  methodName: string;
  methodCamel: string;
  requestType: string;
  responseType: string;
  packageName: string;
  protoFile: string;
}

export interface ProtoMessageDef {
  messageName: string;
  packageName: string;
  protoFile: string;
}

export class ProtoRegistry {
  private services = new Map<string, Map<string, ProtoRpcDef>>();
  private methodIndex = new Map<string, ProtoRpcDef[]>();
  private messages = new Map<string, ProtoMessageDef>();

  register(def: ProtoRpcDef): void {
    if (!this.services.has(def.serviceName)) {
      this.services.set(def.serviceName, new Map());
    }
    this.services.get(def.serviceName)!.set(def.methodName, def);

    // Idempotent: the same proto can be parsed into a registry more than once
    // (workspace pre-scan + per-repo indexing), so replace rather than append
    // any prior entry for the same service::method.
    for (const key of [def.methodName, def.methodCamel]) {
      if (!this.methodIndex.has(key)) {
        this.methodIndex.set(key, []);
      }
      const defs = this.methodIndex.get(key)!;
      const existing = defs.findIndex(
        (d) => d.serviceName === def.serviceName && d.methodName === def.methodName
      );
      if (existing >= 0) {
        defs[existing] = def;
      } else {
        defs.push(def);
      }
    }
  }

  lookup(serviceName: string, methodName: string): ProtoRpcDef | null {
    return this.services.get(serviceName)?.get(methodName) ?? null;
  }

  lookupByMethod(methodName: string): ProtoRpcDef[] {
    return this.methodIndex.get(methodName) ?? [];
  }

  getServiceMethods(serviceName: string): ProtoRpcDef[] {
    const methods = this.services.get(serviceName);
    return methods ? [...methods.values()] : [];
  }

  getAllServices(): string[] {
    return [...this.services.keys()];
  }

  registerMessage(def: ProtoMessageDef): void {
    this.messages.set(`${def.packageName}::${def.messageName}`, def);
  }

  lookupMessage(messageName: string): ProtoMessageDef[] {
    return [...this.messages.values()].filter((m) => m.messageName === messageName);
  }

  getAllMessages(): ProtoMessageDef[] {
    return [...this.messages.values()];
  }
}

export function createProtoRegistry(): ProtoRegistry {
  return new ProtoRegistry();
}
