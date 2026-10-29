# Read-only legacy reservation consultation

Executed once on 2026-10-29 against homologation only:

- CUIT: 20436027525; point of sale: 1; comprobante type: 11; number: 1.
- Stored reservation ID: ff1545bf-f6ae-48e7-918f-5703021b1a9b.
- HTTP status: 200.
- ARCA code: `602`.
- Literal ARCA message: `No existen datos en nuestros registros para los parametros ingresados.`
- Calls: 1 FECompConsultar, 0 issuance, 0 WSAA (persistent cache hit).
- Database connection was read-only: no status changes, no ticket writes.
- Complete local output: `.data/reserva-11-consulta.log`.

The local marker prevents another execution; no retries were attempted.
