declare module "hyperswarm" {
  import { Duplex } from "stream";
  import { EventEmitter } from "events";

  interface PeerInfo {
    publicKey: Buffer;
    topics: Buffer[];
  }

  interface JoinOptions {
    server?: boolean;
    client?: boolean;
  }

  class Hyperswarm extends EventEmitter {
    constructor(opts?: { seed?: Buffer; maxPeers?: number });

    join(topic: Buffer, opts?: JoinOptions): void;
    leave(topic: Buffer): Promise<void>;
    destroy(): Promise<void>;

    on(event: "connection", listener: (socket: Duplex, info: PeerInfo) => void): this;
    on(event: "update", listener: () => void): this;
    on(event: string, listener: (...args: any[]) => void): this;

    connections: Set<Duplex>;
    peers: Map<string, PeerInfo>;
    topics: Map<string, { server: boolean; client: boolean }>;
  }

  export = Hyperswarm;
}
