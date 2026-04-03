import puppeteer from 'puppeteer-core'
import http from 'http'

const BASE_URL          = process.env.TRAFFIC_BASE_URL || 'http://nginx'
const CONTROL_PORT      = 3002
const LOOP_DELAY        = { min: 800, max: 3000 }   // dashboard flows 1-9
const FUNNEL_DELAY      = { min: 300, max: 1200 }   // funnel between journeys
const FUNNEL_CONCURRENCY = 2                         // concurrent shopper workers

// ---------------------------------------------------------------------------
// Runtime state — on by default
// ---------------------------------------------------------------------------
let isRunning = true

// ---------------------------------------------------------------------------
// HTTP control server — POST /start, POST /stop, GET /status
// ---------------------------------------------------------------------------
http.createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json')

  if (req.method === 'POST' && req.url === '/start') {
    isRunning = true
    console.log('[control] traffic started')
    res.writeHead(200)
    res.end(JSON.stringify({ running: true }))
  } else if (req.method === 'POST' && req.url === '/stop') {
    isRunning = false
    console.log('[control] traffic stopped')
    res.writeHead(200)
    res.end(JSON.stringify({ running: false }))
  } else if (req.method === 'GET' && req.url === '/status') {
    res.writeHead(200)
    res.end(JSON.stringify({ running: isRunning }))
  } else {
    res.writeHead(404)
    res.end(JSON.stringify({ error: 'not found' }))
  }
}).listen(CONTROL_PORT, () => {
  console.log(`[control] listening on :${CONTROL_PORT}`)
})

// ---------------------------------------------------------------------------
// Shop catalogue — mirrors frontend/app/lib/shop.ts
// ---------------------------------------------------------------------------
const SHOP_ITEMS = {
  tshirt:   { name: 'Datadog T-Shirt',  price: 29.99 },
  hoodie:   { name: 'Datadog Hoodie',   price: 59.99 },
  sticker:  { name: 'Sticker Pack',     price:  9.99 },
  plush:    { name: 'Dog Plush Toy',    price: 19.99 },
  mug:      { name: 'Datadog Mug',      price: 14.99 },
  notebook: { name: 'Datadog Notebook', price: 12.99 },
}

const VALID_PROMOS   = ['10OFF', '15OFF', '20OFF', '50OFF']
const INVALID_PROMOS = ['100OFF', 'FREESHIP', 'BOGUS99', 'HALFOFF']

function sleep(min, max) {
  const ms = Math.floor(Math.random() * (max - min + 1)) + min
  return new Promise((r) => setTimeout(r, ms))
}

function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)]
}

async function launchBrowser() {
  return puppeteer.launch({
    executablePath: '/usr/bin/google-chrome-stable',
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  })
}

// ---------------------------------------------------------------------------
// Cart utility — reads griddog_cart from localStorage, computes totals
// Cart shape: Record<string, number> e.g. { "tshirt": 2, "mug": 1 }
// ---------------------------------------------------------------------------
async function readCart(page) {
  const raw = await page.evaluate(() => localStorage.getItem('griddog_cart') || '{}')
  try {
    const cart = JSON.parse(raw)
    const items = Object.entries(cart).map(([id, qty]) => ({
      id,
      name:       SHOP_ITEMS[id]?.name  || id,
      price:      SHOP_ITEMS[id]?.price ?? 0,
      qty:        Number(qty),
      line_total: parseFloat(((SHOP_ITEMS[id]?.price ?? 0) * Number(qty)).toFixed(2)),
    }))
    const cart_value = parseFloat(items.reduce((s, i) => s + i.line_total, 0).toFixed(2))
    const item_count = Object.values(cart).reduce((a, b) => a + Number(b), 0)
    return { items, item_count, cart_value }
  } catch {
    return { items: [], item_count: 0, cart_value: 0 }
  }
}

