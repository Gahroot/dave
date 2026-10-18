/**
 * The phone's API client: same paths, bodies and JSON as the web UI's
 * `fetch("/api/…")` calls, carried over the sealed transport. Screens import
 * `useApi()` from ./connection and call `api.get("/api/portfolio")` etc.
 *
 * Errors mirror the web helpers (src/ui/delivery-api.ts, src/ui/intel-api.ts):
 * the server's `message ?? error` text plus the HTTP status, with the body
 * retained so callers can read structured fields such as a 409's `state`.
 */
import type { RpcMethod } from "../../../src/mobile/protocol.ts";
import type { CallOptions, CallResult, UploadFile } from "./transport.ts";

export class ApiError extends Error {
  readonly status: number;
  readonly body: unknown;
  constructor(message: string, status: number, body: unknown) { super(message); this.status = status; this.body = body; this.name = "ApiError"; }
}

export type Caller = (method: RpcMethod, path: string, body: unknown, options: CallOptions) => Promise<Omit<CallResult, "host">>;
export type Uploader = (file: UploadFile, options: CallOptions) => Promise<Omit<CallResult, "host">>;
/** Bytes the Mac returned for a binary route, e.g. `GET /api/files/:id/content`. */
export type BinaryBody = { base64url: string; contentType: string };

export type Api = {
  get<T>(path: string, options?: CallOptions): Promise<T>;
  /** Body defaults to `{}`: guarded routes require a JSON object on every write. */
  post<T>(path: string, body?: unknown, options?: CallOptions): Promise<T>;
  put<T>(path: string, body?: unknown, options?: CallOptions): Promise<T>;
  patch<T>(path: string, body?: unknown, options?: CallOptions): Promise<T>;
  del<T>(path: string, body?: unknown, options?: CallOptions): Promise<T>;
  /** GET a binary route (images, PDFs). Throws ApiError when the answer is not binary. */
  binary(path: string, options?: CallOptions): Promise<BinaryBody>;
  /** Share a document: `POST /api/files` with the file's bytes. Returns the server's JSON. */
  upload<T>(file: UploadFile, options?: CallOptions): Promise<T>;
};

/** The server's own explanation, or a plain fallback. */
export function errorText(body: unknown, status: number): string {
  if (typeof body === "object" && body !== null) {
    const record = body as { message?: unknown; error?: unknown };
    if (typeof record.message === "string" && record.message) return record.message;
    if (typeof record.error === "string" && record.error) return record.error;
  }
  if (typeof body === "string" && body.trim() && body.length < 300) return body.trim();
  return status === 409 ? "State changed; reload and retry" : `Request failed (${status})`;
}

export function createApi(caller: Caller, uploader?: Uploader): Api {
  const run = async <T>(method: RpcMethod, path: string, body: unknown, options: CallOptions = {}): Promise<T> => {
    const result = await caller(method, path, method === "GET" ? undefined : body ?? {}, options);
    if (result.status < 200 || result.status >= 300) throw new ApiError(errorText(result.body, result.status), result.status, result.body);
    return result.body as T;
  };
  return {
    get: (path, options) => run("GET", path, undefined, options),
    post: (path, body, options) => run("POST", path, body, options),
    put: (path, body, options) => run("PUT", path, body, options),
    patch: (path, body, options) => run("PATCH", path, body, options),
    del: (path, body, options) => run("DELETE", path, body, options),
    binary: async (path, options = {}) => {
      const answer = await caller("GET", path, undefined, options);
      if (answer.status < 200 || answer.status >= 300) throw new ApiError(errorText(answer.body, answer.status), answer.status, answer.body);
      if (answer.encoding !== "base64url" || typeof answer.body !== "string" || !answer.contentType) throw new ApiError("Preview unavailable.", answer.status, answer.body);
      return { base64url: answer.body, contentType: answer.contentType };
    },
    upload: async <T,>(file: UploadFile, options: CallOptions = {}): Promise<T> => {
      if (!uploader) throw new ApiError("Sharing files is not available.", 0, null);
      const answer = await uploader(file, options);
      if (answer.status < 200 || answer.status >= 300) throw new ApiError(errorText(answer.body, answer.status), answer.status, answer.body);
      return answer.body as T;
    },
  };
}

/** A message safe to show for any thrown value. */
export function describeError(error: unknown, fallback = "Something went wrong. Retry when ready."): string {
  return error instanceof Error && error.message ? error.message : fallback;
}
