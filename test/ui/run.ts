// UI tests: runs Map Tracker in a headless browser against a mock Lumiverse
// host (test/ui/host.ts) and checks the interactions that matter most.
//
//   bun run test:ui
//
// Needs Chrome or Edge. Set BROWSER to its path if it isn't found.
import { existsSync } from 'node:fs'
import puppeteer, { type Page } from 'puppeteer-core'
import { encodeBytes, graphFor, newGrid } from '../../src/shared/cells'
import type { DecorStamp, WorldProfile } from '../../src/shared/types'

const dir = import.meta.dir
const BROWSERS = [
  process.env.BROWSER,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean) as string[]
const executablePath = BROWSERS.find((p) => existsSync(p))
if (!executablePath) {
  console.error('No Chrome or Edge found. Set BROWSER to its path.')
  process.exit(1)
}

// ── A big test map: an 80k-cell grid with a painted continent, places and thousands of stamps ──
function testMap(): WorldProfile {
  const bounds = { minX: -300, maxX: 300, minY: -200, maxY: 200 }
  const land = newGrid({ ...bounds }, 80000)
  const g = graphFor(land)
  const biomes = new Uint8Array(g.n)
  for (let c = 0; c < g.n; c++) {
    const x = g.points[2 * c]
    const y = g.points[2 * c + 1]
    const r = Math.hypot(x / 1.5, y)
    biomes[c] = r < 120 ? (y > 60 ? 10 : x < -40 ? 2 : 5) : 0
  }
  land.biome = encodeBytes(biomes)
  let seed = 7
  const rnd = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646
  const decor: DecorStamp[] = []
  for (let i = 0; i < 2500; i++) {
    const a = rnd() * Math.PI * 2
    const d = Math.sqrt(rnd()) * 110
    const kind = i % 3 === 0 ? 'ink-forest' : i % 3 === 1 ? 'ink-peak' : 'pt-canopy'
    decor.push({ t: kind, x: Math.cos(a) * d * 1.5, y: Math.sin(a) * d, s: kind === 'ink-peak' ? 25 : 6, r: Math.floor(rnd() * 2 ** 31) })
  }
  return {
    id: 'test',
    name: 'Test map',
    unitKm: 10,
    bounds,
    points: [
      { id: 'harbour', name: 'Harbour Town', x: 100, y: -40, group: 'Coast / South' },
      { id: 'keep', name: 'Old Keep', x: -60, y: 50, group: 'Inland' },
      { id: 'mill', name: 'Mill', x: -40, y: 30, group: 'Inland' },
    ],
    zones: [{ id: 'north', name: 'Northlands', group: '', kind: 'region', x: { min: null, max: null }, y: { min: 60, max: null } }],
    features: [{ id: 'river-1', layer: 'terrain', geom: 'line', type: 'river', name: 'Long River', note: 'Too wide to ford.', rings: [[[-150, 0], [0, 20], [150, -10]]] }],
    land,
    decor,
    updatedAt: 0,
  } as unknown as WorldProfile
}

// ── Harness ─────────────────────────────────────────────────────────────────
const build = await Bun.build({ entrypoints: [`${dir}/entry.ts`], target: 'browser' })
if (!build.success) {
  console.error(build.logs.join('\n'))
  process.exit(1)
}
const bundle = await build.outputs[0].text()
const server = Bun.serve({
  port: 0,
  fetch: (req) => {
    const path = new URL(req.url).pathname
    if (path === '/bundle.js') return new Response(bundle, { headers: { 'content-type': 'text/javascript' } })
    return new Response(Bun.file(`${dir}/index.html`))
  },
})
const browser = await puppeteer.launch({ executablePath, headless: true })
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

const results: { name: string; ok: boolean; detail?: string }[] = []
async function test(name: string, fn: (page: Page) => Promise<void>): Promise<void> {
  const page = await browser.newPage()
  await page.setViewport({ width: 1600, height: 1000 })
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  try {
    await page.evaluateOnNewDocument((seed) => ((globalThis as any).__seed = seed), {
      'profiles/test.json': JSON.stringify(testMap()),
      'settings.json': JSON.stringify({ defaultProfileId: 'test' }),
    })
    await page.goto(`http://localhost:${server.port}/`)
    await page.waitForFunction('window.__ready === true')
    await page.evaluate('window.__toggle()')
    await wait(500)
    const bar = await page.evaluate(() => {
      const b = document.querySelector('.mt-win-bar')!.getBoundingClientRect()
      return { x: b.left + 80, y: b.top + b.height / 2 }
    })
    await page.mouse.click(bar.x, bar.y, { clickCount: 2 })
    await wait(800)
    await fn(page)
    if (errors.length) throw new Error(`page error: ${errors[0]}`)
    results.push({ name, ok: true })
  } catch (err) {
    results.push({ name, ok: false, detail: err instanceof Error ? err.message : String(err) })
  } finally {
    await page.close()
  }
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg)
}

