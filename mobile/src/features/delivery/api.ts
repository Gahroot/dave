/**
 * The phone equivalent of src/ui/delivery-api.ts over useApi(): GET without a
 * body, POST with one, never retried, and failures carry the server's
 * returned `state` (e.g. on 409) so the caller keeps the draft and shows it.
 */
import { useMemo } from "react";
import type { DeliveryState } from "../../../../src/model/delivery-schema.ts";
import { ApiError } from "../../lib/api";
import { useApi } from "../../lib/connection";
import { deliveryErrorMessage, stateFromBody } from "./model";

export class DeliveryRequestError extends Error {
  readonly status: number;
  readonly state: DeliveryState | undefined;
  constructor(message: string, status: number, state?: DeliveryState) { super(message); this.status = status; this.state = state; this.name = "DeliveryRequestError"; }
}

export type DeliveryCall = <T>(url: string, body?: object) => Promise<T>;

export function useDeliveryApi(): DeliveryCall {
  const api = useApi();
  return useMemo(() => {
    async function call<T>(url: string, body?: object): Promise<T> {
      try {
        return body === undefined ? await api.get<T>(url, { timeoutMs: 30_000 }) : await api.post<T>(url, body, { timeoutMs: 30_000 });
      } catch (e) {
        if (e instanceof ApiError) throw new DeliveryRequestError(deliveryErrorMessage(e.body, e.status, url), e.status, stateFromBody(e.body));
        throw e;
      }
    }
    return call;
  }, [api]);
}
