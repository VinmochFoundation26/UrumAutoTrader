export type RouteError = "unauthorized" | "forbidden" | "session expired";

export function adminRouteHttpStatus(error: RouteError): 401 | 403 {
  return error === "unauthorized" ? 401 : 403;
}

export function getRetiredLegacyBotRoute(path: string): { replacement: string } | null {
  if (path === "/bot/start") return { replacement: "/pool/start" };
  if (path === "/bot/stop") return { replacement: "/pool/stop" };
  return null;
}

export function buildRetiredRouteResponse(path: string) {
  const retired = getRetiredLegacyBotRoute(path);
  if (!retired) return null;

  return {
    status: 410 as const,
    body: {
      ok: false,
      error: `POST ${path} has been retired. Use POST ${retired.replacement} instead.`,
      replacement: retired.replacement,
    },
  };
}
