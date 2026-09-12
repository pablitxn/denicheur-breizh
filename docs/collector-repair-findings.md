# Reparación de detalles: evidencia del 12 de septiembre de 2026

La reparación dirigida ya completa las dos fichas del piloto de galerías desde evidencia guardada, y una captura nueva desde URL recuperó los 16 campos exigidos y sus 11 fotos. Esta campaña todavía no verifica una búsqueda completa de Leboncoin: la referencia independiente actual sigue faltando y otras fichas conservan campos sin resolver.

## Punto de partida

La ejecución `49f1dfd9-9799-455c-a281-e0fcd8b64e91` conserva 34 anuncios conocidos: 18 fichas pasaron la validación del laboratorio y 16 tenían 21 campos pendientes. La primera tanda de reparación no modificó esa ejecución ni volvió a consultar las 18 fichas sin faltantes registrados; la auditoría posterior sí las revisó por separado.

## Lo demostrado

- El piloto `a46e7e37-c8ff-4297-bb35-34948751e7d3` abrió Description y criterios adicionales de `3096819091`. La selección DOM y el atributo nativo identificaron GES **C**. El JSON del modelo declaró **G** y dejó vacías sus justificaciones. Se conservan ambas respuestas; la contradicción es comprobable en el artefacto `61fdd186-4a1b-4ebf-9cde-7c0235f835e2`.
- La nueva normalización permite rescatar hechos del DOM aunque el JSON esté mal formado. Las declaraciones inválidas quedan sin resolver y cualquier corrección de un diagnóstico queda señalada. El piloto se conserva con su resultado original; la reparación local `6bdb6f77-beac-456a-9f86-86b7bbd30098` recuperó GES C sin una segunda consulta.
- La ejecución `44b1d0bc-1448-4ea4-bb2b-435c9046ec6d` consultó las otras 15 fichas. Recuperó GES en `3177310233`, `3179454686`, `3179474322` y `3257780507`. Las primeras tres quedaron sin campos pendientes; la última conserva terreno pendiente.
- El texto «Non soumis au DPE» de `3123914026` permite representar su exención DPE. Su GES sigue sin resolver: esa declaración no se extrapola a otro diagnóstico.
- Las características de `3156106279` están publicadas en prosa. La reparación local `85296183-a40b-4662-8d02-f2a9d9393bfb` recuperó cuatro características desde el artefacto `f80d8405-e38a-41b8-a0c7-fd17bf069349`, sin otra consulta. La normalización conserva oraciones literales de características y criterios adicionales con evidencia exacta, sin convertir una negación o un proyecto hipotético en una característica positiva.

Al combinar por identidad los campos de la captura original y sus reparaciones, **23 de las 34 fichas quedan sin faltantes registrados**, frente a las 18 iniciales. Se resolvieron siete campos: cinco GES, una exención DPE y las características de una ficha. Permanecen **11 fichas incompletas con 14 campos pendientes**: terreno en diez, GES en dos, DPE en una y dormitorios en una. La captura original sigue conservando sus 18 fichas validadas y 16 incompletas; este agregado no sobrescribe ningún snapshot ni certifica una búsqueda completa.

El piloto costó 5 créditos y la tanda de 15 costó 75. Esa primera etapa consumió **80 créditos**, con consumo confirmado y ninguna operación incierta. El gasto acumulado Firecrawl al cerrar esa etapa fue **689 de los 5.000 créditos autorizados**; las reparaciones exclusivamente locales no añaden consumo.

## Exactitud: tener un valor no basta

La revisión posterior encontró 15 diferencias de DPE/GES en campos previamente rellenados de esas 16 fichas. La reparación local `c165fa6a-7d09-4f15-960f-85e65b3852c2` corrigió 14 diagnósticos; `f4b69e0d-54cd-4b0a-bc62-69d65bbcd87f` corrigió el DPE de `3156106279` a C, conservando sus características y GES B. Ambas costaron cero créditos y preservan las observaciones anteriores.

Se amplió la comprobación a las otras 18 fichas mediante `8ab7ca8f-808a-4290-95c6-cf8ddb222cae`, por **90 créditos**. La auditoría de las 34 respuestas v4 encontró dos métricas distintas:

- **34 diferencias históricas de diagnósticos en 24 anuncios**: 19 DPE y 15 GES frente a la captura anterior. La diferencia temporal por sí sola no permite distinguir un cambio de fuente de un error anterior.
- **37 desacuerdos entre el JSON y los datos nativos dentro de la misma respuesta, en 23 anuncios**. Estos sí demuestran errores de extracción. En los casos registrados, el elemento seleccionado del DOM y el atributo nativo concuerdan entre sí.

Los archivos `repair-native-contradictions*.json` del directorio local de informes conservan identidades, valores, timestamps y artefactos. El estado «sin faltantes» de la primera etapa no constituye validación de exactitud.

