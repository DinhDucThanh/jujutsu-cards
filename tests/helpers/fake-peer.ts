/**
 * A recorded stand-in for PeerJS.
 *
 * The room transport is only ever wrong in ways the type system cannot see: a status that
 * never advances, a deadline that never fires, a dead peer left answering for a live one.
 * Driving the fake's events by hand catches those without a signaling server or a network.
 */

type Handler = (...args: never[]) => void;

export class FakeConnection {
  open = false;
  closed = false;
  readonly sent: string[] = [];
  private readonly handlers = new Map<string, Handler[]>();

  constructor(readonly peer: string) {}

  on(event: string, handler: Handler): this {
    const list = this.handlers.get(event) ?? [];
    list.push(handler);
    this.handlers.set(event, list);
    return this;
  }

  emit(event: string, ...args: unknown[]): void {
    for (const handler of this.handlers.get(event) ?? []) {
      (handler as (...values: unknown[]) => void)(...args);
    }
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.open = false;
    this.emit('close');
  }

  /** Opens the channel the way PeerJS does: the flag first, then the event. */
  arrive(): void {
    this.open = true;
    this.emit('open');
  }
}

export class FakePeer {
  static readonly instances: FakePeer[] = [];

  readonly id: string | null;
  readonly options: Record<string, unknown>;
  readonly handlers = new Map<string, Handler[]>();
  readonly dials: FakeConnection[] = [];
  destroyed = false;
  reconnects = 0;
  open = false;

  /** `new Peer(id, options)` for a host; `new Peer(options)` for a guest. */
  constructor(idOrOptions?: unknown, maybeOptions?: unknown) {
    this.id = typeof idOrOptions === 'string' ? idOrOptions : null;
    this.options = (maybeOptions ?? idOrOptions ?? {}) as Record<string, unknown>;
    FakePeer.instances.push(this);
  }

  static reset(): void {
    FakePeer.instances.length = 0;
  }

  static last(): FakePeer {
    const peer = FakePeer.instances.at(-1);
    if (!peer) throw new Error('No FakePeer was constructed');
    return peer;
  }

  on(event: string, handler: Handler): this {
    const list = this.handlers.get(event) ?? [];
    list.push(handler);
    this.handlers.set(event, list);
    return this;
  }

  emit(event: string, ...args: unknown[]): void {
    for (const handler of this.handlers.get(event) ?? []) {
      (handler as (...values: unknown[]) => void)(...args);
    }
  }

  connect(peerId: string): FakeConnection {
    const connection = new FakeConnection(peerId);
    this.dials.push(connection);
    return connection;
  }

  /** Registers the id on the signaling server and reports it. */
  claim(): void {
    this.open = true;
    this.emit('open', this.id);
  }

  reconnect(): void {
    this.reconnects += 1;
  }

  destroy(): void {
    this.destroyed = true;
    this.open = false;
  }
}
