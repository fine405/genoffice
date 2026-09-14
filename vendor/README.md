# Font Lab SDK snapshot

`font-lab-sdk-0.2.0.tgz` is an npm-packed build of `packages/sdk-typescript`
from `font-lab` (source commit `bea8a36`). It supplies the generated OpenAPI
contract, HTTP client and browser preview lifecycle used by
`@genoffice/font-picker`. The archive includes its Apache-2.0 LICENSE and no
models, recognition runtime or font files.

To refresh, run `pnpm build` and `npm pack` in Font Lab's
`packages/sdk-typescript`, copy the archive here, update the picker dependency
and run `npm install` in GenOffice. Keep the package and lockfile together.
Third-party models and fonts retain their own licenses.

# Image Lab client — local development only

`image-lab-client-0.1.0.tgz` is an npm-packed build of Image Lab's
`clients/typescript`. It contains the HTTP client only, without models or a
Python runtime. The SDK has no declared license. Its owner chose to retain
local development integration without licensing it on 2026-09-14; release
license checks must continue to reject this dependency until that is resolved.
Do not infer a license from GenOffice or the Font Lab SDK.
