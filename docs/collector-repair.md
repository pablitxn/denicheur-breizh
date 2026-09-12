# Reparación dirigida con Firecrawl

El laboratorio separa el descubrimiento de anuncios, la extracción de su detalle y la reparación de campos pendientes o diferentes de la evidencia nativa. Las tarjetas de búsqueda permanecen pendientes hasta visitar sus fichas; ninguna cantidad de URLs procesadas demuestra por sí sola que se agotó la búsqueda. Las nuevas reparaciones usan `firecrawl-gallery-walk-v7`, visible en el plan antes de enviarlo. Las ejecuciones históricas v4, v5 y v6 conservan su versión al reanudarse.

## Desde la interfaz

1. En `http://127.0.0.1:5175`, entrar en **Capturas**, seleccionar una captura Firecrawl terminada y abrir **Corregir detalles → Revisar campos para corregir**. El plan incluye campos pendientes y diferencias con la evidencia nativa guardada, para corregir o enriquecer los datos. Puede incluir un campo ya poblado.
2. Revisar la estrategia visible y seleccionar anuncios y campos. Por defecto se incluyen todos los candidatos del plan. La selección de campos se cruza con los candidatos de cada ficha; los demás campos se conservan.
3. Consultar los recuentos de campos resolubles localmente y anuncios que requieren consulta. **Crear captura de reparación** abre una ejecución nueva vinculada, con las URLs y campos seleccionados como entrada inmutable. La original se conserva.
4. Abrir sus resultados y **Estado de cada campo** para consultar motivos, evidencias y fechas. **Abrir captura original** permite volver al snapshot previo. Reanudar vuelve a intentar únicamente los campos seleccionados que sigan pendientes, con la versión original de esa reparación.

Consultar el plan no modifica datos ni llama al proveedor. La creación es idempotente y reaprovecha primero la evidencia local. Una selección enteramente local no necesita saldo ni una clave configurada; si queda algún campo por consultar, se exige el proveedor configurado y presupuesto disponible, sin consumo incierto pendiente. Esas consultas usan Scrape dentro de Firecrawl y el presupuesto acumulado del laboratorio. No se combinan resultados de xAI ni de la extensión.

Los campos distinguen un valor observado, ausencia demostrada, no aplicabilidad/exención y datos sin recuperar. Tener un valor no demuestra exactitud: por ejemplo, un DPE A guardado frente a una selección nativa C permite una reparación local del diagnóstico. La ausencia de texto en un markdown, el tipo apartamento o una escala A–G sin selección no son prueba suficiente. Una exención de DPE no se traslada automáticamente a GES.

## Estrategias y límites observados

V4 abre exclusivamente los controles nativos de Description y criterios adicionales antes de extraer. Una segunda lectura recoge las letras DPE/GES explícitamente seleccionadas y los atributos públicos del anuncio actual cuando pueden asociarse a su identidad. Se guardan resultados de JavaScript, HTML, markdown, salida estructurada y consumo.

| Versión | Estrategia | Qué verifica |
|---|---|---|
| v4 | `firecrawl-detail-repair-v4` | Descripción desplegada, criterios y diagnósticos seleccionados con evidencia de la ficha. |
| v5 | `firecrawl-native-inventory-v5` | Añade precio e inventario de imágenes de los datos públicos del anuncio; contrasta sus recuentos. |
| v6 | `firecrawl-gallery-audit-v6` | Abre la galería propia, lee su contador y sus imágenes, contrasta los datos nativos y cierra el modal. |
| v7 | `firecrawl-gallery-walk-v7` | Recorre cada posición real de la galería mediante Siguiente, registra imágenes o paneles y vuelve a la ficha; una falta de avance deja el recorrido incompleto. |

El piloto v6 `fbf80860-ee49-4bf6-9855-c15a47791bab`, del 12 de septiembre de 2026, conserva su resultado parcial: 11 imágenes frente a un contador de 12 posiciones para `3094507263`, y 16 frente a 17 para `3213530050`. La apertura y el cierre funcionaron, pero no explicaron esas diferencias y `imageUrls` quedó sin resolver.

