/**
 * Room codes are short enough to read off one screen and type on another, and are the
 * only thing the two players have to exchange. The PeerJS id is derived from the code.
 */

export const ROOM_ID_PREFIX = 'jjk-sorcery-';

/** No 0/O/1/I: the alphabet avoids pairs that are misread when a code is copied by hand. */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 5;

/** Uppercases and validates a typed code, or returns null when it cannot be a room. */
export function normalizeRoomCode(input: string): string | null {
  const code = input.trim().toUpperCase().replace(/[\s-]/g, '');
  if (code.length !== CODE_LENGTH) return null;
  for (const character of code) {
    if (!CODE_ALPHABET.includes(character)) return null;
  }
  return code;
}

/** A fresh room code, e.g. `K7QP4`. */
export function createRoomCode(random: (max: number) => number = randomInt): string {
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i++) code += CODE_ALPHABET[random(CODE_ALPHABET.length)];
  return code;
}

/** The PeerJS id the host registers for a room code. */
export function peerIdForRoom(code: string): string {
  return `${ROOM_ID_PREFIX}${code}`;
}

function randomInt(max: number): number {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi?.getRandomValues) {
    const buffer = new Uint32Array(1);
    cryptoApi.getRandomValues(buffer);
    return (buffer[0] as number) % max;
  }
  return Math.floor(Math.random() * max);
}
