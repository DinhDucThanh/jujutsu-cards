/**
 * A recorded stand-in for Web Audio.
 *
 * The synthesizers are only ever wrong in ways the type system cannot see: a ramp to zero,
 * a source that never starts, an envelope scheduled in the past, a scheduler that never
 * stops. Recording the calls catches those without needing an audio device in the runner.
 */

export interface RecordedEvent {
  readonly kind: string;
  readonly value: number;
  readonly time: number;
}

export class FakeParam {
  value = 0;
  readonly events: RecordedEvent[] = [];

  setValueAtTime(value: number, time: number): this {
    this.events.push({ kind: 'set', value, time });
    this.value = value;
    return this;
  }

  exponentialRampToValueAtTime(value: number, time: number): this {
    // Mirrors the real thing: exponential ramps cannot target or cross zero.
    if (value <= 0) throw new Error(`exponential ramp to ${value}`);
    this.events.push({ kind: 'exp', value, time });
    this.value = value;
    return this;
  }

  linearRampToValueAtTime(value: number, time: number): this {
    this.events.push({ kind: 'lin', value, time });
    this.value = value;
    return this;
  }

  setTargetAtTime(value: number, time: number): this {
    this.events.push({ kind: 'target', value, time });
    this.value = value;
    return this;
  }

  cancelScheduledValues(time: number): this {
    this.events.push({ kind: 'cancel', value: this.value, time });
    return this;
  }
}

export class FakeNode {
  readonly connections: FakeNode[] = [];

  connect(destination: FakeNode): FakeNode {
    this.connections.push(destination);
    return destination;
  }

  disconnect(): void {
    this.connections.length = 0;
  }
}

export class FakeSource extends FakeNode {
  onended: (() => void) | null = null;
  startedAt: number | null = null;
  stoppedAt: number | null = null;

  start(at = 0): void {
    this.startedAt = at;
  }

  stop(at = 0): void {
    this.stoppedAt = at;
  }
}

export class FakeOscillator extends FakeSource {
  type: OscillatorType = 'sine';
  readonly frequency = new FakeParam();
  readonly detune = new FakeParam();
}

export class FakeBufferSource extends FakeSource {
  buffer: unknown = null;
  loop = false;
}

export class FakeGain extends FakeNode {
  readonly gain = new FakeParam();
}

export class FakeFilter extends FakeNode {
  type: BiquadFilterType = 'lowpass';
  readonly frequency = new FakeParam();
  readonly Q = new FakeParam();
  // A real BiquadFilterNode exposes `gain` too (used by the peaking filter).
  readonly gain = new FakeParam();
}

export class FakeShaper extends FakeNode {
  curve: Float32Array | null = null;
  oversample: OverSampleType = 'none';
}

export class FakeCompressor extends FakeNode {
  readonly threshold = new FakeParam();
  readonly knee = new FakeParam();
  readonly ratio = new FakeParam();
  readonly attack = new FakeParam();
  readonly release = new FakeParam();
}

export class FakeDelay extends FakeNode {
  readonly delayTime = new FakeParam();
}

export class FakeStereoPanner extends FakeNode {
  readonly pan = new FakeParam();
}

export class FakeBuffer {
  constructor(private readonly length: number) {}

  getChannelData(): Float32Array {
    return new Float32Array(this.length);
  }
}

export class FakeContext {
  readonly destination = new FakeNode();
  readonly oscillators: FakeOscillator[] = [];
  readonly bufferSources: FakeBufferSource[] = [];
  readonly gains: FakeGain[] = [];
  readonly delays: FakeDelay[] = [];
  readonly compressors: FakeCompressor[] = [];
  readonly shapers: FakeShaper[] = [];
  readonly filters: FakeFilter[] = [];
  readonly panners: FakeStereoPanner[] = [];
  readonly sampleRate = 48_000;
  /** Tests advance this by hand; the schedulers read it, they never move it. */
  currentTime = 0;
  state: AudioContextState = 'running';

  createGain(): FakeGain {
    const gain = new FakeGain();
    this.gains.push(gain);
    return gain;
  }

  createOscillator(): FakeOscillator {
    const oscillator = new FakeOscillator();
    this.oscillators.push(oscillator);
    return oscillator;
  }

  createBufferSource(): FakeBufferSource {
    const source = new FakeBufferSource();
    this.bufferSources.push(source);
    return source;
  }

  createBiquadFilter(): FakeFilter {
    const filter = new FakeFilter();
    this.filters.push(filter);
    return filter;
  }

  createWaveShaper(): FakeShaper {
    const shaper = new FakeShaper();
    this.shapers.push(shaper);
    return shaper;
  }

  createDynamicsCompressor(): FakeCompressor {
    const compressor = new FakeCompressor();
    this.compressors.push(compressor);
    return compressor;
  }

  createStereoPanner(): FakeStereoPanner {
    const panner = new FakeStereoPanner();
    this.panners.push(panner);
    return panner;
  }

  createDelay(): FakeDelay {
    const delay = new FakeDelay();
    this.delays.push(delay);
    return delay;
  }

  createBuffer(_channels: number, length: number): FakeBuffer {
    return new FakeBuffer(length);
  }

  resume(): Promise<void> {
    this.state = 'running';
    return Promise.resolve();
  }

  close(): Promise<void> {
    this.state = 'closed';
    return Promise.resolve();
  }
}

export function asAudioContext(context: FakeContext): AudioContext {
  return context as unknown as AudioContext;
}

export function fakeStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    read: (key: string) => values.get(key) ?? null,
  };
}
