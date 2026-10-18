import { deliveryApi } from "./delivery-api.ts";
import type { ProgressReport, WorkEvent, WorkSettingsView } from "../work/types.ts";

/** Browser client for the completion loop (/api/intel/work/*). Mutations are never retried automatically. */
export const workApi = {
  progress: (limit = 10, signal?: AbortSignal) => deliveryApi<{ reports: ProgressReport[] }>(`/api/intel/work/progress?limit=${limit}`, undefined, signal),
  events: (limit = 20, signal?: AbortSignal) => deliveryApi<{ events: WorkEvent[] }>(`/api/intel/work/events?limit=${limit}`, undefined, signal),
  settings: (signal?: AbortSignal) => deliveryApi<WorkSettingsView>("/api/intel/work/settings", undefined, signal),
  setGithub: (github: boolean) => deliveryApi<WorkSettingsView>("/api/intel/work/settings", { github }),
};
