import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "@/test-support/test-db";
import { clients, delegations } from "@/lib/db/schema";
import type { Db } from "@/lib/db/types";
import {
  ClientValidationError,
  ClientNotFoundError,
  createClient,
  listClients,
  setDelegationEnabled,
  updateClient,
  validateClientInput,
} from "./clients";

describe("validateClientInput (pure)", () => {
  it("accepts a valid emisor and strips CUIT separators", () => {
    const out = validateClientInput({
      razonSocial: "  CLIENTE S.A.  ",
      cuit: "30-71014576-4",
      ptoVta: 1,
      condicionIva: "ri",
    });
    expect(out.razonSocial).toBe("CLIENTE S.A.");
    expect(out.cuit).toBe("30710145764");
    expect(out.ptoVta).toBe(1);
    expect(out.condicionIva).toBe("ri");
  });

  it("accepts five-digit WSFE points up to 99998 without truncation", () => {
    expect(validateClientInput({ razonSocial: "X", cuit: "30710145764", ptoVta: 99998, condicionIva: "ri" }).ptoVta).toBe(99998);
  });
  it("accepts a numeric-string ptoVta", () => {
    expect(validateClientInput({ razonSocial: "X", cuit: "30710145764", ptoVta: "3", condicionIva: "exento" }).ptoVta).toBe(3);
  });

  it("rejects an invalid CUIT (Mod-11)", () => {
    expect(() => validateClientInput({ razonSocial: "X", cuit: "20123456789", ptoVta: 1, condicionIva: "ri" })).toThrow(ClientValidationError);
  });

  it("rejects Consumidor Final as an emisor condition", () => {
    expect(() => validateClientInput({ razonSocial: "X", cuit: "30710145764", ptoVta: 1, condicionIva: "consumidorFinal" })).toThrow(ClientValidationError);
  });

  it("rejects an empty razon social and an out-of-range ptoVta", () => {
    expect(() => validateClientInput({ razonSocial: "  ", cuit: "30710145764", ptoVta: 1, condicionIva: "ri" })).toThrow(ClientValidationError);
    expect(() => validateClientInput({ razonSocial: "X", cuit: "30710145764", ptoVta: 0, condicionIva: "ri" })).toThrow(ClientValidationError);
    expect(() => validateClientInput({ razonSocial: "X", cuit: "30710145764", ptoVta: 99999, condicionIva: "ri" })).toThrow(ClientValidationError);
  });
});