El recorrido v7 guardado en `a7e2f69c-f92e-4cdc-968d-06ae415eeb2a` observó todas las posiciones: 11 fotos más un panel final en la primera galería, y 16 fotos más un panel final en la segunda. Cada panel era un `business-card-slide`, con enlace **Contacter** a `/reply/<mismo ID del anuncio>`, no una imagen adicional. Se observó el panel sin activar el contacto. Esta evidencia permite explicar el contador; no se descuenta una posición por suposición.

La [reparación local final](http://127.0.0.1:5175/?view=history&run=7269fee2-6041-4f10-9281-d478b79a5adc), **Réparation v7 — galeries complètes depuis les preuves conservées**, reutilizó ese material y terminó con dos fichas extraídas, cero fallos, cero pendientes y coste adicional de cero créditos. No repitió las consultas del proveedor y mantuvo el snapshot anterior separado. El detalle está completo según la validación del laboratorio; `coverage` permanece `unknown`, porque este subconjunto no certifica una búsqueda completa.

La [captura nueva desde una URL](http://127.0.0.1:5175/?view=history&run=78b42920-31a3-4ef8-97f4-a64e43703465), **POC v7 — validation d’une fiche depuis son URL**, confirmó además el recorrido completo desde `https://www.leboncoin.fr/ad/ventes_immobilieres/3094507263`: una ficha extraída, cero fallos, 11 fotos y 16 campos observados sin faltantes, en 25,6 segundos y por 5 créditos confirmados. Se corrigió el GES D del modelo a C mediante evidencia nativa. Su cobertura también sigue sin verificar; el resultado corresponde a esa URL durante la observación, no a una búsqueda entera.

La reparación sustituye sólo los campos solicitados cuya evidencia pasa la validación. Los datos restantes conservan su snapshot, procedencia y fecha de observación; los campos reparados registran la fecha de su consulta. El artefacto `repair_lineage` conserva el snapshot original y los identificadores de evidencia utilizados. Una reparación de un subconjunto de URLs no actualiza automáticamente el resto de los campos ni certifica la búsqueda original.

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

Omitir selecciones equivale a incluir todos los campos pendientes o diferentes de la evidencia nativa incluidos en el plan. El servidor rechaza identidades de otra captura y una selección sin campos para reparar. Las ejecuciones activas o con un trabajo remoto sin resolver deben terminar antes de reparar sus snapshots.

Desde la raíz del repositorio:

```bash
pnpm --filter @denicheur-breizh/collector-api cli repair-plan RUN_ID
pnpm --filter @denicheur-breizh/collector-api cli repair RUN_ID selection.json
```

Estos comandos requieren la API local ya iniciada; la CLI no crea un segundo trabajador. El segundo comando puede consumir créditos. Sin archivo de selección incluye todos los candidatos del plan. Cada invocación CLI representa una reparación nueva: ante una respuesta perdida, consultar las ejecuciones antes de repetir el comando. Para reenviar idempotentemente mediante la API, reutilizar exactamente el mismo `Idempotency-Key` y cuerpo. La interfaz conserva esa clave cuando el resultado del envío es incierto, incluso al recargar. Las claves de los proveedores permanecen exclusivamente en el backend.

Si se actualizó la estrategia disponible entre el envío y su reintento, una clave anterior puede devolver un conflicto 409. Consultar la ejecución original en el historial: el laboratorio no crea automáticamente un segundo intento facturable para resolver ese conflicto.

La evaluación independiente conserva su exigencia del 100%: reparar detalles mejora la extracción, pero todavía requiere una referencia actual completa y la reconciliación de todos los IDs y campos para declarar cobertura verificada. El recuento histórico de 23/34 fichas sin faltantes detectados no constituye una revisión de exactitud ni una certificación de cobertura; depende de la validación disponible en aquella etapa.

La verificación final del software pasó 319 pruebas —290 de API, 20 de UI, 8 de contratos y 1 de CLI— y 27 E2E con proveedores simulados. El consumo confirmado acumulado de Firecrawl al cierre fue de 849/5.000 créditos, sin importes desconocidos ni reservas pendientes; las consultas posteriores deben comprobar el estado actual en **Settings → Development**.

Evidencias y resultados de las pruebas reales: [reparación de detalles, septiembre de 2026](collector-repair-findings.md).
