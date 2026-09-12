# Reparación de detalles: evidencia del 12 de septiembre de 2026

La reparación dirigida mejora las fichas de Firecrawl, pero esta campaña todavía no verifica una búsqueda completa de Leboncoin. La referencia independiente actual sigue faltando y algunos campos permanecen sin resolver.

## Punto de partida

La ejecución `49f1dfd9-9799-455c-a281-e0fcd8b64e91` conserva 34 anuncios conocidos: 18 fichas pasaron la validación del laboratorio y 16 tenían 21 campos pendientes. La reparación no modificó esa ejecución ni volvió a consultar las 18 fichas sin faltantes registrados.

## Lo demostrado

- El piloto `a46e7e37-c8ff-4297-bb35-34948751e7d3` abrió Description y criterios adicionales de `3096819091`. La selección DOM y el atributo nativo identificaron GES **C**. El JSON del modelo declaró **G** y dejó vacías sus justificaciones. Se conservan ambas respuestas; la contradicción es comprobable en el artefacto `61fdd186-4a1b-4ebf-9cde-7c0235f835e2`.
- La nueva normalización permite rescatar hechos del DOM aunque el JSON esté mal formado. Las declaraciones inválidas quedan sin resolver y cualquier corrección de un diagnóstico queda señalada. El piloto se conserva con su resultado original; la reparación local `6bdb6f77-beac-456a-9f86-86b7bbd30098` recuperó GES C sin una segunda consulta.
- La ejecución `44b1d0bc-1448-4ea4-bb2b-435c9046ec6d` consultó las otras 15 fichas. Recuperó GES en `3177310233`, `3179454686`, `3179474322` y `3257780507`. Las primeras tres quedaron sin campos pendientes; la última conserva terreno pendiente.
- El texto «Non soumis au DPE» de `3123914026` permite representar su exención DPE. Su GES sigue sin resolver: esa declaración no se extrapola a otro diagnóstico.
- Las características de `3156106279` están publicadas en prosa. La reparación local `85296183-a40b-4662-8d02-f2a9d9393bfb` recuperó cuatro características desde el artefacto `f80d8405-e38a-41b8-a0c7-fd17bf069349`, sin otra consulta. La normalización conserva oraciones literales de características y criterios adicionales con evidencia exacta, sin convertir una negación o un proyecto hipotético en una característica positiva.

Al combinar por identidad los campos de la captura original y sus reparaciones, **23 de las 34 fichas quedan sin faltantes registrados**, frente a las 18 iniciales. Se resolvieron siete campos: cinco GES, una exención DPE y las características de una ficha. Permanecen **11 fichas incompletas con 14 campos pendientes**: terreno en diez, GES en dos, DPE en una y dormitorios en una. La captura original sigue conservando sus 18 fichas validadas y 16 incompletas; este agregado no sobrescribe ningún snapshot ni certifica una búsqueda completa.

El piloto costó 5 créditos y la tanda de 15 costó 75. Esta iteración consumió **80 créditos**, con consumo confirmado y ninguna operación incierta. El gasto acumulado Firecrawl fue **689 de los 5.000 créditos autorizados**; las reparaciones exclusivamente locales no añaden consumo.

## Ausencias que todavía no se pueden certificar

Los casos de terreno muestran indicios de que el dato no está publicado. Sin embargo, el inventario nativo guardado por v4 está filtrado por claves conocidas; el HTML de Firecrawl no contiene los scripts originales y un contador de controles restantes igual a cero no demuestra por sí solo la presencia de todas las secciones. Por eso esos casos conservan el estado sin resolver.

El siguiente experimento de ausencia necesitará registrar explícitamente el inventario completo de atributos del anuncio identificado, las secciones realmente observadas, los controles desplegados y la descripción completa. Sólo podrá declarar un campo ausente después de contrastar todas esas superficies y descartar valores explícitos o señales ambiguas. Una promoción genérica sin datos individualizados tampoco permite inventar habitaciones o diagnósticos.

## Reproducibilidad

`pnpm report:collector` genera `apps/collector-api/.data/reports/campaign.md` y `campaign.json`, junto con exportaciones por ejecución. El informe incluye los vínculos de reparación y los campos resueltos o pendientes por selección. No se deben sumar anuncios entre reparaciones: la misma identidad puede aparecer en varias ejecuciones.

Los campos heredados conservan su fecha de observación; los reparados conservan la fecha de su evidencia. Ni una reparación local ni la combinación de consultas realizadas en momentos distintos equivalen a una captura nueva completa de la búsqueda. La evaluación independiente mantiene el umbral del 100% y permanece inconclusa sin una referencia actual reconciliada.
