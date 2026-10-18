/**
 * The wire protocol draws keys and request ids from
 * `globalThis.crypto.getRandomValues`. Hermes has no Web Crypto, so install
 * the platform CSPRNG from expo-crypto before anything else runs. Never
 * substitute Math.random: a predictable request id or device id would weaken
 * replay protection and the one-phone pairing claim.
 */
import { getRandomValues } from "expo-crypto";

type RandomSource = { getRandomValues: <T extends Uint8Array>(array: T) => T };
const scope = globalThis as { crypto?: Partial<RandomSource> };
if (typeof scope.crypto?.getRandomValues !== "function") {
  const source: RandomSource = { getRandomValues: (array) => getRandomValues(array) };
  if (scope.crypto) Object.assign(scope.crypto, source);
  else Object.defineProperty(globalThis, "crypto", { value: source, configurable: true });
}
