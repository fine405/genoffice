/** Local macOS/Linux development lifecycle; never adopt or stop unrelated processes. */
import { spawn, execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
  openSync,
  closeSync,
} from 'node:fs'
import { createConnection } from 'node:net'
import { dirname, resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseEnv } from 'node:util'

const script = fileURLToPath(import.meta.url)
const root = resolve(dirname(script), '..')
const runtime = join(root, '.runtime', 'dev')
const localEnv = join(root, '.env.local')
const env = {
  ...(existsSync(localEnv) ? parseEnv(readFileSync(localEnv, 'utf8')) : {}),
  ...process.env,
}
const fontDir = resolve(root, env.FONT_LAB_DIR || '../../ai/font-lab')
const imageDir = resolve(root, env.IMAGE_LAB_DIR || '../../ai/image-lab')
env.GENOFFICE_FONT_LAB_URL ||= 'http://127.0.0.1:8100/api/v1'
env.GENOFFICE_IMAGE_LAB_URL ||= 'http://127.0.0.1:7100'
env.GENOFFICE_IMAGE_LAB_TOKEN_FILE = resolve(
  root,
  env.GENOFFICE_IMAGE_LAB_TOKEN_FILE || join(imageDir, '.runtime/token'),
)
delete env.ELECTRON_RUN_AS_NODE
const services = {
  'font-lab': { cwd: fontDir, command: 'make', args: ['api'], port: 8100 },
  'image-lab': {
    cwd: imageDir,
    command: 'uv',
    args: [
      'run',
      'image-lab',
      '--model-dir',
      '.models',
      'serve',
      '--port',
      '7100',
      '--token-file',
      env.GENOFFICE_IMAGE_LAB_TOKEN_FILE,
    ],
    port: 7100,
  },
  genoffice: { cwd: root, command: 'npm', args: ['run', 'dev'], port: 5199 },
}
const names = Object.keys(services)
const recordPath = (name) => join(runtime, `${name}.json`)
const logPath = (name) => join(runtime, `${name}.log`)
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

function owned(name) {
  try {
    const record = JSON.parse(readFileSync(recordPath(name), 'utf8'))
    const command = execFileSync('ps', ['-p', String(record.pid), '-o', 'command='], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    return command.includes(script) && command.includes(`supervise ${name} ${record.nonce}`)
      ? record
      : null
  } catch {
    return null
  }
}
async function portOpen(port) {
  return new Promise((done) => {
    const socket = createConnection({ port, host: 'localhost' })
    const finish = (open) => {
      socket.destroy()
      done(open)
    }
    socket.setTimeout(500)
    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
    socket.once('timeout', () => finish(false))
  })
}
async function ready(name) {
  try {
    if (name === 'genoffice') {
      return (await Promise.all([5173, 5174, 5175, 5176, 5177, 5178, 5199].map(portOpen))).every(
        Boolean,
      )
    }
    const headers = {}
    let url
    if (name === 'image-lab') {
      const token =
        env.GENOFFICE_IMAGE_LAB_TOKEN ||
        readFileSync(env.GENOFFICE_IMAGE_LAB_TOKEN_FILE, 'utf8').trim()
      headers.Authorization = `Bearer ${token}`
      url = new URL('/v1/capabilities', env.GENOFFICE_IMAGE_LAB_URL)
    } else {
      if (env.GENOFFICE_FONT_LAB_API_KEY)
        headers.Authorization = `Bearer ${env.GENOFFICE_FONT_LAB_API_KEY}`
      url = new URL(env.GENOFFICE_FONT_LAB_URL.replace(/\/$/, '') + '/capabilities')
    }
    if (
      url.username ||
      url.password ||
      !(
        url.protocol === 'https:' ||
        (url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))
      )
    )
      return false
    const response = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(2000),
      redirect: 'error',
    })
    if (!response.ok) return false
    const body = await response.json()
    return name === 'image-lab'
      ? body.operations?.some(
          (operation) =>
            operation.id === 'remove_background' &&
            operation.profiles?.some((profile) => profile.ready),
        ) === true
      : typeof body.max_upload_bytes === 'number'
  } catch {
    return false
  }
}

function supervise(name, nonce) {
  const spec = services[name]
  if (!spec || !nonce) throw new Error('Invalid supervisor request.')
  // The supervisor remains the process-group leader until its command exits.
  let closing = false
  const child = spawn(spec.command, spec.args, { cwd: spec.cwd, env, stdio: 'inherit' })
  const close = (code) => {
    if (closing) return
    closing = true
    process.on('SIGTERM', () => {})
    try {
      process.kill(-process.pid, 'SIGTERM')
    } catch {}
    try {
      const record = JSON.parse(readFileSync(recordPath(name), 'utf8'))
      if (record.nonce === nonce) rmSync(recordPath(name), { force: true })
    } catch {}
    process.exitCode = code
  }
  child.on('error', (error) => {
    console.error(error.message)
    close(1)
  })
  child.on('exit', (code) => close(code ?? 0))
  process.on('SIGTERM', () => {
    if (!closing) child.kill('SIGTERM')
  })
  process.on('SIGINT', () => {
    if (!closing) child.kill('SIGTERM')
  })
}

