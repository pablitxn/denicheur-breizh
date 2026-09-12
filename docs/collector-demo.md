# Probar el laboratorio

## Abrirlo en esta máquina

Abrir [http://127.0.0.1:5175](http://127.0.0.1:5175). Si la demo sigue encendida, no hace falta arrancar otro proceso. Conservar el `.env` y la base del checkout: contienen la configuración y el consumo acumulado de las pruebas.

Si no responde, ejecutar desde la raíz del repositorio:

```bash
pnpm dev:collector
```

La interfaz usa el puerto 5175 y su API el 4315. Cerrar la pestaña no cancela una captura; detener el backend sí interrumpe su seguimiento. Para capturar mientras se edita código, iniciar el backend sin recarga automática:

```bash
pnpm build:collector
pnpm --filter @denicheur-breizh/collector-api start
# En otra terminal:
pnpm --filter @denicheur-breizh/collector-web dev
```

Elegir uno de los dos modos de arranque; no iniciar otra API sobre el mismo puerto o la misma base. Para un checkout nuevo, seguir la configuración inicial de [collector-lab.md](collector-lab.md). Las claves van únicamente en `apps/collector-api/.env`; el frontend puede consultar resultados sin ellas.

## Revisar lo obtenido sin gastar créditos

1. Abrir la [captura nueva desde una URL](http://127.0.0.1:5175/?view=history&run=78b42920-31a3-4ef8-97f4-a64e43703465), **POC v7 — validation d’une fiche depuis son URL**. Terminó con una ficha extraída, cero fallos y 11 fotos, en 25,6 segundos y con 5 créditos confirmados.
2. Abrir también la [reparación local de las dos galerías](http://127.0.0.1:5175/?view=history&run=7269fee2-6041-4f10-9281-d478b79a5adc), **Réparation v7 — galeries complètes depuis les preuves conservées**: dos fichas extraídas, cero fallos, cero tareas pendientes y coste adicional de cero créditos. Cada ejecución muestra su estrategia y conserva su historial.
3. Abrir una tarjeta. Revisar descripción, imágenes y **Estado de cada campo / Field states**, con motivos, evidencias y fechas. Los campos heredados conservan su fecha original y los reparados muestran la fecha de su actualización. Una ficha incompleta conserva igualmente los datos que sí se obtuvieron.
4. Cambiar entre tarjetas y tabla. **Exportar / Export** descarga la captura completa, incluidas las evidencias; la paginación de pantalla no recorta el archivo.
5. En **Evaluación / Evaluation**, abrir un informe del historial. Las referencias históricas incompletas dan un resultado **inconcluso**, como corresponde; no sirven para certificar cobertura actual.

Consultar, abrir informes y exportar no realizan llamadas pagadas. **Reanudar / Resume** sí puede enviar nuevas solicitudes para los trabajos fallidos.

La captura nueva recuperó los 16 campos observados sin faltantes. El GES propuesto por el modelo era D y se corrigió a C con evidencia nativa. La reparación local reutilizó el recorrido guardado en `a7e2f69c-f92e-4cdc-968d-06ae415eeb2a`: las galerías tenían 12 y 17 posiciones, correspondientes a 11 y 16 fotos más un panel final de contacto, no una foto adicional. Esa reparación no volvió a llamar al proveedor; la captura anterior conserva su propio consumo.

Ambas ejecuciones están terminadas y sus detalles cumplen la validación del laboratorio. Su cobertura sigue **sin verificar** (`coverage: unknown`): no demuestran el 100% de una búsqueda ni reemplazan una referencia independiente completa.

Para trabajar sobre faltantes o diferencias con evidencia nativa, abrir **Corregir detalles → Revisar campos para corregir** en una captura Firecrawl terminada. Las nuevas reparaciones usan **Recorrido de galería (v7)**; el plan muestra esa versión antes de crear la ejecución vinculada y separa las correcciones locales de las consultas pagadas. Ver [reparación dirigida](collector-repair.md).

Para ver el avance histórico sin gastar, seleccionar **Réparation v4 — les 15 autres fiches incomplètes** y revisar los GES recuperados. **Réparation v4 — GES C récupéré depuis la preuve DOM** y **Réparation v4 — caractéristiques depuis la description** muestran reparaciones hechas sólo con evidencia local. El antiguo recuento de 23 de 34 fichas sin faltantes correspondía a la validación de esa etapa: no certifica exactitud ni cobertura del 100%, y las auditorías nativas posteriores encontraron diferencias que requieren revisión. Ver [los resultados de reparación](collector-repair-findings.md).

El [piloto v6 guardado](http://127.0.0.1:5175/?view=history&run=fbf80860-ee49-4bf6-9855-c15a47791bab), **POC v6 — galerie ouverte et compteurs réconciliés**, conserva su resultado **parcial**. Abrir y cerrar la galería funcionó, pero no explicó las diferencias entre 11 imágenes y 12 posiciones, ni entre 16 y 17. Sus URLs se conservaron y `imageUrls` quedó sin resolver. El recorrido posterior de v7 identificó los paneles finales; ese hallazgo no reescribe el resultado histórico de v6.

## Hacer una captura nueva con Firecrawl

1. Entrar en **Nueva captura / New capture**.
2. Fuente: **Leboncoin**. Proveedor: **Firecrawl**.
3. Revisar la estrategia seleccionada. El valor predeterminado para una nueva captura Firecrawl es **Recorrido de galería (v7)** (`firecrawl-gallery-walk-v7`): recorre cada posición del modal de imágenes y conserva como incompleto un recorrido sin avance. V4, v5 y v6 siguen disponibles para comparar. Un borrador anterior conserva su estrategia; los borradores antiguos que usaban implícitamente v1 siguen en v1. Elegir v7 explícitamente para una nueva prueba de ese recorrido.
4. Modo: **Anuncios conocidos / Known listings**. Pegar una URL de anuncio por línea y darle un nombre a la captura.
5. Iniciar y observar el progreso. **Detener / Stop** impide los siguientes despachos; una solicitud que ya está en curso puede facturarse.

Para reproducir la captura nueva validada, usar `https://www.leboncoin.fr/ad/ventes_immobilieres/3094507263`. Su disponibilidad y contenido pueden cambiar; el resultado guardado corresponde a la observación del 12 de septiembre de 2026.

El modo **Búsqueda completa / Complete search** prueba descubrimiento y detalle. Sigue siendo experimental en Leboncoin: los bloqueos, filtros sin verificar o páginas pendientes impiden declarar cobertura completa. V7 demostró extracción de una URL conocida y resolución de las dos galerías evaluadas; todavía falta una búsqueda contrastada al 100% con una referencia completa.

Las claves permanecen en el backend. El presupuesto acumulado del laboratorio se consulta en **Settings → Development**: US$25 de xAI y 5.000 créditos de Firecrawl son límites para el conjunto de la evaluación, sujetos al saldo real, no un presupuesto nuevo por captura. Se separan consumo confirmado, estimaciones y consumo desconocido; este último debe reconciliarse antes de nuevos despachos. Una captura nueva puede consumir créditos; el laboratorio no activa recargas automáticas.

Al cierre de esta evaluación se registraron 849 de 5.000 créditos Firecrawl confirmados, sin consumo desconocido ni reservas pendientes. Consultar el panel para el estado posterior a nuevas pruebas.

## Evidencias y comandos útiles

```bash
# Verificación del software con proveedores simulados, sin gasto real:
pnpm check:collector

# Regenerar el informe local de todas las capturas, sin gasto real:
pnpm report:collector
```

La verificación final pasó 319 pruebas del laboratorio —290 de API, 20 de UI, 8 de contratos y 1 de CLI— y 27 E2E. Estas pruebas simuladas validan el software; las capturas anteriores sustentan los resultados observados en Leboncoin.

Los informes se generan en `apps/collector-api/.data/reports/`. La base, las capturas y las claves quedan en esta máquina, excluidas de Git. El commit conserva el código, los tests, la configuración de ejemplo y la documentación; en otro checkout habrá que configurar claves y copiar las evidencias que se deseen consultar.

Resultados iniciales: [collector-poc-findings.md](collector-poc-findings.md). Resultados y límites de las reparaciones y galerías: [collector-repair-findings.md](collector-repair-findings.md). Referencia completa de arranque, API y adaptadores: [collector-lab.md](collector-lab.md).