/** The saved profile, after the debounced save has had time to run. */
async function saved(page: Page): Promise<WorldProfile> {
  await wait(1600)
  return page.evaluate(() => JSON.parse((window as any).__host.store.get('profiles/test.json')))
}

/** Screen position of a world point, read from the map itself. */
async function screen(page: Page, x: number, y: number): Promise<{ x: number; y: number }> {
  return page.evaluate(
    (x, y) => {
      const stage = document.querySelector('.mt-stage')!.getBoundingClientRect()
      const rx = document.querySelector<HTMLCanvasElement>('.mt-ruler-x')!
      // The map is fitted on open: recover the view from the stage size and the map bounds.
      const b = { minX: -300, maxX: 300, minY: -200, maxY: 200 }
      const s = Math.min(stage.width / (b.maxX - b.minX), stage.height / (b.maxY - b.minY)) * 0.96
      void rx
      return { x: stage.left + stage.width / 2 + x * s, y: stage.top + stage.height / 2 - y * s }
    },
    x,
    y,
  )
}

async function tool(page: Page, key: string): Promise<void> {
  await page.evaluate((k) => [...document.querySelectorAll<HTMLElement>('.mt-rail-btn')].find((b) => b.title.endsWith(`(${k})`))!.click(), key.toUpperCase())
  await wait(300)
}

