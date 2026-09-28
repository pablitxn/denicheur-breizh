# README media

[Project overview](../README.md) · [Local development](local-development.md)

The README uses real captures of the production web interface. It does not use generated interface mockups. The two GIFs are sequences of actual UI states, held for 2.5 seconds each so the transitions remain readable.

## Included assets

Captured on **28 September 2026**, in English, with the dark appearance at **1280 × 720**.

| File | Content |
|---|---|
| `media/property-catalog.jpg` | Seven source listings in the photo-card catalog. |
| `media/property-dossier.jpg` | Expanded dossier for a listing in Plovan. |
| `media/brittany-map.jpg` | South Finistère, a selected Trégunc listing, and the explicit locality-level location label. |
| `media/recipe-builder.jpg` | Version 2 of the illustrative English recipe, with weights and evidence requirements. |
| `media/property-tour.gif` | Catalog → side dossier → expanded dossier → gallery → essentials → capture history → table. Seven frames, 17.5 seconds. |
| `media/recipe-builder.gif` | Published recipe → revised draft → new version → plan draft → published plan. Five frames, 12.5 seconds. |

The JPEGs are the browser's original screenshot bytes. The GIF encoder preserves the viewport dimensions and only converts to a GIF palette. All six published assets together are approximately 2.5 MiB.

## What the examples represent

The property views use a disposable snapshot of an existing seven-listing collection. The observations shown are dated **18 July 2026**. They illustrate stored research, not current availability, prices, or a live collection. Source descriptions and photographs retain their original language and attribution/watermarks.

Only one of these seven records contains usable coordinates. The map faithfully shows its locality-level position and the six unlocated records; no coordinates were invented for presentation. The History frame identifies an imported legacy record as **Previous record** and retains the warning about combined earlier observations.

The **A home by the sea** recipe and **Coastal shortlist** plan are illustrative examples created through the real Builder in the temporary database. Their presence does not imply an AI evaluation was run. The captured listings remain visibly **Not evaluated**.

No provider calls, live collection, database reset, or changes to the original recipes were needed. The source SQLite file and its data are not committed with these assets. Review visible content before publishing future captures, especially if using a collection with personal notes or contact information. Keep source-photo and map attribution intact.

## Start an isolated preview

Install the workspace dependencies with the repository's pinned Node and pnpm versions. Then, from the repository root:

```bash
node scripts/readme-preview.mjs \
  --database "$PWD/apps/api/.data/denicheur.sqlite"
```

The `--database` path must be absolute and must refer to an existing database. The helper:

1. Opens the source read-only and uses SQLite's online backup API, including committed WAL contents.
2. Places the writable snapshot in a private OS temporary directory.
3. Runs the real API on `127.0.0.1:14320` and builds the production web app into that temporary directory.
4. Serves the production preview on **[127.0.0.1:14180](http://127.0.0.1:14180)**, with development overlays absent.
5. Disables OpenAI, Realtime, and media mirroring, excludes inherited credentials, and loads no `.env` files.
6. Checks readiness and refuses occupied ports. **Ctrl+C** stops its children and removes its own temporary directory.

Map tiles and original listing photos may still load over the network. The snapshot is not anonymized; isolation protects the original database from changes, not the confidentiality of what is visible on screen.

If local listeners are blocked by a sandbox, run the helper in an environment that permits loopback listeners. It never needs a public bind address. Browser preferences and recoverable Builder drafts belong to the preview origin; use a separate browser profile/context when you want those discarded automatically too.

## Capture the interface

Open the preview in a browser, use **Settings → General** to select **English** and **Dark**, and keep one consistent viewport for the complete sequence. Wait for fonts, photographs, map tiles, and API content to finish loading before each capture. Capture the viewport, retaining app navigation and attribution; do not change the DOM or hide inconvenient data to improve a shot.

Use a temporary directory outside Git for the intermediate JPEG frames. The initial capture used browser automation with accessible controls; the same sequence can be followed manually.

### Property sequence

| Frame | Action / state |
|---|---|
| `property-01.jpg` | Properties → Cards; no selected listing. Also save as `docs/media/property-catalog.jpg`. |
| `property-02.jpg` | Open a listing's details, keeping the collection alongside. |
| `property-03.jpg` | Expand dossier; its photograph and asking price are visible. Also save as `docs/media/property-dossier.jpg`. |
| `property-04.jpg` | Advance the gallery, then wait for the next photograph to render. |
| `property-05.jpg` | Scroll the expanded Overview to show the essentials and missing-information states. |
| `property-06.jpg` | History → open an archived capture; frame the heading, date, provenance caveat, and observed fields. |
| `property-07.jpg` | Close the dossier and switch back to Table. |

For the map still, select a geolocated result in **Map**, then adjust the zoom to include coastal context. Keep the location-precision label visible in the property preview and the missing-location count visible in the filters. Save to `docs/media/brittany-map.jpg`.

### Builder sequence

In the disposable preview, create a recipe with identifier `coastal-home-example`, name **A home by the sea**, and a relevance threshold of **70**. Enable **Require evidence** for all three criteria:

| Identifier | Name | Weight | Instruction and context |
|---|---|---:|---|
| `sea-view` | A sea view supported by evidence | 40 | Look for an explicit statement or a photograph showing the sea from the house or its grounds. Being near the coast is not enough. Return unknown when the evidence is inconclusive. |
| `outdoor-space` | Room to enjoy the outdoors | 35 | Find a garden, terrace, or usable outdoor area in the text or photographs. Cite the evidence. Do not infer ownership, boundaries, or usable area from an image alone. |
| `year-round-comfort` | Comfort beyond the summer | 25 | Review advertised heating, insulation, and energy information. Distinguish stated facts from assumptions. Flag missing diagnostic details as unknown rather than treating them as favorable. |

Publish the initial version, then capture:

| Frame | Action / state |
|---|---|
| `builder-01.jpg` | Published version 1 with its criteria and version history. |
| `builder-02.jpg` | Create version; change the threshold to 75 and make the sea-view criterion required. Show the editable criteria. |
| `builder-03.jpg` | Publish version 2. Also save as `docs/media/recipe-builder.jpg`. |
| `builder-04.jpg` | Plans → New plan. Name it **Coastal shortlist**, identifier `coastal-shortlist-example`, combination **All recipes**, with **A home by the sea · v2** pinned. |
| `builder-05.jpg` | Publish the plan. Show the exact pinned recipe version. No need to make it the default or run an evaluation. |

These example identifiers are intended for a fresh preview snapshot. If they already exist in a future source database, use fresh example identifiers and update the capture notes accordingly.

## Encode the GIFs

With `ffmpeg` and `ffprobe` installed and the twelve frames in a temporary directory:

```bash
node scripts/build-readme-gifs.mjs \
  --frames-dir /absolute/path/to/readme-frames
```

The encoder checks that every input exists and has matching dimensions, stages both GIFs before replacing the published files, and loops them indefinitely. It preserves the source screenshots. The output names are the ones linked from the README.

Check the files before committing:

```bash
file docs/media/*
ffprobe -v error -select_streams v:0 \
  -show_entries stream=width,height,nb_frames:format=duration,size \
  -of json docs/media/property-tour.gif
ffprobe -v error -select_streams v:0 \
  -show_entries stream=width,height,nb_frames:format=duration,size \
  -of json docs/media/recipe-builder.gif
git diff --check
```

Review every frame for loading placeholders, clipped headings, accidental private content, and misleading claims. Open the README with a Markdown renderer, check every media link, and replay both GIFs. Stop the preview with **Ctrl+C** once capture is complete; retain only the intended media and workflow files in the repository.
