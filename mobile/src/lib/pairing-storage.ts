/**
 * The pairing key is a bearer secret for every DAVE action on the Mac, so it
 * lives only in the platform keychain (expo-secure-store), never in plain app
 * storage or logs. Values are re-validated on the way out.
 */
import * as SecureStore from "expo-secure-store";
import { DEVICE_ID_PATTERN, newDeviceId, pairingLink, parsePairingLink, type PairingOffer } from "../../../src/mobile/protocol.ts";

const OFFER_KEY = "dave.pairing.link";
const DEVICE_KEY = "dave.device.id";
const HOST_KEY = "dave.pairing.host";
const OPTIONS: SecureStore.SecureStoreOptions = { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY };

/** A stable, CSPRNG-minted id for this install; the Mac binds its pairing to it. */
export async function loadDeviceId(): Promise<string> {
  const existing = await SecureStore.getItemAsync(DEVICE_KEY, OPTIONS);
  if (existing && DEVICE_ID_PATTERN.test(existing)) return existing;
  const minted = newDeviceId();
  await SecureStore.setItemAsync(DEVICE_KEY, minted, OPTIONS);
  return minted;
}

export type StoredPairing = { offer: PairingOffer; preferredHost: string };

export async function loadPairing(): Promise<StoredPairing | null> {
  const link = await SecureStore.getItemAsync(OFFER_KEY, OPTIONS);
  if (!link) return null;
  const parsed = parsePairingLink(link);
  if (!parsed.ok) return null;
  const host = await SecureStore.getItemAsync(HOST_KEY, OPTIONS);
  const preferredHost = host && parsed.offer.hosts.includes(host) ? host : parsed.offer.hosts[0] ?? "";
  return { offer: parsed.offer, preferredHost };
}

export async function savePairing(offer: PairingOffer, preferredHost: string): Promise<void> {
  await SecureStore.setItemAsync(OFFER_KEY, pairingLink(offer), OPTIONS);
  await SecureStore.setItemAsync(HOST_KEY, preferredHost, OPTIONS);
}

export async function savePreferredHost(host: string): Promise<void> {
  await SecureStore.setItemAsync(HOST_KEY, host, OPTIONS);
}

/** Forget the Mac on this phone. The device id is kept so a re-pair is the same phone. */
export async function clearPairing(): Promise<void> {
  await SecureStore.deleteItemAsync(OFFER_KEY, OPTIONS);
  await SecureStore.deleteItemAsync(HOST_KEY, OPTIONS);
}
