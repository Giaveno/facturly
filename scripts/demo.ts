/**
 * CLI entry for the offline demo — `pnpm demo`.
 *
 * Runs the whole invoicing flow with NO credentials, NO network, and NO manual
 * setup, printing a narrated console story a non-technical reader (e.g. an
 * accountant) can follow. All the work lives in `src/demo/run-demo.ts` so the
 * smoke test can run the exact same sequence in-process.
 */

import { runDemo } from "../src/demo/run-demo";

async function main(): Promise<void> {
  const debug = process.argv.includes("--debug");
  await runDemo({ outputDir: "demo-output", debug });
}

main().catch((err) => {
  console.error(`\n✗ demo failed: ${err instanceof Error ? err.message : err}\n`);
  process.exit(1);
});
