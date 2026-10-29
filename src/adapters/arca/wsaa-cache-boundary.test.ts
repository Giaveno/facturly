import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const cachePath = "src/adapters/arca/ta-cache.ts";
const clientPath = "src/adapters/arca/wsaa.ts";
const factoryPath = "src/adapters/arca/credential-ta-cache.ts";

function sources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? sources(path) :
      /\.[cm]?[jt]sx?$/.test(entry.name) && !/\.(test|spec)\.[jt]sx?$/.test(entry.name) ? [path] : [];
  });
}

// Check references, not only direct calls: aliases, bracket access and destructuring
// must not expose the raw login outside the cache implementation.
function violations(path: string, text: string): string[] {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  const errors: string[] = [];
  function visit(node: ts.Node) {
    if (ts.isIdentifier(node) || ts.isStringLiteralLike(node)) {
      if (node.text === "loginCms" && path !== cachePath && path !== clientPath) errors.push("raw login access");
      if (node.text === "WsaaClient" && path !== clientPath && path !== factoryPath) errors.push("raw client access");
      // Do not allow namespace/dynamic imports or re-exports of the raw client.
      if (ts.isStringLiteralLike(node) && /\/wsaa(?:\.[cm]?[jt]s)?$/.test(node.text) && path !== clientPath) {
        const declaration = node.parent;
        const clause = ts.isImportDeclaration(declaration) ? declaration.importClause : undefined;
        const typeOnly = clause?.isTypeOnly || (!clause?.name && clause?.namedBindings && ts.isNamedImports(clause.namedBindings) && clause.namedBindings.elements.every(element => element.isTypeOnly));
        if (!typeOnly && path !== factoryPath) errors.push("raw client module import");
      }
      if (node.text === "memoryOnlyTicketStore") errors.push("nonpersistent diagnostic ticket store");
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return errors;
}

describe("WSAA cache boundary", () => {
  it("allows raw login only inside TaCache and raw client composition only in its credential factory", () => {
    const errors = ["src", "scripts"].flatMap(dir => sources(resolve(root, dir))).flatMap(file => {
      const path = relative(root, file).replaceAll("\\", "/");
      return violations(path, readFileSync(file, "utf8")).map(error => `${path}: ${error}`);
    });
    expect(errors).toEqual([]);
  });

  it.each([
    'wsaa.loginCms("wsfe")',
    'wsaa["loginCms"]("wsfe")',
    'const login = wsaa.loginCms; login("wsfe")',
    'const { loginCms: login } = wsaa;',
    'import { WsaaClient as Client } from "./wsaa";',
    'import * as raw from "@/adapters/arca/wsaa";',
    'const raw = await import("./wsaa");',
    'export * from "./wsaa";',
  ])("detects a cache bypass: %s", text => {
    expect(violations("scripts/regression.ts", text).length).toBeGreaterThan(0);
  });

  it.each(["scripts/homologacion-spike.ts", "src/lib/homologacion/live-session.ts"])("keeps %s wired to the shared durable store and cache.get", path => {
    const text = readFileSync(resolve(root, path), "utf8");
    expect(text).toMatch(/new DrizzleTaCacheStore\(/);
    expect(text).toMatch(/createCredentialTaCache\(/);
    expect(text).toMatch(/\.get\("wsfe"\)/);
    expect(text).not.toMatch(/\.evict\(/);
  });
});
