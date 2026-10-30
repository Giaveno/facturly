# Emisión ARCA

## Un único camino fiscal

La emisión manual y la aprobación desde Revisión terminan en `emitComprobante`.
El job de Inngest adapta el snapshot aprobado y sus ítems; cuando no hay detalle,
usa una línea con la descripción y el importe. La fecha fiscal se calcula en
`America/Argentina/Buenos_Aires`.

- Revisión usa la clave estable `invoice:<id>:approve`: doble clic o repetición
  del job reutilizan el comprobante, sin emitir otro.
- `invoices` conserva el estado de trabajo y la aprobación; la reserva fiscal,
  el número, el estado ARCA y el CAE viven únicamente en `comprobantes`.
- Ambos orígenes comparten el claim por ambiente, CUIT, punto de venta y tipo.
- `/invoices` lista los comprobantes canónicos con PDF completo y nota de crédito.
  Los anteriores quedan en **Históricos, solo lectura**, separados, sin importar
  ni reenviar a ARCA. No tienen nota de crédito desde el flujo canónico actual.
- El emisor viejo y la emisión directa de diagnósticos están retirados y fallan
  cerrados. Las tablas anteriores se conservan para lectura; no borrar históricos.

## Activación local

Configurar en `.env` (ignorado por Git) las variables `DATABASE_URL`, `AES_KEY`,
`ARCA_ENV` y `EMISSIONS_ENABLED`, sin copiar secretos a logs o documentación.
Usar homologación, habilitar explícitamente el interruptor y tener las credenciales
guardadas y la empresa registrada con su CUIT, condición IVA y punto de venta.
`AES_KEY` debe corresponder a la clave que cifra las credenciales existentes:
no regenerar certificados ni cambiar esa clave para resolver errores.

## Recuperar una serie

Con la configuración local válida, ejecutar explícitamente:

```sh
pnpm emission:recover-series --environment homologacion --cuit <CUIT> --pto-vta <PV> --cbte-tipo <TIPO>
```

El script actual acepta tipos de factura 1, 6 y 11. No usarlo para otros tipos.
Consulta los números reservados; no emite una factura nueva. Respeta los claims
activos y el período de gracia. Si sigue bloqueada, investigar el diagnóstico:
no borrar el claim ni reintentar emisiones a ciegas.
La recuperación programada también consulta solo las reservas canónicas y
distingue aprobadas, rechazadas y todavía bloqueadas; no llama al emisor viejo.

## Reglas de seguridad

- Nunca borrar `ta_cache`, forzar login o pedir tickets fuera de `cache.get("wsfe")`.
- Nunca registrar token, firma, clave privada, certificado o cadena de conexión.
- `EMISSIONS_ENABLED` es un interruptor maestro: deshabilitado bloquea el servicio
  antes de cualquier acceso a la base o al gateway. El gateway también lo verifica.
  La configuración omitida no habilita emisiones; producción sigue bloqueada.
- Conservar la clave de idempotencia del formulario: un reintento no es una emisión nueva.
- Un timeout o respuesta ilegible deja el comprobante `incierto` y bloquea la serie.
  No significa rechazo. Después de la gracia se concilia con `FECompConsultar`:
  coincidencia fiscal completa permite aprobar; ausencia confirmada permite liberar;
  una consulta fallida no habilita emitir de nuevo.
- `ARCA_UNCERTAIN_GRACE_MS` configura la gracia. Homologación usa por defecto tres
  veces el timeout de llamada; el valor por defecto previsto para producción es
  al menos diez minutos. No reducirlo sin evaluar autorizaciones tardías.

## Antes de producción

- Certificado válido de producción y clave custodiada/cifrada.
- Punto de venta habilitado para Web Services y delegación/autorización de WSFE.
- Habilitación explícita del código y configuración de producción, hoy bloqueados.
- Presupuesto de ejecución real del despliegue que cubra adquisición del ticket,
  consultas, emisión y conciliación; confirmar el límite del plan y configurar la ruta.
- Validar período de gracia, recuperación, monitoreo, respaldos e idempotencia
  bajo concurrencia y fallos antes de habilitar comprobantes con validez fiscal.