// ---------------------------------------------------------------------------
// Request interception: redirect localhost → nginx inside Docker
// (NEXT_PUBLIC_BACKEND_URL is baked at build time as http://localhost, which
//  doesn't resolve to nginx from inside the traffic container)
// ---------------------------------------------------------------------------
async function enableRequestRedirect(page) {
  await page.setRequestInterception(true)
  page.on('request', (req) => {
    const url = req.url()
    if (url.startsWith('http://localhost/')) {
      req.continue({ url: url.replace('http://localhost', BASE_URL) })
    } else {
      req.continue()
    }
  })
}

// ---------------------------------------------------------------------------
// Dashboard flow (flows 1-9): visit dashboard and click the Nth Send button
// ---------------------------------------------------------------------------
async function runDashboardFlow(page, flowNum) {
  await enableRequestRedirect(page)

  console.log(`[flow-${flowNum}] visiting dashboard`)
  await page.goto(`${BASE_URL}/`, { waitUntil: 'networkidle2', timeout: 30000 })

  const buttons = await page.$$('button')
  const sendButtons = []
  for (const btn of buttons) {
    const text = await btn.evaluate((el) => el.textContent?.trim())
    if (text === 'Send') sendButtons.push(btn)
  }

  if (sendButtons[flowNum - 1]) {
    await sendButtons[flowNum - 1].click()
    console.log(`[flow-${flowNum}] clicked Send button #${flowNum}`)
  } else {
    console.log(`[flow-${flowNum}] could not find Send button, skipping`)
  }

  await sleep(1000, 2000)
}

// ---------------------------------------------------------------------------
// Helper: click up to `count` "Add to Cart" buttons on the current shop page,
// then read and log the resulting cart state.
// ---------------------------------------------------------------------------
async function addItemsAndReadCart(page, count, tag) {
  const btns = await page.$$('button')
  let added = 0
  for (const btn of btns) {
    if (added >= count) break
    const txt = await btn.evaluate((el) => el.textContent?.trim())
    if (txt === 'Add to Cart') {
      await btn.click()
      added++
      await sleep(300, 700)
    }
  }

  const cart = await readCart(page)
  console.log(JSON.stringify({
    event:       'cart_built',
    journey:     tag,
    items:       cart.items,
    item_count:  cart.item_count,
    cart_value:  cart.cart_value,
  }))
  return cart
}