async function start(name) {
  if (owned(name)) {
    console.log(
      `${name}: already started${(await ready(name)) ? ' and ready' : '; still starting or unhealthy (see logs)'}`,
    )
    return
  }
  if (await ready(name)) {
    console.log(`${name}: reusing external service; make stop will leave it running`)
    return
  }
  const spec = services[name]
  if (name !== 'genoffice') {
    const configured = new URL(
      name === 'font-lab' ? env.GENOFFICE_FONT_LAB_URL : env.GENOFFICE_IMAGE_LAB_URL,
    )
    if (
      configured.origin !== `http://127.0.0.1:${spec.port}` &&
      configured.origin !== `http://localhost:${spec.port}`
    ) {
      throw new Error(
        `${name}: configured external API is not ready; start that service separately.`,
      )
    }
  }
  for (const port of name === 'genoffice'
    ? [5173, 5174, 5175, 5176, 5177, 5178, 5199]
    : [spec.port]) {
    if (await portOpen(port))
      throw new Error(
        `${name}: port ${port} is in use but the service is not ready. Check configuration/models; no existing process was stopped.`,
      )
  }
  if (!existsSync(join(spec.cwd, name === 'genoffice' ? 'node_modules' : 'Makefile'))) {
    throw new Error(
      `${name}: missing repository/dependencies at ${spec.cwd}. See docs/local-development.md.`,
    )
  }
  const nonce = randomUUID()
  const fd = openSync(logPath(name), 'a', 0o600)
  const child = spawn(process.execPath, [script, 'supervise', name, nonce], {
    cwd: root,
    env,
    detached: true,
    stdio: ['ignore', fd, fd],
  })
  closeSync(fd)
  await new Promise((done, reject) => {
    child.once('spawn', done)
    child.once('error', reject)
  })
  writeFileSync(recordPath(name), JSON.stringify({ pid: child.pid, nonce }), { mode: 0o600 })
  child.unref()
  console.log(`${name}: starting; log: ${logPath(name)}`)
  const deadline = Date.now() + 180_000
  while (Date.now() < deadline) {
    if (!owned(name)) throw new Error(`${name}: exited during startup. Run make logs.`)
    if (await ready(name)) {
      console.log(`${name}: ready`)
      return
    }
    await sleep(1000)
  }
  throw new Error(
    `${name}: startup is still incomplete. Run make status / make logs; make stop cancels startup.`,
  )
}
async function stop(name) {
  const record = owned(name)
  if (!record) {
    console.log(`${name}: no managed process; external services left running`)
    return
  }
  try {
    process.kill(-record.pid, 'SIGTERM')
  } catch (error) {
    if (error.code !== 'ESRCH') throw error
  }
  for (let attempt = 0; attempt < 50; attempt++) {
    if (!owned(name)) {
      console.log(`${name}: stopped`)
      return
    }
    await sleep(100)
  }
  throw new Error(
    `${name}: still shutting down; inspect ${logPath(name)}. No forced kill was issued.`,
  )
}
async function status() {
  for (const name of names) {
    const record = owned(name)
    const healthy = await ready(name)
    const state = record
      ? healthy
        ? 'ready (managed)'
        : 'starting / unhealthy (managed)'
      : healthy
        ? 'ready (external, left running by stop)'
        : (await portOpen(services[name].port))
          ? 'port occupied / API not ready'
          : 'stopped'
    console.log(`${name}: ${state}${record ? ` · PID ${record.pid}` : ''}`)
    console.log(`  log: ${logPath(name)}`)
  }
}

try {
  if (process.platform === 'win32')
    throw new Error('This Makefile lifecycle supports macOS/Linux. On Windows use npm run dev.')
  const action = process.argv[2]
  if (action === 'supervise') supervise(process.argv[3], process.argv[4])
  else if (action === 'status') await status()
  else if (action === 'logs') {
    for (const name of names) {
      console.log(`\n${name} — ${logPath(name)}`)
      console.log(
        existsSync(logPath(name))
          ? readFileSync(logPath(name), 'utf8').trimEnd().split('\n').slice(-40).join('\n')
          : 'No managed logs yet.',
      )
    }
  } else if (['start', 'stop', 'restart'].includes(action)) {
    mkdirSync(runtime, { recursive: true, mode: 0o700 })
    // A short-lived command lock prevents concurrent starts from spawning duplicates.
    const lock = join(runtime, 'command.lock')
    if (existsSync(lock)) {
      const pid = Number(readFileSync(lock, 'utf8'))
      let live = false
      try {
        process.kill(pid, 0)
        live = true
      } catch {}
      if (live && action === 'stop') {
        const command = execFileSync('ps', ['-p', String(pid), '-o', 'command='], {
          encoding: 'utf8',
        })
        if (
          command.includes('tools/dev-services.mjs start') ||
          command.includes('tools/dev-services.mjs restart')
        ) {
          process.kill(pid, 'SIGTERM')
          for (let attempt = 0; attempt < 50; attempt++) {
            try {
              process.kill(pid, 0)
            } catch {
              live = false
              break
            }
            await sleep(100)
          }
        }
      }
      if (live) throw new Error('Another lifecycle command is running. Wait for it to finish.')
      rmSync(lock, { force: true })
    }
    writeFileSync(lock, String(process.pid), { flag: 'wx', mode: 0o600 })
    try {
      if (action !== 'start') for (const name of [...names].reverse()) await stop(name)
      if (action !== 'stop') for (const name of names) await start(name)
      await status()
    } finally {
      rmSync(lock, { force: true })
    }
  } else throw new Error('Use make start, stop, restart, status or logs.')
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
}
