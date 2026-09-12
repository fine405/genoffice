# Lens SDK snapshot

`lens-sdk-0.1.1.tgz` is an npm-packed build of `packages/sdk` from the local
`lens-web` project. It exposes the independent Lens v1 HTTP client used by
`@genoffice/font-picker`, with no runtime dependencies. It contains no model
weights, inference implementation or downloaded font files.

The package has not been published to a registry. Keeping the snapshot here
makes a checkout installable without a sibling workspace or private registry.
To update it, build the SDK in `lens-web`, run `npm pack` from its `packages/sdk`
directory, copy the resulting archive here, then update the dependency and
GenOffice lockfile together.

The SDK code is licensed under Apache-2.0 by its author. The archive includes
its LICENSE file. This applies only to the SDK, not to the Lens model, inference
implementation or font files, whose permissions remain independent.
