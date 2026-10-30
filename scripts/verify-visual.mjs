import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium, expect } from "@playwright/test";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = path.join(root, ".data", "visual-review");
await mkdir(output, { recursive: true });
const companies = [
  { id: "preview-company", razonSocial: "Empresa de prueba visual", cuit: "30710145764", ptoVta: 3, condicionIva: "ri", delegationEnabled: true },
  { id: "preview-second", razonSocial: "Servicios del Sur", cuit: "30710145764", ptoVta: 1, condicionIva: "monotributista", delegationEnabled: false },
  { id: "preview-third", razonSocial: "Empresa con una razón social extensa para revisar el diseño", cuit: "30710145764", ptoVta: 2, condicionIva: "exento", delegationEnabled: true },
];
const reviewRows = Array.from({ length: 7 }, (_, index) => ({
  rowId: `preview-row-${index}`, clientId: companies[0].id, razonSocial: companies[0].razonSocial,
  issuerCuit: companies[0].cuit, ptoVta: 3, recipientMode: "identified", recipientModeSource: "manual",
  issuerCondition: "ri", taxRate: 21, status: "CONFIDENT", invoiceId: `preview-invoice-${index}`,
  invoiceStatus: index === 1 ? "REVIEWED" : "PENDING", cuit: "30710145764", cuitSource: "manual",
  fields: { name: `Destinatario de prueba ${index + 1}`, date: "2026-10-28", amount: 18450000 },
  confidence: {}, manualFields: [], blocked: false, failed: false, error: null, flagged: false,
}));
const mocks = new Map([
  ["@/auth", 'export const auth = async () => ({ user: { email: "visual@example.test" } });'],
  ["@/lib/db/client", "export const getDb = () => ({});"],
  ["@/lib/clients/clients", `export const listClients = async () => ${JSON.stringify(companies)};`],
  ["@/lib/credentials/service", "export const getCredentialInfo = async () => null;"],
  ["@/lib/review/read-model", `export const listReviewInvoices = async () => ${JSON.stringify(reviewRows)};`],
  ["@/lib/emission/environment", 'export const resolveArcaEnvironment = () => "homologacion";'],
  ["@/lib/invoices/read-model", "export const listIssuedInvoices = async () => []; export const countApprovedComprobantes = async () => 1;"],
  ["@/lib/invoices/reconciliation", "export const listReservedAttempts = async () => [];"],
  ["next/navigation", "export const usePathname = () => window.location.pathname; export const useRouter = () => ({ refresh() {} });"],
  ["next/link", 'import React from "react"; export default function Link({ children, prefetch, ...props }) { return React.createElement("a", props, children); }'],
  ["next-auth/react", 'export const signIn = async () => ({error:"preview"}); export const signOut = async () => {};'],
]);
const server = await createServer({
  configFile: false,
  root,
  envDir: output,
  publicDir: false,
  logLevel: "error",
  resolve: { alias: { "@": path.join(root, "src") } },
  esbuild: { jsx: "automatic" },
  define: { "process.env": JSON.stringify({ ARCA_ENV: "homologacion", NODE_ENV: "development" }) },
  server: { host: "127.0.0.1", port: 4179, strictPort: true },
  plugins: [{
    name: "isolated-visual-fixtures",
    enforce: "pre",
    resolveId(id) {
      const exact = mocks.has(id) ? id : [...mocks.keys()].find(key => key.startsWith("@/") && path.normalize(id).replace(/\.tsx?$/, "") === path.join(root, "src", key.slice(2)));
      return exact ? `\0visual:${exact}` : null;
    },
    load(id) { return id.startsWith("\0visual:") ? mocks.get(id.slice(8)) : null; },
    configureServer(vite) {
      vite.middlewares.use(async (request, response, next) => {
        if (!request.headers.accept?.includes("text/html")) return next();
        const html = await vite.transformIndexHtml(request.url ?? "/", '<!doctype html><html lang="es"><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>Facturly — isolated visual check</title></head><body><div id="root"></div><script type="module" src="/scripts/visual-fixture.tsx"></script></body></html>');
        response.setHeader("Content-Type", "text/html");
        response.end(html);
      });
    },
  }],
});

