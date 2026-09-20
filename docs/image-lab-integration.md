# Image Lab in Slides（Preview）

This branch connects Slides to the local Image Lab background removal service.
The picture ribbon, format pane, context menu and AI `remove_image_background`
tool use the same main-process job lifecycle. The previous Slides color-tolerance
algorithm has been removed. Other editors keep their existing behavior.

## Local development

Use `make start`, `make stop` and `make status` in GenOffice for the integrated
workflow. It connects both Lab APIs and supplies the Image Lab token file
automatically; see [local development](local-development.md). The manual workflow
below remains available.

Start Image Lab with `make dev` in its repository. Prepare its model as described
in Image Lab's README (`make prepare` for a new setup). Then launch GenOffice
with the token file available to its main process:

```sh
export GENOFFICE_IMAGE_LAB_URL=http://127.0.0.1:7100
export GENOFFICE_IMAGE_LAB_TOKEN_FILE=/absolute/path/to/image-lab/.runtime/token
npm run build -w @genoffice/slides
npm run build -w @genoffice/shell
npm run dev -w @genoffice/shell
```

`GENOFFICE_IMAGE_LAB_TOKEN` is an alternative to the token file. Never place the
credential in renderer configuration. Restart the shell after configuring it.
The adapter accepts loopback HTTP or HTTPS, static PNG/JPEG/WebP up to 20 MiB;
the service enforces its 16-megapixel limit. It does not start or bundle Python.

Select a picture → **Remove Background（Preview）** → wait for the real processing
stage → compare Original/Result → Apply. Cancellation aborts the job; failures
leave the source unchanged and offer Retry. Applying reuses the preview PNG,
preserves crop/geometry/effects and records one undoable image replacement.
Changed targets or document sessions reject a late result. AI uses the same
transaction without opening a dialog, and reports success only after applying.
No cloud or color-tolerance fallback is used.

Font recognition and custom font entries also carry the `（Preview）` suffix.

## Distribution status

The vendored Image Lab SDK does not declare a license. On 2026-09-14 its owner
requested local development only and declined adding one for now. The license
check is intentionally not bypassed; release packaging remains blocked. Runtime
bundling and integration with Docs/PDF/HTML are outside this change.
