# Local development with Make

From the GenOffice repository on macOS/Linux:

```sh
make start     # Start in the background; reuse already-ready Lab APIs
make status    # Readiness, process ownership and log paths
make logs      # Recent output from each managed process
make stop      # Stop only the processes started by this entry point
make restart   # Restart managed processes and reload local configuration
```

`make start` runs the existing `npm run dev` workflow: six editor renderers,
stale preload rebuilding, and the Electron shell with main-process watching.
It also starts Font Lab's API on 8100 and Image Lab's API on 7100 if they are not
already available. It does not start their standalone Web apps, Font Lab's
font-generation worker or Ollama. An already-running API is reused and remains
running after `make stop`. Occupied but unhealthy ports produce an error rather
than terminating or replacing another process.

First install GenOffice dependencies with `npm ci`. Set up the two Lab
repositories and prepare their models using their own setup instructions. This
entry point does not download models or install Python dependencies. The first
GenOffice launch may take longer while missing/stale preloads are built.
Save your documents before stopping the development app, as with Ctrl+C in
`npm run dev`.

## Repository locations and credentials

The default sibling layout is:

```text
workspace/
  ai/font-lab/
  ai/image-lab/
  contributions/genoffice/
```

For a different layout, create an ignored `.env.local` in GenOffice:

```dotenv
FONT_LAB_DIR=/absolute/path/to/font-lab
IMAGE_LAB_DIR=/absolute/path/to/image-lab
```

Relative paths are resolved from GenOffice. Shell environment variables take
precedence over `.env.local`. Image Lab's `.runtime/token` is used automatically;
when this entry point starts that API, Image Lab creates the token file if needed.
Credentials are passed to the GenOffice main process, never saved in PID records.

Existing adapter overrides are also supported:

```dotenv
GENOFFICE_FONT_LAB_URL=http://127.0.0.1:8100/api/v1
GENOFFICE_IMAGE_LAB_URL=http://127.0.0.1:7100
GENOFFICE_IMAGE_LAB_TOKEN_FILE=/absolute/path/to/image-lab/.runtime/token
```

`GENOFFICE_FONT_LAB_API_KEY` and `GENOFFICE_IMAGE_LAB_TOKEN` remain available when
needed. For an API on a non-default address, start it separately; Make checks
and reuses it. GenOffice's editor dev ports remain 5173–5178 and the shell uses
5199, matching the existing root development command.

Managed PID records and logs live in ignored `.runtime/dev/`. `make status`
distinguishes managed processes, external APIs, startup/unhealthy services and
stopped services. `make logs` prints only the last 40 lines per service. A startup
failure leaves logs and any services already started available for diagnosis;
`make stop` cleans up the managed processes.

The Image Lab SDK remains approved for local development only. These commands
do not change licensing or bypass release checks; see
[Image Lab integration](image-lab-integration.md).
