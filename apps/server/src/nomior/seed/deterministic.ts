/**
 * deterministic - the frozen clock and counter-seeded crypto the seeder runs
 * under.
 *
 * The scenario carries fixed ids and timestamps, but the services it writes
 * through do not: `ContextIngest` stamps `ingested_at` from the clock and
 * mints source ids from `Crypto.randomUUIDv4`. Freezing both is what makes a
 * re-seed byte-identical instead of merely "the same data with new ids", so
 * the idempotency test can compare content, not just row counts.
 *
 * Only the seed and simulation entry points use these layers. Nothing here is
 * cryptographically random — that is the point, and it is why the layers are
 * named for it.
 *
 * @module nomior/seed/deterministic
 */
import * as NodeCrypto from "node:crypto";

import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

const DIGEST_ALGORITHMS: Record<Crypto.DigestAlgorithm, string> = {
  "SHA-1": "sha1",
  "SHA-256": "sha256",
  "SHA-384": "sha384",
  "SHA-512": "sha512",
};

/**
 * splitmix32: a tiny, well-mixed counter PRNG. Deterministic by construction —
 * the nth byte block of a run depends only on n.
 */
const makeByteStream = (seed: number): ((size: number) => Uint8Array) => {
  let state = seed >>> 0;
  const nextUint32 = (): number => {
    state = (state + 0x9e3779b9) >>> 0;
    let z = state;
    z = Math.imul(z ^ (z >>> 16), 0x21f0aaad) >>> 0;
    z = Math.imul(z ^ (z >>> 15), 0x735a2d97) >>> 0;
    return (z ^ (z >>> 15)) >>> 0;
  };
  return (size) => {
    const bytes = new Uint8Array(size);
    for (let index = 0; index < size; index += 1) {
      bytes[index] = nextUint32() & 0xff;
    }
    return bytes;
  };
};

export const SEED_CRYPTO_SEED = 0x6e6f6d69;

/**
 * Crypto whose randomness is a counter. `digest` is the real thing (node's
 * hashes) so a caller that hashes still gets correct output.
 */
export const makeDeterministicCrypto = (seed: number = SEED_CRYPTO_SEED): Crypto.Crypto => {
  const randomBytes = makeByteStream(seed);
  return Crypto.make({
    randomBytes,
    digest: (algorithm, data) =>
      Effect.sync(() =>
        Uint8Array.from(NodeCrypto.createHash(DIGEST_ALGORITHMS[algorithm]).update(data).digest()),
      ),
  });
};

/** Overrides whatever platform Crypto is in scope. Fresh counter per build. */
export const DeterministicCryptoLive = Layer.sync(Crypto.Crypto, () => makeDeterministicCrypto());

/**
 * Wall-clock reads answer `instant`; sleeping and elapsed-time measurement
 * keep delegating to the ambient clock, so nothing that waits can hang.
 */
export const frozenClockAt = (instant: string): Effect.Effect<Clock.Clock> =>
  Clock.clockWith((base) => {
    const millis = Date.parse(instant);
    if (Number.isNaN(millis)) {
      return Effect.die(new Error(`frozenClockAt: '${instant}' is not a parseable instant`));
    }
    const nanos = BigInt(millis) * 1_000_000n;
    return Effect.succeed<Clock.Clock>({
      currentTimeMillisUnsafe: () => millis,
      currentTimeMillis: Effect.succeed(millis),
      currentTimeNanosUnsafe: () => nanos,
      currentTimeNanos: Effect.succeed(nanos),
      monotonicTimeNanosUnsafe: () => base.monotonicTimeNanosUnsafe(),
      monotonicTimeNanos: base.monotonicTimeNanos,
      sleep: (duration) => base.sleep(duration),
    });
  });

export const FrozenClockLive = (instant: string): Layer.Layer<never> =>
  Layer.effect(Clock.Clock, frozenClockAt(instant));

/** Frozen clock + counter crypto: everything the seeder needs to repeat itself. */
export const DeterministicSeedRuntime = (instant: string): Layer.Layer<Crypto.Crypto> =>
  Layer.mergeAll(DeterministicCryptoLive, FrozenClockLive(instant));