// ---------------------------------------------------------------------------
// Funnel Journey A (40%): shop → cart → checkout → valid promo → place order
// Backend always returns 500 (intentional simulation).
// ---------------------------------------------------------------------------
async function funnelJourneyA(page, workerId) {
  const tag       = `funnel-${workerId}/A`
  const promoCode = pickRandom(VALID_PROMOS)
  console.log(JSON.stringify({ event: 'journey_start', journey: tag, promo_plan: promoCode }))

  // — Shop: add 1-3 items
  await page.goto(`${BASE_URL}/shop`, { waitUntil: 'networkidle2', timeout: 30000 })
  await sleep(500, 1200)
  const itemCount = Math.floor(Math.random() * 3) + 1
  await addItemsAndReadCart(page, itemCount, tag)

  // — Cart: review
  await page.goto(`${BASE_URL}/cart`, { waitUntil: 'networkidle2', timeout: 30000 })
  await sleep(500, 1000)
  const cartAtView = await readCart(page)
  console.log(JSON.stringify({
    event:       'cart_viewed',
    journey:     tag,
    step:        'cart',
    item_count:  cartAtView.item_count,
    cart_value:  cartAtView.cart_value,
  }))

  // — Checkout
  const checkoutLink = await page.$('a[href="/checkout"]')
  if (checkoutLink) {
    await checkoutLink.click()
    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {})
  } else {
    await page.goto(`${BASE_URL}/checkout`, { waitUntil: 'networkidle2', timeout: 30000 })
  }
  await sleep(500, 1000)

  const cartAtCheckout = await readCart(page)
  console.log(JSON.stringify({
    event:       'checkout_reached',
    journey:     tag,
    step:        'checkout',
    item_count:  cartAtCheckout.item_count,
    cart_value:  cartAtCheckout.cart_value,
  }))

  // — Apply valid promo
  let discountPct = 0
  const input = await page.$('input[placeholder]')
  if (input) {
    await input.click({ clickCount: 3 })
    await input.type(promoCode)
    await sleep(300, 600)

    const applyBtns = await page.$$('button')
    for (const btn of applyBtns) {
      const txt = await btn.evaluate((el) => el.textContent?.trim())
      if (txt === 'Apply') { await btn.click(); break }
    }

    const applied = await page.waitForFunction(
      () => document.body.innerText.includes('Code applied'),
      { timeout: 8000 }
    ).then(() => true).catch(() => false)

    discountPct         = parseInt(promoCode.replace('OFF', ''), 10) || 0
    const discountAmt   = parseFloat((cartAtCheckout.cart_value * discountPct / 100).toFixed(2))
    const totalAfter    = parseFloat((cartAtCheckout.cart_value - discountAmt).toFixed(2))

    console.log(JSON.stringify({
      event:               'promo_applied',
      journey:             tag,
      promo_code:          promoCode,
      valid:               applied,
      discount_pct:        discountPct,
      discount_amt:        discountAmt,
      cart_value_before:   cartAtCheckout.cart_value,
      cart_value_after:    totalAfter,
    }))
    await sleep(400, 800)
  }

  // — Place Order (backend returns 500 intentionally)
  const orderBtns = await page.$$('button')
  for (const btn of orderBtns) {
    const txt = await btn.evaluate((el) => el.textContent?.trim())
    if (txt?.includes('Place Order')) { await btn.click(); break }
  }
  await sleep(1000, 2000)

  const discountAmt = parseFloat((cartAtCheckout.cart_value * discountPct / 100).toFixed(2))
  console.log(JSON.stringify({
    event:        'checkout_failed',
    journey:      tag,
    promo_code:   promoCode,
    discount_pct: discountPct,
    discount_amt: discountAmt,
    cart_value:   cartAtCheckout.cart_value,
    total_charged: parseFloat((cartAtCheckout.cart_value - discountAmt).toFixed(2)),
    items:        cartAtCheckout.items,
    reason:       'payment_gateway_unavailable_simulated_500',
  }))
}

// ---------------------------------------------------------------------------
// Funnel Journey B (30%): shop → cart → abandon (drop-off at cart)
// ---------------------------------------------------------------------------
async function funnelJourneyB(page, workerId) {
  const tag = `funnel-${workerId}/B`
  console.log(JSON.stringify({ event: 'journey_start', journey: tag }))

  await page.goto(`${BASE_URL}/shop`, { waitUntil: 'networkidle2', timeout: 30000 })
  await sleep(500, 1200)

  const itemCount = Math.floor(Math.random() * 2) + 1
  await addItemsAndReadCart(page, itemCount, tag)

  // View cart, then abandon
  await page.goto(`${BASE_URL}/cart`, { waitUntil: 'networkidle2', timeout: 30000 })
  await sleep(1500, 3000)

  const cartAtView = await readCart(page)
  console.log(JSON.stringify({
    event:       'cart_abandoned',
    journey:     tag,
    drop_off:    'cart',
    item_count:  cartAtView.item_count,
    cart_value:  cartAtView.cart_value,
    items:       cartAtView.items,
    reason:      'user_left_cart_page',
  }))

  await page.goto(`${BASE_URL}/shop`, { waitUntil: 'networkidle2', timeout: 30000 })
}

