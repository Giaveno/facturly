/**
 * Clients + delegations service — the accountant's client companies and their
 * per-client `wsfe` delegation authorizations.
 *
 * A `client` is a company the accountant emits invoices FOR. A `delegation` is
 * the per-client authorization of the `wsfe` service (the accountant's single
 * certificate signs one TA; per-client delegation authorizes `Auth.Cuit`). A
 * client with no enabled delegation CANNOT be emitted for — the emission service
 * already fails closed; this module does not weaken that.
 *
 * Emisor condition: a client is an EMISOR, so `consumidorFinal` is invalid
 * (Consumidor Final cannot emit — `@/domain/policy` throws on it). Only
 * `ri` / `monotributista` / `exento` are accepted.
 */

import { eq } from "drizzle-orm";
import { clients, delegations } from "@/lib/db/schema";
import { isValidCuit } from "@/domain/cuit";
import type { Db } from "@/lib/db/types";

/** The IVA conditions a client (emisor) may hold. */
export type EmisorCondicion = "ri" | "monotributista" | "exento";

const EMISOR_CONDICIONES: ReadonlySet<string> = new Set([
  "ri",
  "monotributista",
  "exento",
]);

const MAX_PTO_VTA = 9999;

/** Thrown on an invalid client payload (mapped to 400). */
export class ClientValidationError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "ClientValidationError";
  }
}

/** Thrown when a client id does not exist (mapped to 404). */
export class ClientNotFoundError extends Error {
  constructor(clientId: string) {
    super(`No client with id ${clientId}`);
    this.name = "ClientNotFoundError";
  }
}

/** A validated, normalized client payload. */
export interface ClientInput {
  razonSocial: string;
  cuit: string;
  ptoVta: number;
  condicionIva: EmisorCondicion;
}

/**
 * Validates and normalizes a raw client payload. The CUIT is checked with the
 * Mod-11 `isValidCuit` (separators stripped); a Consumidor Final emisor and a
 * non-positive/out-of-range punto de venta are rejected.
 */
export function validateClientInput(raw: unknown): ClientInput {
  if (typeof raw !== "object" || raw === null) {
    throw new ClientValidationError("client payload must be an object");
  }
  const obj = raw as Record<string, unknown>;

  const razonSocial =
    typeof obj.razonSocial === "string" ? obj.razonSocial.trim() : "";
  if (razonSocial === "") {
    throw new ClientValidationError("razonSocial is required");
  }

  const cuitRaw = typeof obj.cuit === "string" ? obj.cuit : "";
  const cuit = cuitRaw.replace(/[^0-9]/g, "");
  if (!isValidCuit(cuit)) {
    throw new ClientValidationError("cuit is not a valid CUIT");
  }

  const ptoVtaRaw = obj.ptoVta;
  const ptoVta =
    typeof ptoVtaRaw === "number" ? ptoVtaRaw : Number(ptoVtaRaw);
  if (!Number.isInteger(ptoVta) || ptoVta < 1 || ptoVta > MAX_PTO_VTA) {
    throw new ClientValidationError(
      `ptoVta must be an integer between 1 and ${MAX_PTO_VTA}`,
    );
  }

  const condicionIva = obj.condicionIva;
  if (
    typeof condicionIva !== "string" ||
    !EMISOR_CONDICIONES.has(condicionIva)
  ) {
    throw new ClientValidationError(
      "condicionIva must be ri, monotributista, or exento",
    );
  }

  return { razonSocial, cuit, ptoVta, condicionIva: condicionIva as EmisorCondicion };
}

export interface ClientWithDelegation {
  id: string;
  cuit: string;
  razonSocial: string;
  ptoVta: number;
  condicionIva: string;
  /** True when any `wsfe` delegation row for the client is enabled. */
  delegationEnabled: boolean;
}

/** Lists all clients with their delegation-enabled state. */
export async function listClients(db: Db): Promise<ClientWithDelegation[]> {
  const rows = await db.select().from(clients).orderBy(clients.razonSocial);
  const allDelegations = await db.select().from(delegations);
  const enabledByClient = new Set<string>();
  for (const d of allDelegations) {
    if (d.enabled) enabledByClient.add(d.clientId);
  }
  return rows.map((c) => ({
    id: c.id,
    cuit: c.cuit,
    razonSocial: c.razonSocial,
    ptoVta: c.ptoVta,
    condicionIva: c.condicionIva,
    delegationEnabled: enabledByClient.has(c.id),
  }));
}

export interface CreateClientResult {
  client: typeof clients.$inferSelect;
  delegation: boolean;
}

/**
 * Creates a client and (by default) its `wsfe` delegation in one transaction.
 * Pass `createDelegation: false` to create the client without an authorization.
 */
export async function createClient(
  db: Db,
  raw: unknown,
  opts: { createDelegation?: boolean } = {},
): Promise<CreateClientResult> {
  const input = validateClientInput(raw);

  return db.transaction(async (tx) => {
    const [client] = await tx
      .insert(clients)
      .values({
        cuit: input.cuit,
        razonSocial: input.razonSocial,
        ptoVta: input.ptoVta,
        condicionIva: input.condicionIva,
      })
      .returning();
    if (!client) throw new Error("createClient: insert returned no row");

    let delegation = false;
    if (opts.createDelegation !== false) {
      await tx
        .insert(delegations)
        .values({ clientId: client.id, cuit: client.cuit, enabled: true });
      delegation = true;
    }
    return { client, delegation };
  });
}

/** Updates a client's editable fields. */
export async function updateClient(
  db: Db,
  clientId: string,
  raw: unknown,
): Promise<typeof clients.$inferSelect> {
  const input = validateClientInput(raw);

  const [updated] = await db
    .update(clients)
    .set({
      razonSocial: input.razonSocial,
      cuit: input.cuit,
      ptoVta: input.ptoVta,
      condicionIva: input.condicionIva,
    })
    .where(eq(clients.id, clientId))
    .returning();
  if (!updated) throw new ClientNotFoundError(clientId);
  return updated;
}

/**
 * Sets a client's `wsfe` delegation `enabled` state as an UPSERT on the unique
 * `clientId` key. The DB unique index (`delegations_client_unique`) enforces at
 * most one row per client, so a concurrent enable/disable (or a stray insert)
 * can never leave a second enabled row for the emission service's `some(enabled)`
 * guard to pick up (W3).
 */
export async function setDelegationEnabled(
  db: Db,
  clientId: string,
  enabled: boolean,
): Promise<{ clientId: string; enabled: boolean }> {
  const [client] = await db
    .select()
    .from(clients)
    .where(eq(clients.id, clientId));
  if (!client) throw new ClientNotFoundError(clientId);

  await db
    .insert(delegations)
    .values({ clientId, cuit: client.cuit, enabled })
    .onConflictDoUpdate({
      target: delegations.clientId,
      set: { enabled },
    });

  return { clientId, enabled };
}
