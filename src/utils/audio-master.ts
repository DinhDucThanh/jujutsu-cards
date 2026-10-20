/**
 * The shared output stage for SFX and BGM. Both engines feed their master bus into this chain,
 * which lifts quiet laptop and PC speaker output and then tames peaks before they reach the
 * speakers, so the louder gains never clip.
 *
 *   master bus -> pre-amp boost -> DynamicsCompressor -> destination
 */

/** Linear pre-amp gain (about +6.8 dB) applied ahead of the compressor. */
export const MASTER_PREAMP_GAIN = 2.2;

/**
 * Builds the output stage and returns its input node. Callers connect their master bus to it;
 * the compressor is connected to the context destination.
 */
export function createMasterOutput(context: AudioContext): AudioNode {
  const now = context.currentTime;
  const compressor = context.createDynamicsCompressor();
  // A transparent soft limiter: fast attack, short release, catches only the peaks the boosted
  // channels can throw so the louder mix never clips the speakers.
  compressor.threshold.setValueAtTime(-3, now);
  compressor.knee.setValueAtTime(8, now);
  compressor.ratio.setValueAtTime(4, now);
  compressor.attack.setValueAtTime(0.003, now);
  compressor.release.setValueAtTime(0.12, now);
  compressor.connect(context.destination);

  const preamp = context.createGain();
  preamp.gain.setValueAtTime(MASTER_PREAMP_GAIN, now);
  preamp.connect(compressor);
  return preamp;
}
