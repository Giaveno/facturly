# Factura C en homologación

Ejecución única autorizada del 29/10/2026, CUIT 20436027525 (exento), PV 1.

- Consulta previa `FECompUltimoAutorizado`, tipo 11: HTTP 200, `CbteNro: "0"`, sin errores.
- Servicio normal: Factura C por $1000, neto $1000, IVA $0, consumidor final 99/0, condición IVA 5.
- Aprobada: **00001-00000001**, CAE **86441033106547**, vencimiento **08/11/2026**.
- `FECompConsultar` confirmó número y CAE; el gateway comprobó los importes.
- PDF local: `.data/factura-c-propia-1.pdf`.
- Log completo local: `.data/prueba-cuit-propio.log`.
- Llamadas: WSAA 0 (cache); WSFE 5 (3 últimos autorizados, 1 emisión, 1 consulta).
- Sin reintentos, variantes ni cambios en producción.

La consulta previa y la factura nueva no cambian retrospectivamente la evidencia
de la reserva histórica: antes de esta emisión, la consulta anterior devolvió 602.
