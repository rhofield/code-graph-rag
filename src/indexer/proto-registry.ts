export interface ProtoRpcDef {
  serviceName: string;
  methodName: string;
  methodCamel: string;
  requestType: string;
  responseType: string;
  packageName: string;
  protoFile: string;
  goPackage?: string;
}

export interface ProtoMessageDef {
  messageName: string;
  packageName: string;
  protoFile: string;
  goPackage?: string;
}

export class ProtoRegistry {
  private services = new Map<string, Map<string, ProtoRpcDef>>();
  private methodIndex = new Map<string, ProtoRpcDef[]>();
  private messages = new Map<string, ProtoMessageDef>();
  // Import paths declared via `option go_package`. Generated Go code lives at
  // exactly these paths, so a Go file importing one is proto-relevant even
  // when the path contains no "pb"/"proto"/"grpc" token (e.g. buf gen/ dirs).
  private goPackages = new Set<string>();

  private trackGoPackage(goPackage: string | undefined): void {
    if (goPackage) this.goPackages.add(goPackage);
  }

  hasGoPackagePath(importPath: string): boolean {
    return this.goPackages.has(importPath);
  }

  register(def: ProtoRpcDef): void {
    this.trackGoPackage(def.goPackage);
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

  getServiceMethodsInPackage(packageName: string, serviceName: string): ProtoRpcDef[] {
    return this.getServiceMethods(serviceName).filter((m) => m.packageName === packageName);
  }

  lookupByMessageTypeInPackage(messageType: string, packageName: string): ProtoRpcDef[] {
    return this.getAllServices()
      .flatMap((svc) => this.getServiceMethods(svc))
      .filter((m) =>
        m.packageName === packageName &&
        (m.requestType === messageType || m.responseType === messageType)
      );
  }

  getAllServices(): string[] {
    return [...this.services.keys()];
  }

  registerMessage(def: ProtoMessageDef): void {
    this.trackGoPackage(def.goPackage);
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