// ---------------------------------------------------------------------------
// Funnel Journey C (30%): shop → cart → checkout → invalid promo → abandon
// ---------------------------------------------------------------------------
async function funnelJourneyC(page, workerId) {
  const tag      = `funnel-${workerId}/C`
  const badPromo = pickRandom(INVALID_PROMOS)
  console.log(JSON.stringify({ event: 'journey_start', journey: tag, promo_plan: badPromo }))

  await page.goto(`${BASE_URL}/shop`, { waitUntil: 'networkidle2', timeout: 30000 })
  await sleep(500, 1200)

  const itemCount = Math.floor(Math.random() * 3) + 1
  await addItemsAndReadCart(page, itemCount, tag)

  await page.goto(`${BASE_URL}/cart`, { waitUntil: 'networkidle2', timeout: 30000 })
  await sleep(500, 1000)

  const checkoutLink = await page.$('a[href="/checkout"]')
  if (checkoutLink) {
    await checkoutLink.click()
    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {})
  } else {
    await page.goto(`${BASE_URL}/checkout`, { waitUntil: 'networkidle2', timeout: 30000 })
  }
  await sleep(500, 1000)

  const cartAtCheckout = await readCart(page)
  console.log(JSON.stringify({
    event:       'checkout_reached',
    journey:     tag,
    step:        'checkout',
    item_count:  cartAtCheckout.item_count,
    cart_value:  cartAtCheckout.cart_value,
  }))

  // Apply invalid promo
  const input = await page.$('input[placeholder]')
  if (input) {
    await input.click({ clickCount: 3 })
    await input.type(badPromo)
    await sleep(300, 600)

    const applyBtns = await page.$$('button')
    for (const btn of applyBtns) {
      const txt = await btn.evaluate((el) => el.textContent?.trim())
      if (txt === 'Apply') { await btn.click(); break }
    }

    const rejected = await page.waitForFunction(
      () => document.body.innerText.includes('Invalid or inactive'),
      { timeout: 8000 }
    ).then(() => true).catch(() => false)

    console.log(JSON.stringify({
      event:        'promo_rejected',
      journey:      tag,
      promo_code:   badPromo,
      valid:        false,
      error_shown:  rejected,
      cart_value:   cartAtCheckout.cart_value,
    }))
    await sleep(800, 1500)
  }

  // Abandon at checkout
  console.log(JSON.stringify({
    event:            'cart_abandoned',
    journey:          tag,
    drop_off:         'checkout',
    promo_attempted:  badPromo,
    item_count:       cartAtCheckout.item_count,
    cart_value:       cartAtCheckout.cart_value,
    items:            cartAtCheckout.items,
    reason:           'promo_rejected_user_left',
  }))

  await page.goto(`${BASE_URL}/shop`, { waitUntil: 'networkidle2', timeout: 30000 })
}

// ---------------------------------------------------------------------------
// Funnel Journey D (30%): shop → checkout directly, no promo → 500 error
// Simulates users who skip the promo step entirely
// ---------------------------------------------------------------------------
async function funnelJourneyD(page, workerId) {
  const tag = `funnel-${workerId}/D`
  console.log(JSON.stringify({ event: 'journey_start', journey: tag, promo_used: false }))

  await page.goto(`${BASE_URL}/shop`, { waitUntil: 'networkidle2', timeout: 30000 })
  await sleep(500, 1200)

  const itemCount = Math.floor(Math.random() * 3) + 1
  await addItemsAndReadCart(page, itemCount, tag)

  await page.goto(`${BASE_URL}/cart`, { waitUntil: 'networkidle2', timeout: 30000 })
  await sleep(500, 800)

  const checkoutLink = await page.$('a[href="/checkout"]')
  if (checkoutLink) {
    await checkoutLink.click()
    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {})
  } else {
    await page.goto(`${BASE_URL}/checkout`, { waitUntil: 'networkidle2', timeout: 30000 })
  }
  await sleep(500, 1000)

  const cartAtCheckout = await readCart(page)
  console.log(JSON.stringify({
    event:       'checkout_reached',
    journey:     tag,
    step:        'checkout',
    item_count:  cartAtCheckout.item_count,
    cart_value:  cartAtCheckout.cart_value,
    promo_used:  false,
  }))

  // Skip promo — place order immediately
  const orderBtns = await page.$$('button')
  for (const btn of orderBtns) {
    const txt = await btn.evaluate((el) => el.textContent?.trim())
    if (txt?.includes('Place Order')) { await btn.click(); break }
  }
  await sleep(1000, 2000)

  console.log(JSON.stringify({
    event:        'checkout_failed',
    journey:      tag,
    promo_code:   null,
    discount_pct: 0,
    discount_amt: 0,
    cart_value:   cartAtCheckout.cart_value,
    total_charged: cartAtCheckout.cart_value,
    items:        cartAtCheckout.items,
    reason:       'payment_gateway_unavailable_simulated_500',
  }))
}