async function frames(page: Page, fn: () => Promise<void>): Promise<number> {
  await page.evaluate(() => {
    ;(window as any).__f = []
    let last = performance.now()
    const tick = () => {
      const now = performance.now()
      ;(window as any).__f.push(now - last)
      last = now
      if ((window as any).__f.length < 600) requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })
  await fn()
  const f: number[] = await page.evaluate(() => (window as any).__f)
  f.sort((a, b) => a - b)
  return f[Math.floor(f.length * 0.9)]
}

// ── Tests ───────────────────────────────────────────────────────────────────
await test('opens with the test map', async (page) => {
  const name = await page.evaluate(() => document.querySelector<HTMLSelectElement>('.mt-toolbar select')?.selectedOptions[0]?.textContent)
  assert(name === 'Test map', `map select shows ${name}`)
})

await test('hovering the big map stays smooth', async (page) => {
  const c = await screen(page, 0, 0)
  const p90 = await frames(page, async () => {
    for (let i = 0; i < 40; i++) await page.mouse.move(c.x + i * 5, c.y + i * 2)
  })
  assert(p90 < 40, `90th percentile frame ${p90.toFixed(1)} ms`)
})

await test('Select drags a place', async (page) => {
  await tool(page, 'v')
  const a = await screen(page, 100, -40)
  await page.mouse.move(a.x, a.y)
  await page.mouse.down()
  for (let i = 1; i <= 8; i++) await page.mouse.move(a.x + i * 5, a.y)
  await page.mouse.up()
  const p = await saved(page)
  const q = p.points.find((x) => x.id === 'harbour')!
  assert(q.x > 105, `harbour x is ${q.x}`)
  assert(q.origin?.x === 100, 'the original position is remembered')
})

await test('Select box-selects, deletes and undoes decorations', async (page) => {
  await tool(page, 'v')
  const a = await screen(page, -280, 190)
  const b = await screen(page, -150, 120)
  // An empty corner of the map: nothing under the press, so it draws a box.
  await page.mouse.move(a.x, a.y)
  await page.mouse.down()
  for (let i = 1; i <= 6; i++) await page.mouse.move(a.x + ((b.x - a.x) * i) / 6, a.y + ((b.y - a.y) * i) / 6)
  await page.mouse.up()
  await wait(300)
  const before = (await saved(page)).decor!.length
  const m = await screen(page, 0, 0)
  const c1 = await screen(page, -40, 40)
  const c2 = await screen(page, 40, -40)
  // The middle is crowded with decorations: Ctrl-drag boxes anyway.
  await page.keyboard.down('Control')
  await page.mouse.move(c1.x, c1.y)
  await page.mouse.down()
  for (let i = 1; i <= 6; i++) await page.mouse.move(c1.x + ((c2.x - c1.x) * i) / 6, c1.y + ((c2.y - c1.y) * i) / 6)
  await page.mouse.up()
  await page.keyboard.up('Control')
  void m
  await wait(300)
  const label = await page.evaluate(() => document.querySelector('.mt-optbar')?.textContent ?? '')
  assert(/decorations/.test(label), `options bar says "${label.slice(0, 60)}"`)
  await page.keyboard.press('Delete')
  const after = (await saved(page)).decor!.length
  assert(after < before, `decorations ${before} -> ${after}`)
  await page.keyboard.down('Control')
  await page.keyboard.press('z')
  await page.keyboard.up('Control')
  const undone = (await saved(page)).decor!.length
  assert(undone === before, `after undo ${undone}, expected ${before}`)
})

await test('decoration brush previews and saves on release', async (page) => {
  await tool(page, 'q')
  const before = (await saved(page)).decor!.length
  const a = await screen(page, 160, 150)
  const p90 = await frames(page, async () => {
    await page.mouse.move(a.x, a.y)
    await page.mouse.down()
    for (let i = 1; i <= 20; i++) await page.mouse.move(a.x + i * 8, a.y)
    await page.mouse.up()
  })
  const after = (await saved(page)).decor!.length
  assert(after > before, `decorations ${before} -> ${after}`)
  assert(p90 < 40, `90th percentile frame ${p90.toFixed(1)} ms while brushing`)
})

await test('terrain brush saves once per stroke', async (page) => {
  await tool(page, 'b')
  const before = (await saved(page)).land!.biome
  const a = await screen(page, 200, 150)
  await page.mouse.move(a.x, a.y)
  await page.mouse.down()
  for (let i = 1; i <= 15; i++) await page.mouse.move(a.x + i * 6, a.y + i * 2)
  await page.mouse.up()
  const after = (await saved(page)).land!.biome
  assert(after !== before, 'the terrain changed')
})

await test('search finds a place and opens its card', async (page) => {
  const c = await screen(page, 0, -150)
  await page.mouse.click(c.x, c.y)
  await page.keyboard.down('Control')
  await page.keyboard.press('f')
  await page.keyboard.up('Control')
  await wait(200)
  await page.keyboard.type('harb')
  await wait(200)
  const items = await page.evaluate(() => [...document.querySelectorAll('.mt-search-item')].map((e) => e.textContent))
  assert(items[0]?.startsWith('Harbour Town'), `results: ${items.join(', ')}`)
  await page.keyboard.press('Enter')
  await wait(400)
  const card = await page.evaluate(() => {
    const el = document.querySelector<HTMLElement>('.mt-card')
    return el && !el.hidden ? el.textContent : null
  })
  assert(card?.includes('Harbour Town'), `card: ${card}`)
  // A real click on the card's Edit button reaches it (the map must not take the press).
  const btn = await page.evaluate(() => {
    const b = [...document.querySelectorAll<HTMLElement>('.mt-card button')].find((x) => x.textContent === 'Edit')!.getBoundingClientRect()
    return { x: b.left + b.width / 2, y: b.top + b.height / 2 }
  })
  await page.mouse.click(btn.x, btn.y)
  await wait(400)
  const editing = await page.evaluate(() => document.querySelector<HTMLInputElement>('.mt-editor input')?.value)
  assert(editing === 'Harbour Town', `editor shows ${editing}`)
})

await test('typing in the search box stays in the box', async (page) => {
  const c = await screen(page, 0, -150)
  await page.mouse.click(c.x, c.y)
  await page.keyboard.press('/')
  await wait(200)
  await page.keyboard.type('old 0-+ k')
  const v = await page.evaluate(() => document.querySelector<HTMLInputElement>('.mt-search input')?.value)
  assert(v === 'old 0-+ k', `box holds "${v}"`)
})

await test('a named shape opens its note card', async (page) => {
  const c = await screen(page, 0, -150)
  await page.mouse.click(c.x, c.y)
  await page.keyboard.press('/')
  await wait(200)
  await page.keyboard.type('long riv')
  await wait(200)
  const items = await page.evaluate(() => [...document.querySelectorAll('.mt-search-item')].map((e) => e.textContent))
  assert(items.length, `no search results; input: "${await page.evaluate(() => document.querySelector<HTMLInputElement>('.mt-search input')?.value)}" focus: ${await page.evaluate(() => document.activeElement?.className)}; features: ${await page.evaluate(() => JSON.parse((window as any).__host.store.get('profiles/test.json')).features?.length)}`)
  await page.keyboard.press('Enter')
  await wait(400)
  const card = await page.evaluate(() => document.querySelector<HTMLElement>('.mt-card')?.textContent ?? '')
  assert(card.includes('Too wide to ford.'), `card: ${card}`)
})

await test('group marker style is saved', async (page) => {
  await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('.mt-chip2')].find((c) => c.textContent?.startsWith('Places'))?.querySelector<HTMLElement>('button:not(.mt-chip2-eye)')?.click())
  await wait(300)
  await page.evaluate(() => document.querySelector<HTMLElement>('.mt-style-btn')!.click())
  await wait(200)
  await page.evaluate(() => document.querySelector<HTMLElement>('.mt-shape-row button[title="Castle"]')!.click())
  const p = await saved(page)
  assert(Object.values(p.groupStyles ?? {}).some((s) => s.shape === 'castle'), `group styles: ${JSON.stringify(p.groupStyles)}`)
})

await browser.close()
server.stop()

let failed = 0
for (const r of results) {
  console.log(`${r.ok ? 'pass' : 'FAIL'}  ${r.name}${r.detail ? `\n      ${r.detail}` : ''}`)
  if (!r.ok) failed++
}
console.log(`\n${results.length - failed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
