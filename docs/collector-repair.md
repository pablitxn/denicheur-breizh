# Reparación dirigida con Firecrawl

El laboratorio separa el descubrimiento de anuncios, la extracción de su detalle y la reparación de campos pendientes. La estrategia `firecrawl-detail-repair-v4` mantiene las tarjetas de búsqueda pendientes hasta visitar sus fichas; ninguna cantidad de URLs procesadas demuestra por sí sola que se agotó la búsqueda.

## Desde la interfaz

1. Abrir una captura Firecrawl terminada y consultar su plan de reparación. Incluye campos pendientes y valores que contradicen evidencia nativa guardada.
2. Seleccionar anuncios y campos. La vista distingue lo que se puede resolver con evidencia guardada de lo que necesita una nueva consulta.
3. Crear la reparación. Se abre una ejecución nueva vinculada a la anterior, con las URLs y los campos seleccionados como entrada inmutable. La original se conserva.
4. Revisar los campos y sus evidencias. Reanudar vuelve a intentar únicamente los campos seleccionados que sigan pendientes.

Consultar el plan no modifica datos ni llama al proveedor. La creación es idempotente y reaprovecha primero la evidencia local. Los detalles que sigan pendientes usan Scrape dentro de Firecrawl y el presupuesto acumulado del laboratorio. No se combinan resultados de xAI ni de la extensión.

Los campos distinguen un valor observado, ausencia demostrada, no aplicabilidad/exención y datos sin recuperar. Tener un valor no demuestra exactitud: por ejemplo, un DPE A guardado frente a una selección nativa C permite una reparación local del diagnóstico. La ausencia de texto en un markdown, el tipo apartamento o una escala A–G sin selección no son prueba suficiente. Una exención de DPE no se traslada automáticamente a GES.

## Qué cambia en v4

Antes de extraer, la página abre exclusivamente los controles nativos de Description y criterios adicionales. Una segunda lectura recoge las letras DPE/GES explícitamente seleccionadas y los atributos públicos del anuncio actual cuando pueden asociarse a su identidad. Se guardan resultados de JavaScript, HTML, markdown, salida estructurada y consumo.

La reparación sustituye sólo los campos solicitados cuya evidencia pasa la validación. Los datos restantes conservan su snapshot y procedencia; los campos reparados registran la fecha de su consulta. El artefacto `repair_lineage` conserva el snapshot original y los identificadores de evidencia utilizados. Una reparación de un subconjunto de URLs no actualiza automáticamente el resto de los campos ni certifica la búsqueda original.

Una respuesta parcial se conserva y deja los faltantes visibles. No se repite indefinidamente una llamada sin progreso. La reanudación explícita mantiene estrategia, proveedor, costes y campos todavía pendientes.

## API y CLI

`GET /v1/runs/:id/repair-plan` devuelve la selección disponible y su resolución local prevista.

`POST /v1/runs/:id/repair`, con `Idempotency-Key`, acepta:

```json
{
  "listingIds": ["leboncoin:123456"],
  "fields": ["gesClass", "landSurfaceM2"],
  "name": "Completar diagnósticos y terreno"
}
```

Omitir selecciones equivale a incluir todos los campos pendientes o contradichos del plan. El servidor rechaza identidades de otra captura y una selección sin campos para reparar. Las ejecuciones activas o con un trabajo remoto sin resolver deben terminar antes de reparar sus snapshots.

Desde la raíz del repositorio:

```bash
pnpm --filter @denicheur-breizh/collector-api cli repair-plan RUN_ID
pnpm --filter @denicheur-breizh/collector-api cli repair RUN_ID selection.json
```

El segundo comando puede consumir créditos. Sin archivo de selección incluye todos los faltantes. Cada invocación CLI representa una reparación nueva: ante una respuesta perdida, consultar las ejecuciones antes de repetir el comando. Para reenviar idempotentemente mediante la API, reutilizar exactamente el mismo `Idempotency-Key` y cuerpo. La interfaz conserva esa clave cuando el resultado del envío es incierto. Las claves de los proveedores permanecen exclusivamente en el backend.

La evaluación independiente conserva su exigencia del 100%: reparar detalles mejora la extracción, pero todavía requiere una referencia actual completa y la reconciliación de todos los IDs y campos para declarar cobertura verificada.

Resultados de la primera tanda real: [reparación de detalles, septiembre de 2026](collector-repair-findings.md).
