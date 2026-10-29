# Revisión de artefactos locales

Revisión del 29/10/2026:

- `git ls-files .data` no devuelve archivos: `.data` no está versionada.
- `git check-ignore -v` confirma la regla `/.data/` de `.gitignore` para logs y PDF.
- Se revisaron los 10 logs y los 2 PDF generados en la raíz de `.data`, incluyendo los streams comprimidos
  de los PDF que pudieron descomprimirse (revisión de mejor esfuerzo, no extracción
  exhaustiva de texto). No se detectaron tokens, firmas, claves privadas ni cadenas de conexión
  mediante los patrones de secretos inspeccionados.
- Los artefactos quedan locales e ignorados; no deben agregarse con `git add -f`.

Esta revisión por patrones no equivale a una garantía general sobre archivos futuros.
