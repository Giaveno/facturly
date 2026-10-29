import type { ArcaEnvironment } from "@/adapters/arca/constants";
/** Shared by gateway composition and public confirmation copy; no credentials. */
export function resolveArcaEnvironment(env: Record<string,string|undefined>): ArcaEnvironment {
 return env.ARCA_ENV === "production" ? "production" : "homologacion";
}