La revisión de 18 fichas sufrió una desconexión después de que Firecrawl completara la segunda solicitud. Su consola confirmó cinco créditos y el identificador remoto; se recuperó la respuesta mediante GET, sin reenviar el POST. El artefacto `provider_console_recovery` registra esa intervención manual. La facturación quedó reconciliada, pero esa ejecución no demuestra autonomía sin intervención.

## Precio y galería: motivo de v5

Los 18 precios de la revisión estaban presentes y coincidían con el selector nativo `adview_price`. Sus citas carecían de la etiqueta «Prix» que exigía el validador. El normalizador ahora puede recuperar esa prueba desde el HTML guardado sin aceptar cualquier importe de la página: excluye financiación, precio por metro cuadrado y recomendaciones.

Las imágenes tenían una limitación real: el JSON entregaba tres URLs mientras la página anunciaba galerías de 7, 12, 13 o 17 fotos. Esas galerías permanecen parciales. La estrategia `firecrawl-native-inventory-v5` conserva la galería completa y el precio del anuncio identificado en los datos nativos, y exige concordancia entre su inventario y sus recuentos. Las ejecuciones v4 mantienen su versión y evidencias.

El piloto v5 `1376848f-fd87-47d7-9602-e0a5f13bcb0c` costó 15 créditos y recuperó 11 y 16 imágenes en dos fichas que antes devolvían tres; la tercera tiene dos fotos. Los inventarios de 11 y 16 coinciden con sus secciones «Photos», pero el botón superior anuncia 12 y 17. La portada ya está incluida y los avatares del vendedor se excluyen: no se supuso una foto faltante ni se corrigió el contador sumando uno. V5 conserva esos desacuerdos como pendientes.

V6 abre la galería propia, registra contadores, imágenes y tipos de contenido, y verifica su cierre antes de extraer el detalle. La reconciliación exige pruebas del modal: una diferencia entre el botón inicial y el contador de fotos se conserva en la evidencia. Las variantes de entrega de una misma foto no inflan el recuento de identidades.

El piloto v6 `fbf80860-ee49-4bf6-9855-c15a47791bab` consultó esas dos fichas por 10 créditos. Ambas galerías se abrieron y cerraron correctamente, con restauración de la página de detalle. Sus contadores reales fueron `1/12` y `1/17`, frente a inventarios nativos de 11 y 16 fotos. Observar únicamente la primera posición no explica el elemento adicional: ambos campos de imágenes siguen sin resolver. Los demás campos exigidos en estas dos fichas pasaron la validación del laboratorio; eso no sustituye una comparación independiente. El gasto acumulado al cerrar v6 fue 804 créditos, sin operaciones inciertas.

La reparación v7 `6c1cc4d7-2491-409d-8808-69029d5f6906` recorrió las 12 y 17 posiciones, con avance secuencial y cierre/restauración confirmados. Costó 10 créditos. Conserva un resultado parcial: el selector inicial descartaba las fotos principales por estar dentro de un botón de ampliación y no reconocía la posición final como activa. Las imágenes visibles de las primeras 11/16 posiciones y el texto de contacto de la última quedaron guardados; el verificador no convirtió esa impresión en una certificación. Las peticiones, scripts exactos y respuestas de este intento permanecen en su exportación para contrastar la corrección del selector.

El intento `f2ac80ef-834e-466e-87d3-34d9be1cbaf6` corrigió el botón de ampliación y volvió a recorrer todas las posiciones, por 10 créditos. La condición geométrica sólo reconoció la primera foto. Se conservó como parcial y se ajustó el selector para admitir el estado activo explícito del sitio con índice exacto, unicidad y ausencia de estados contradictorios; la geometría queda como respaldo cuando no hay una marca activa. Esa diferencia, por sí sola, no demuestra que faltaran estilos o una disposición vertical del visor.

La siguiente reparación, `45a27f74-83f9-4749-ab81-fc1dd995c93f`, conservó por 10 créditos los atributos y rectángulos de los candidatos rechazados. Mostró la causa más precisa: varias posiciones tenían el índice correcto y `aria-hidden="false"`, pero todavía `inert=true` durante la transición. Sólo dos posiciones pasaron la comprobación y la ejecución siguió parcial. El recorrido se ajustó para esperar que la diapositiva actual esté habilitada antes de aceptar el avance; no elimina ni ignora `inert`. Los candidatos rechazados son diagnóstico y no prueba aceptada de completitud.

## Resultado final de v7: reparación local y captura nueva

La ejecución `a7e2f69c-f92e-4cdc-968d-06ae415eeb2a` incorporó la espera de la transición y conservó, por 10 créditos, las 12 y 17 posiciones habilitadas: 11 y 16 fotos distintas, más una posición final sin foto del inmueble. El HTML íntegro de esa posición identifica `business-card-slide` y un enlace «Contacter» a `/reply/<ID del mismo anuncio>`. La tarjeta del vendedor explica la diferencia del contador; no se sumó una imagen artificial ni se siguió el enlace de contacto. El intento quedó parcial con su clasificación original, conservando las pruebas suficientes para corregirla localmente.

