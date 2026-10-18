import type { FastifyInstance } from "fastify";
import { strictObject } from "./provider-routes.ts";
import type { MobileService } from "../mobile/service.ts";

/**
 * Phone pairing management. Every route sits under /api/mobile, so the request
 * guard applies origin, CSRF and body rules, and the LAN gateway can never reach
 * it (`isAllowedRpcPath`). Responses never contain the key except inside the
 * one-time link shown while the pairing is unclaimed.
 */
export function registerMobileRoutes(app: FastifyInstance, service: MobileService): void {
  app.get("/api/mobile/pairing", async () => service.status());
  for (const action of ["enable", "disable", "rotate", "forget"] as const) {
    app.post(`/api/mobile/pairing/${action}`, async (req) => {
      strictObject(req.body, []);
      return service[action]();
    });
  }
}
