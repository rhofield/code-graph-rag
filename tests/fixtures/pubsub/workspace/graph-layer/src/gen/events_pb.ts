// Generated stub mimicking @bufbuild/protobuf codegen for events.proto.
export class UserCreated {
  id = "";
  name = "";
  email = "";

  static fromBinary(_bytes: Uint8Array): UserCreated {
    return new UserCreated();
  }

  toBinary(): Uint8Array {
    return new Uint8Array();
  }
}