La reparación vinculada `7269fee2-6041-4f10-9281-d478b79a5adc`, **Réparation v7 — galeries complètes depuis les preuves conservées**, aplicó el verificador actualizado a esos artefactos: **dos fichas procesadas, cero campos pendientes, 11 y 16 fotos, cero créditos adicionales**. Exige la tarjeta concreta, una posición activa inequívoca, HTML completo, el enlace al mismo anuncio y ausencia de fotos del inmueble en ese panel. Un texto genérico de contacto no basta. Los snapshots anteriores conservan su resultado parcial y los campos heredados mantienen sus fechas.

Para verificar el flujo normal se creó `78b42920-31a3-4ef8-97f4-a64e43703465`, **POC v7 — validation d’une fiche depuis son URL**, sin heredar datos ni campos de otra ejecución. Capturó `3094507263` en **25,6 segundos y 5 créditos**, con **los 16 campos exigidos observados, 11 fotos y ningún faltante registrado**. El JSON volvió a proponer un GES incorrecto, D; la selección DOM y el dato nativo permitieron corregirlo a C, conservando la advertencia y la respuesta original. La captura terminó operativamente completa y su cobertura sigue `unknown`: una URL conocida no prueba descubrimiento completo de una búsqueda.

El gasto confirmado al cerrar esta iteración fue **849 de los 5.000 créditos Firecrawl autorizados**, de los cuales **240** corresponden a esta etapa de reparación y auditoría. No quedan operaciones con consumo desconocido ni créditos reservados. xAI permanece en **US$0,300710 de US$25**; esta etapa no utilizó ese proveedor. El saldo promocional y su vencimiento son datos separados del presupuesto local, y el vencimiento continúa sin confirmación documental.

`pnpm check:collector` pasó con **319 tests** —290 API, 20 UI, ocho contratos y uno del auditor CLI— y **27 E2E**, además de typecheck, build y control de tokens de diseño. Las pruebas cubren selección de campos, conservación de snapshots y fechas, idempotencia, galerías extensas, estados ambiguos/transitorios y falsos paneles de contacto. Las llamadas reales anteriores aportan la evidencia del proveedor; los tests habituales usan simulaciones y no consumen créditos.

El camino demostrado es descubrir URLs, visitar cada ficha y reparar los campos elegidos usando primero las pruebas conservadas. Los dos detalles completos del piloto y la repetición desde URL justifican continuar con Firecrawl para esa etapa. Todavía queda por demostrar el descubrimiento del 100% de una búsqueda con referencia actual, así como auditar ausencias en los casos descritos a continuación.

## Ausencias que todavía no se pueden certificar

Los casos de terreno muestran indicios de que el dato no está publicado. Sin embargo, el inventario nativo guardado por v4 está filtrado por claves conocidas; el HTML de Firecrawl no contiene los scripts originales y un contador de controles restantes igual a cero no demuestra por sí solo la presencia de todas las secciones. V5 añade atributos completos, identidad y presencia de secciones; esos datos todavía requieren un protocolo específico de auditoría de ausencia. Por eso los casos sin una afirmación explícita de ausencia conservan el estado sin resolver.

El siguiente experimento de ausencia deberá contrastar el inventario completo del anuncio identificado, las secciones realmente observadas, los controles desplegados, la descripción nativa y el HTML. Sólo podrá declarar un campo no publicado después de comprobar sus claves y alias y descartar valores explícitos o señales ambiguas en todas esas superficies. La prueba será una auditoría estructurada generada por el laboratorio, no una cita inventada ni una declaración del modelo. Una promoción genérica sin datos individualizados tampoco permite inventar habitaciones o diagnósticos.

## Reproducibilidad

`pnpm report:collector` genera `apps/collector-api/.data/reports/campaign.md` y `campaign.json`, junto con exportaciones por ejecución. El informe incluye los vínculos de reparación y los campos resueltos o pendientes por selección. No se deben sumar anuncios entre reparaciones: la misma identidad puede aparecer en varias ejecuciones.

Después de exportar, `node scripts/collector-native-audit.mjs` contrasta offline las letras DPE/GES del JSON con el elemento seleccionado y el atributo nativo del mismo anuncio y respuesta. Genera `native-evidence-audit.md` y JSON, sin consultas ni escrituras en la base. Reproduce 36 desacuerdos de letras en las tres ejecuciones v4 auditadas. El desacuerdo restante de los 37 documentados requiere revisión de una exención: en `3123938036` el modelo trasladó «non soumis» a GES, mientras DOM y atributo nativo muestran A; la exención explícita de la descripción se refiere a DPE. El auditor automático excluye exenciones, valores desconocidos y evidencia ambigua; no los cuenta como aciertos.

Los campos heredados conservan su fecha de observación; los reparados conservan la fecha de su evidencia. Ni una reparación local ni la combinación de consultas realizadas en momentos distintos equivalen a una captura nueva completa de la búsqueda. La evaluación independiente mantiene el umbral del 100% y permanece inconclusa sin una referencia actual reconciliada.
