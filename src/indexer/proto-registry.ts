export interface ProtoRpcDef {
  serviceName: string;
  methodName: string;
  methodCamel: string;
  requestType: string;
  responseType: string;
  packageName: string;
  protoFile: string;
}

export class ProtoRegistry {
  private services = new Map<string, Map<string, ProtoRpcDef>>();
  private methodIndex = new Map<string, ProtoRpcDef[]>();

  register(def: ProtoRpcDef): void {
    if (!this.services.has(def.serviceName)) {
      this.services.set(def.serviceName, new Map());
    }
    this.services.get(def.serviceName)!.set(def.methodName, def);

    for (const key of [def.methodName, def.methodCamel]) {
      if (!this.methodIndex.has(key)) {
        this.methodIndex.set(key, []);
      }
      this.methodIndex.get(key)!.push(def);
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
}

export function createProtoRegistry(): ProtoRegistry {
  return new ProtoRegistry();
}
