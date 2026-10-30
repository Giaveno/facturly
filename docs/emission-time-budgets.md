# Presupuestos de emisión

- El job `emit/batch` fija `timeouts.finish: "30m"`. Cada factura tiene su propio
  `step.run`, por lo que un lote no acumula todas las llamadas en un único request.
  Un lote demasiado grande puede superar esos 30 minutos; las facturas completadas
  quedan checkpointadas y conservan su idempotencia. No reemitirlas con claves nuevas.
- `/api/inngest`, `/api/comprobantes`, nota de crédito y verificación declaran
  `maxDuration = 600` segundos. Es una indicación para el despliegue, no un temporizador
  que Next.js aplique en desarrollo. No se pudo determinar el plan ni un límite
  menor impuesto por un proxy externo.
- Antes no había `finish` ni `maxDuration` en las rutas de emisión. El driver HTTP
  de Inngest usa por defecto 7200 segundos; el host puede cortar antes.
- Homologación: cada llamada remota tiene 25 segundos. Un caso conservador con login,
  dos últimos autorizados, emisión y consulta suma 125 segundos; sin consulta son 100.
  Esperar un claim puede agregar hasta 180 segundos: 305 en total, antes de latencias
  de DB. Los 600 segundos dejan margen, pero no acotan fallos de DB ni una cantidad
  arbitraria de reservas antiguas a conciliar. Esas series requieren recuperación
  separada; no se promete un peor caso global finito.
- `finish` cancela entre pasos, no aborta una operación externa a mitad del paso.
  Los timeouts HTTP y los estados pendiente/incierto siguen siendo necesarios.

Fuentes oficiales: [timeouts de Inngest](https://www.inngest.com/docs/durable-execution/guides-and-advanced/cancellation/timeouts),
[límites de pasos](https://www.inngest.com/docs/durable-execution/limits),
[driver HTTP](https://github.com/inngest/inngest/blob/main/pkg/cuedefs/config/config.cue),
[maxDuration de Next.js](https://nextjs.org/docs/app/api-reference/file-conventions/route-segment-config#maxduration).