let browser;
try {
  await server.listen();
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const browserErrors = [];
  const externalRequests = [];
  const writes = [];
  let uploadResponse = 200;
  let lastUpload = "";
  page.on("pageerror", error => browserErrors.push(error.message));
  await page.route("**/*", async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.hostname !== "127.0.0.1") {
      externalRequests.push(url.origin);
      return route.abort();
    }
    if (!url.pathname.startsWith("/api/")) return route.continue();
    if (request.method() !== "GET") writes.push({ path: url.pathname, method: request.method() });
    if (url.pathname === "/api/clients") return route.fulfill({ json: companies });
    if (url.pathname === "/api/comprobantes") return route.fulfill({ json: [
      { id: "preview-approved", empresaId: companies[0].id, estado: "aprobado", cbteTipo: 1, cbteNro: 1842, cae: "12345678901234", caeVto: "20261030" },
      { id: "preview-uncertain", empresaId: companies[0].id, estado: "incierto", errores: "Tiempo de espera agotado; verificar antes de emitir" },
    ] });
    if (url.pathname.endsWith("/image")) return route.fulfill({ contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" width="280" height="440"><rect width="280" height="440" fill="white"/><text x="20" y="40" font-family="Arial" font-size="16">COMPROBANTE SINTÉTICO</text><path d="M20 80h240M20 120h200M20 160h220M20 300h240" stroke="#d4d7dc"/><text x="20" y="340" font-size="18">TOTAL $184.500,00</text></svg>' });
    if (url.pathname === "/api/upload") {
      lastUpload = request.postDataBuffer()?.toString("utf8") ?? "";
      return route.fulfill({ status: uploadResponse, json: uploadResponse === 200 ? { rows: [{ id: "synthetic-only" }] } : { error: "Error sintético de carga" } });
    }
    return route.fulfill({ status: 409, json: { error: "No action is executed by the isolated visual check" } });
  });

  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    for (const route of ["/", "/review", "/clients", "/invoices", "/credentials", "/cuit-lookup", "/emission", "/login"]) {
      await page.goto(`http://127.0.0.1:4179${route}`);
      await page.locator("h1").waitFor();
      if (route === "/invoices") await page.getByText("Anular / Nota de crédito").waitFor();
      if (route === "/review") {
        if (width <= 1120) await page.getByRole("button", { name: "Imagen", exact: true }).click();
        await expect(page.getByRole("button", { name: "Ampliar imagen", exact: true })).toBeEnabled();
        await page.getByText("Imagen original · 100 % · 0°").waitFor();
        if (width <= 1120) {
          assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1), false, `Horizontal image-view overflow at ${width}px`);
          await page.screenshot({ path: path.join(output, `review-image-${width}.png`), fullPage: true });
          await page.getByRole("button", { name: "Datos", exact: true }).click();
          assert.equal(await page.getByRole("region", { name: "Datos extraídos", exact: true }).isVisible(), true);
        }
      }
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
      assert.equal(overflow, false, `Horizontal page overflow at ${route} ${width}px`);
      await page.screenshot({ path: path.join(output, `${route.replaceAll("/", "") || "upload"}-${width}.png`), fullPage: true });
      console.log(`PASS layout ${route} ${width}px`);
    }
  }

  await page.goto("http://127.0.0.1:4179/");
  const openMenu = page.getByRole("button", { name: "Abrir menú de navegación" });
  await openMenu.click();
  assert.equal(await page.getByRole("dialog").isVisible(), true);
  await page.keyboard.press("Escape");
  assert.equal(await page.getByRole("dialog").isVisible(), false);
  assert.equal(await openMenu.evaluate(element => element === document.activeElement), true);
  await openMenu.click();
  await page.getByRole("dialog").getByRole("link", { name: "Clientes", exact: true }).click();
  await page.getByRole("heading", { name: "Clientes", exact: true }).waitFor();
  assert.equal(await page.getByRole("dialog").isVisible(), false);
  console.log("PASS mobile navigation, Escape, focus restoration and destination");

  await page.goto("http://127.0.0.1:4179/");
  const submit = page.getByRole("button", { name: "Cargar comprobantes", exact: true });
  assert.equal(await submit.isDisabled(), true);
  await page.getByLabel("Empresa emisora", { exact: true }).selectOption(companies[0].id);
  const input = page.getByLabel("Fotos de comprobantes", { exact: true });
  await input.setInputFiles([
    { name: "synthetic-one.png", mimeType: "image/png", buffer: Buffer.from("synthetic image one") },
    { name: "synthetic-two.webp", mimeType: "image/webp", buffer: Buffer.from("synthetic image two") },
  ]);
  await page.getByRole("button", { name: "Quitar synthetic-one.png", exact: true }).click();
  await page.getByRole("button", { name: "Quitar todos", exact: true }).click();
  assert.equal(await submit.isDisabled(), true);
  await page.locator(".dropzone").evaluate(element => {
    const transfer = new DataTransfer();
    transfer.items.add(new File(["synthetic drag image"], "synthetic-drag.png", { type: "image/png" }));
    element.dispatchEvent(new DragEvent("drop", { bubbles: true, dataTransfer: transfer }));
  });
  await page.getByText("synthetic-drag.png", { exact: true }).waitFor();
  uploadResponse = 400;
  await submit.click();
  await page.getByRole("status").filter({ hasText: "Error sintético de carga" }).waitFor();
  assert.equal(await page.getByText("synthetic-drag.png", { exact: true }).isVisible(), true);
  assert.ok(lastUpload.includes('name="clientId"') && lastUpload.includes(companies[0].id));
  assert.ok(lastUpload.includes('filename="synthetic-drag.png"') && !lastUpload.includes("synthetic-one.png"));
  uploadResponse = 200;
  await submit.click();
  await page.getByRole("status").filter({ hasText: "Se registraron 1 comprobante(s)" }).waitFor();
  assert.equal(await page.locator(".file-row").count(), 0);
  assert.equal(await submit.isDisabled(), true);
  assert.equal(await page.getByLabel("Empresa emisora", { exact: true }).inputValue(), companies[0].id);
  console.log("PASS file selection, removal, drag/drop, multipart contract, rejected upload retention and success reset");

  await page.goto("http://127.0.0.1:4179/review");
  await page.getByRole("button", { name: "Editar datos", exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "Aprobar", exact: true }).isDisabled(), true);
  await page.getByRole("button", { name: "Editar datos", exact: true }).click();
  await page.getByLabel("Nombre o razón social", { exact: true }).fill("Borrador visual sintético");
  await page.getByRole("button", { name: /Destinatario de prueba 2/ }).click();
  await page.getByRole("button", { name: /Destinatario de prueba 1/ }).click();
  assert.equal(await page.getByLabel("Nombre o razón social", { exact: true }).inputValue(), "Borrador visual sintético");
  page.once("dialog", async dialog => { assert.ok(dialog.message().includes("Descartar")); await dialog.accept(); });
  await page.getByRole("button", { name: "Cancelar", exact: true }).click();
  let confirmation = "";
  page.once("dialog", async dialog => { confirmation = dialog.message(); await dialog.dismiss(); });
  await page.getByRole("button", { name: "Eliminar definitivamente", exact: true }).click();
  assert.ok(confirmation.includes("Esta acción es irreversible") && confirmation.includes("¿Desea continuar?"));
  assert.equal(writes.filter(write => write.method === "DELETE").length, 0);
  await page.getByRole("button", { name: /Destinatario de prueba 2/ }).click();
  await page.getByRole("button", { name: "Aprobar", exact: true }).click();
  await page.getByRole("dialog", { name: "Aprobar para emisión" }).waitFor();
  await page.getByRole("dialog").getByRole("button", { name: "Cancelar", exact: true }).click();
  assert.equal(writes.some(write => write.path.endsWith("/approve")), false);
  assert.equal(writes.filter(write => write.path !== "/api/upload").length, 0);
  assert.equal(externalRequests.length, 0);
  assert.deepEqual(browserErrors, []);
  console.log("PASS review draft retention, separate approval, readable deletion dialog, cancellation and zero fiscal writes");
  console.log(`PASS isolated browser checks; screenshots: ${output}`);
} finally {
  await browser?.close();
  await server.close();
}