describe("clients service — create/update/delegation", () => {
  let db: Db;
  let close: () => Promise<void>;

  beforeAll(async () => {
    ({ db, close } = await createTestDb());
  });

  beforeEach(async () => {
    await db.delete(delegations);
    await db.delete(clients);
  });

  afterAll(async () => {
    await close();
  });

  it("createClient inserts a client AND its wsfe delegation by default", async () => {
    const { client, delegation } = await createClient(db, {
      razonSocial: "CLIENTE UNO S.A.",
      cuit: "30710145764",
      ptoVta: 1,
      condicionIva: "ri",
    });
    expect(client.razonSocial).toBe("CLIENTE UNO S.A.");
    expect(delegation).toBe(true);

    const delRows = await db.select().from(delegations).where(eq(delegations.clientId, client.id));
    expect(delRows).toHaveLength(1);
    expect(delRows[0]!.enabled).toBe(true);
    expect(delRows[0]!.cuit).toBe("30710145764");
  });

  it("createClient can skip the delegation when explicitly requested", async () => {
    const { client, delegation } = await createClient(
      db,
      { razonSocial: "SIN DELEG S.A.", cuit: "30710145764", ptoVta: 2, condicionIva: "monotributista" },
      { createDelegation: false },
    );
    expect(delegation).toBe(false);
    const delRows = await db.select().from(delegations).where(eq(delegations.clientId, client.id));
    expect(delRows).toHaveLength(0);
  });

  it("createClient rejects a duplicate CUIT (unique index)", async () => {
    await createClient(db, { razonSocial: "A S.A.", cuit: "30710145764", ptoVta: 1, condicionIva: "ri" });
    await expect(
      createClient(db, { razonSocial: "B S.A.", cuit: "30710145764", ptoVta: 2, condicionIva: "exento" }),
    ).rejects.toThrow();
  });

  it("updateClient edits fields and rejects an invalid CUIT / missing client", async () => {
    const { client } = await createClient(db, { razonSocial: "VIEJO S.A.", cuit: "30710145764", ptoVta: 1, condicionIva: "ri" });
    const updated = await updateClient(db, client.id, {
      razonSocial: "NUEVO S.A.",
      cuit: "20123456786",
      ptoVta: 5,
      condicionIva: "exento",
    });
    expect(updated.razonSocial).toBe("NUEVO S.A.");
    expect(updated.cuit).toBe("20123456786");
    expect(updated.ptoVta).toBe(5);

    await expect(updateClient(db, client.id, { razonSocial: "X", cuit: "INVALID", ptoVta: 1, condicionIva: "ri" })).rejects.toThrow(ClientValidationError);
    await expect(updateClient(db, "00000000-0000-4000-8000-000000000000", { razonSocial: "X", cuit: "30710145764", ptoVta: 1, condicionIva: "ri" })).rejects.toThrow(ClientNotFoundError);
  });

  it("setDelegationEnabled toggles on and off (disabling removes the emit authorization)", async () => {
    const { client } = await createClient(db, { razonSocial: "TOGGLE S.A.", cuit: "30710145764", ptoVta: 1, condicionIva: "ri" }, { createDelegation: false });

    // No delegation → enable creates one.
    await setDelegationEnabled(db, client.id, true);
    let del = await db.select().from(delegations).where(eq(delegations.clientId, client.id));
    expect(del).toHaveLength(1);
    expect(del[0]!.enabled).toBe(true);

    // Disable → the row becomes disabled (emission's `some(enabled)` is false).
    await setDelegationEnabled(db, client.id, false);
    del = await db.select().from(delegations).where(eq(delegations.clientId, client.id));
    expect(del[0]!.enabled).toBe(false);
  });

  it("setDelegationEnabled on a missing client throws ClientNotFoundError", async () => {
    await expect(setDelegationEnabled(db, "00000000-0000-4000-8000-000000000000", true)).rejects.toThrow(ClientNotFoundError);
  });

  it("setDelegationEnabled is an upsert — repeated toggles never duplicate the row (W3)", async () => {
    const { client } = await createClient(db, { razonSocial: "UPSERT S.A.", cuit: "30710145764", ptoVta: 1, condicionIva: "ri" }, { createDelegation: false });

    // Enable, then enable again — must still be a single row.
    await setDelegationEnabled(db, client.id, true);
    await setDelegationEnabled(db, client.id, true);
    let del = await db.select().from(delegations).where(eq(delegations.clientId, client.id));
    expect(del).toHaveLength(1);
    expect(del[0]!.enabled).toBe(true);

    // Disable — the SAME row flips to disabled, never a second row.
    await setDelegationEnabled(db, client.id, false);
    del = await db.select().from(delegations).where(eq(delegations.clientId, client.id));
    expect(del).toHaveLength(1);
    expect(del[0]!.enabled).toBe(false);
  });

  it("listClients reflects delegationEnabled", async () => {
    const a = await createClient(db, { razonSocial: "ENABLED S.A.", cuit: "30710145764", ptoVta: 1, condicionIva: "ri" });
    await createClient(db, { razonSocial: "DISABLED S.A.", cuit: "20123456786", ptoVta: 1, condicionIva: "ri" }, { createDelegation: false });

    const list = await listClients(db);
    const byId = new Map(list.map((c) => [c.id, c.delegationEnabled]));
    expect(byId.get(a.client.id)).toBe(true);
    expect(list.find((c) => c.razonSocial === "DISABLED S.A.")!.delegationEnabled).toBe(false);
  });
});
