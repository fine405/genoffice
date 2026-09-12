# Image font picker

Shared React dialog and Node service adapter for the Lens v1 font service. The
first host is GenOffice Slides. Docs and Sheets are not connected yet.

## Local development

Start the existing Lens backend in its own repository (after its setup and model
download steps):

```sh
uv run --project backend --env-file backend/.env uvicorn app:app --app-dir backend --host 127.0.0.1 --port 8000
```

Then, from the GenOffice repository root:

```sh
npm install
npm run dev
```

The default service is `http://127.0.0.1:8000/api/v1`. For a separate deployment,
set `GENOFFICE_FONT_SERVICE_URL` and, if required,
`GENOFFICE_FONT_SERVICE_API_KEY` in the environment that launches GenOffice.
Only HTTPS or loopback HTTP endpoints are accepted. The API key stays in the
Electron main process. A production service must use its authenticated v1
endpoint; the workbench backend above is a local development adapter.

Open a PPTX and use **Home → font dropdown → Find font from image…**.
Select editable text first to also enable **Add and apply**. Alternatively,
right-click a picture and choose **Identify image font…**; this route only
discovers and adds fonts. It does not replace text inside an image.

Images can come from a file, the clipboard, or pictures in the presentation.
The picker displays the normalized original, including portions hidden by the
slide's picture crop. Drag a rectangle over the desired text, then identify it.
Crop coordinates refer to original image pixels, independent of zoom.

Font preparation, byte download progress, verification and loading are shown
separately. Adding a font completes only after its document font face has loaded.
Downloads from the font menu or missing-font banner also show a persistent
notification until loading succeeds or fails; failed loads can be retried.
Added, downloaded and locally imported fonts appear under **Custom fonts** at
the top of the font menu. **Downloadable fonts** only lists uninstalled families.

## Integration

- `FontPicker`: UI, image crop, candidate and variant selection, actual font
  previews, download/add/apply actions, and dialog cleanup.
- `types`: the host bridge contract. The host provides document pictures, a
  captured text target, and an application callback.
- `service`: a Node-only, per-dialog Lens SDK session. It tracks owned image IDs
  and recognized font IDs, deduplicates font downloads, checks file size and
  SHA-256, aborts pending requests and deletes uploaded images on close.
- `apps/slides/src/main/font-picker.ts`: service configuration, IPC, native
  download dialog and private font installation.
- `apps/slides/src/renderer/lens-font-picker.tsx`: document picture extraction,
  text selection preservation and the existing Slides formatting/history APIs.

Installed static TTF/OTF faces live under Electron's `userData/fonts/lens`.
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
npm run test -w @genoffice/slides -- tests/lens-font-store.test.ts
npm run typecheck -w @genoffice/font-picker
npm run typecheck -w @genoffice/slides
npm run build:all
npm run test:e2e -- e2e/slides-font-picker.spec.ts
```

The Electron test uses a local fixture service and real font bytes, so it does
not require model weights or an Internet connection. It exercises the actual
editor, download dialog, private font store and saved PPTX.
