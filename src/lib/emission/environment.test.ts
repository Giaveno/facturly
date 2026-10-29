import { expect, it } from "vitest";
import { resolveArcaEnvironment } from "./environment";
it("matches the gateway endpoint environment including its default",()=>{expect(resolveArcaEnvironment({})).toBe("homologacion");expect(resolveArcaEnvironment({ARCA_ENV:"production"})).toBe("production");expect(resolveArcaEnvironment({ARCA_ENV:"invalid"})).toBe("homologacion");});
