# Image font picker

Shared React dialog and Node service adapter for the Font Lab v1 API. The
first host is GenOffice Slides. Docs and Sheets are not connected yet.

## Local development

Start Font Lab in its own repository (after `make setup`):

```sh
make dev
```

Then, from the GenOffice repository root:

```sh
npm install
npm run dev
```

The default service is `http://127.0.0.1:8100/api/v1`. For a separate deployment,
set `GENOFFICE_FONT_LAB_URL` and, if required,
`GENOFFICE_FONT_LAB_API_KEY` in the environment that launches GenOffice.
Only HTTPS or loopback HTTP endpoints are accepted. The API key stays in the
Electron main process. A production service must use its authenticated v1
endpoint. There is no legacy service fallback or configuration alias.

Open a PPTX and use **Home → font dropdown → Find font from image…**.
Select editable text first to also enable **Add and apply**. Alternatively,
right-click a picture and choose **Identify image font…**; this route only
discovers and adds fonts. It does not replace text inside an image.

Images can come from a file, the clipboard, or pictures in the presentation.
The picker displays the normalized original, including portions hidden by the
slide's picture crop. Drag a rectangle over the desired text, then identify it.
Crop coordinates refer to original image pixels, independent of zoom.
The image stage uses the same `react-image-crop` controls and thin corner frame
as Font Lab Web: move or resize a selection with the pointer or arrow keys,
add a region, or adjust an existing one. Numbered overlays link to the result
list. The host keeps GenOffice theme colors and document actions.

Font preparation, byte download progress, verification and loading are shown
separately. Adding a font completes only after its document font face has loaded.
Downloads from the font menu or missing-font banner also show a persistent
notification until loading succeeds or fails; failed loads can be retried.
Added, downloaded and locally imported fonts appear under **Custom fonts** at
the top of the font menu. **Downloadable fonts** only lists uninstalled families.

## Integration

- `FontPicker`: UI, image crop, candidate and variant selection, actual font
  previews, download/add/apply actions, and dialog cleanup.
- `ImageStage`: editable crops, numbered regions and zoom controls aligned with
  Font Lab Web.
- `@font-lab/sdk/browser`: FontFace creation, cancellation and disposal for previews.
- `types`: the host bridge contract. The host provides document pictures, a
  captured text target, and an application callback.
- `service`: a Node-only, per-dialog Font Lab SDK session. It tracks owned image IDs
  and recognized font IDs, deduplicates font downloads, checks file size and
  SHA-256, aborts pending requests and deletes uploaded images on close.
- `apps/slides/src/main/font-picker.ts`: service configuration, IPC, native
  download dialog and private font installation.
- `apps/slides/src/renderer/font-lab-picker.tsx`: document picture extraction,
  text selection preservation and the existing Slides formatting/history APIs.

Installed static TTF/OTF faces live under Electron's `userData/fonts/font-lab`.
The full face name preserves the chosen weight/style; the canvas and main
process layout use the same bytes. Installation does not alter system fonts.
Other formats and variable fonts can be downloaded but cannot yet be added.

Saving writes the typeface into PPTX; this feature does **not** embed the font
file. Other computers need the same font installed. Recognition suggests
similar fonts and does not guarantee an exact match. The service's model and
individual font licenses remain separate from the editor integration.

## Verification

```sh
npm run test -w @genoffice/font-picker
npm run test -w @genoffice/slides -- tests/font-lab-store.test.ts
npm run typecheck -w @genoffice/font-picker
npm run typecheck -w @genoffice/slides
npm run build:all
npm run test:e2e -- e2e/slides-font-picker.spec.ts
```

The Electron test uses a local fixture service and real font bytes, so it does
not require model weights or an Internet connection. It exercises the actual
editor, download dialog, private font store and saved PPTX.

This integration currently uses recognition and font download capabilities.
Font creation and Image Lab integration are outside this change. Existing Lens
private font files are not migrated or deleted; only `fonts/font-lab` is scanned
by this adapter.

To exercise the real local service with the built Electron app:

```sh
FONT_LAB_LIVE=1 npm run test:e2e -- e2e/slides-font-picker.spec.ts
```

The live case recognizes Font Lab's editorial example, previews the returned
Archivo Black face, applies it to selected text, saves the PPTX and checks its
custom-font entry. It requires Font Lab at `http://127.0.0.1:8100` and is skipped
in the ordinary fixture-only suite.