// ---------------------------------------------------------------------------
// Funnel dispatcher — weighted random journey selection
// A (35%): valid promo → checkout → 500
// B (20%): cart abandon
// C (15%): bad promo → abandon at checkout
// D (30%): no promo → checkout → 500
// → 65% of journeys produce a checkout_failed event
// ---------------------------------------------------------------------------
async function runFunnelJourney(page, workerId) {
  await enableRequestRedirect(page)
  const rand = Math.random()
  if (rand < 0.35) {
    await funnelJourneyA(page, workerId)
  } else if (rand < 0.55) {
    await funnelJourneyB(page, workerId)
  } else if (rand < 0.70) {
    await funnelJourneyC(page, workerId)
  } else {
    await funnelJourneyD(page, workerId)
  }
}

// ---------------------------------------------------------------------------
// Funnel loop — runs concurrently with the main dashboard loop.
// Each journey gets its own browser context (isolated localStorage) so
// workers don't clear each other's carts when Place Order fires.
// ---------------------------------------------------------------------------
async function runFunnelLoop(browser, workerId) {
  console.log(`[funnel-${workerId}] worker started`)
  while (true) {
    if (!isRunning) {
      await sleep(1000, 1000)
      continue
    }

    // Isolated context → isolated localStorage per journey
    const context = await browser.createBrowserContext()
    const page    = await context.newPage()
    page.setDefaultNavigationTimeout(30000)
    try {
      await runFunnelJourney(page, workerId)
    } catch (err) {
      console.error(`[funnel-${workerId}] error: ${err.message}`)
    } finally {
      await context.close().catch(() => {})
    }

    await sleep(FUNNEL_DELAY.min, FUNNEL_DELAY.max)
  }
}

// ---------------------------------------------------------------------------
// Main loop — dashboard flows 1-9 (click Send buttons)
// ---------------------------------------------------------------------------
async function main() {
  console.log(`[traffic] starting — BASE_URL=${BASE_URL}`)

  const browser = await launchBrowser()
  console.log('[traffic] browser launched')

  // Start concurrent funnel workers (fire and forget — they run forever)
  for (let i = 1; i <= FUNNEL_CONCURRENCY; i++) {
    runFunnelLoop(browser, i).catch((err) =>
      console.error(`[funnel-${i}] fatal: ${err.message}`)
    )
  }

  // Main loop: dashboard flows 1-9
  while (true) {
    if (!isRunning) {
      await sleep(1000, 1000)
      continue
    }

    const flowNum = Math.floor(Math.random() * 9) + 1  // 1-9

    try {
      const page = await browser.newPage()
      page.setDefaultNavigationTimeout(30000)
      try {
        await runDashboardFlow(page, flowNum)
      } finally {
        await page.close().catch(() => {})
      }
    } catch (err) {
      console.error(`[traffic] error during flow-${flowNum}: ${err.message}`)
    }

    await sleep(LOOP_DELAY.min, LOOP_DELAY.max)
  }
}

main().catch((err) => {
  console.error('[traffic] fatal:', err)
  process.exit(1)
})
