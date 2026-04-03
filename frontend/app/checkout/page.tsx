'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { SHOP_ITEMS, BACKEND_URL, Cart, getCart, saveCart, calcTotal } from '../lib/shop'

type ShopItem = { id: string; name: string; price: number; icon: string }

export default function CheckoutPage() {
  const [cart, setCart] = useState<Cart>({})
  const [mounted, setMounted] = useState(false)
  const [items, setItems] = useState<ShopItem[]>(SHOP_ITEMS)
  const [promoCode, setPromoCode] = useState('')
  const [promoResult, setPromoResult] = useState<{ valid: boolean; discount?: number; code?: string } | null>(null)
  const [promoLoading, setPromoLoading] = useState(false)
  const [checkoutResult, setCheckoutResult] = useState<{ error: string } | null>(null)
  const [checkoutLoading, setCheckoutLoading] = useState(false)

  useEffect(() => {
    setCart(getCart())
    setMounted(true)
    fetch(`${BACKEND_URL}/api/shop/items`)
      .then((r) => r.json())
      .then((data) => { if (Array.isArray(data) && data.length > 0) setItems(data) })
      .catch(() => {})
  }, [])

  const subtotal = mounted ? calcTotal(cart, items) : 0
  const discount = promoResult?.valid && promoResult.discount ? promoResult.discount : 0
  const total = subtotal * (1 - discount / 100)

  const cartItems = mounted
    ? Object.entries(cart).map(([id, qty]) => ({ item: items.find((i) => i.id === id)!, qty })).filter((e) => e.item)
    : []

  const applyPromo = async () => {
    const code = promoCode.trim()
    if (!code) return
    setPromoLoading(true)
    setPromoResult(null)
    try {
      const res = await fetch(`${BACKEND_URL}/api/flow/10/promo/${encodeURIComponent(code)}`, { cache: 'no-store' })
      const data = await res.json().catch(() => null)
      if (res.ok && data?.valid === true) {
        setPromoResult({ valid: true, discount: data.discount_percent, code: data.code })
      } else {
        setPromoResult({ valid: false })
      }
    } catch {
      setPromoResult({ valid: false })
    } finally {
      setPromoLoading(false)
    }
  }

  const placeOrder = async () => {
    setCheckoutLoading(true)
    setCheckoutResult(null)
    try {
      const res = await fetch(`${BACKEND_URL}/api/flow/10/checkout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        cache: 'no-store',
      })
      const data = await res.json().catch(() => null)
      // Always 500 — clear the cart anyway so the trace shows the full flow
      saveCart({})
      setCart({})
      setCheckoutResult({ error: data?.message || 'Payment gateway unavailable — simulated failure' })
    } catch (err) {
      setCheckoutResult({ error: err instanceof Error ? err.message : 'Request failed' })
    } finally {
      setCheckoutLoading(false)
    }
  }

  if (!mounted) return null

  return (
    <div className="min-h-screen" style={{ background: '#0F1117' }}>
      {/* Header */}
      <header
        className="sticky top-0 z-10 flex items-center gap-4 px-6 py-4 border-b"
        style={{ background: '#1A1D27', borderColor: '#2A2D3A' }}
      >
        <Link href="/cart" className="text-sm" style={{ color: '#8B8FA8' }}>
          ← Cart
        </Link>
        <span className="font-semibold" style={{ color: '#E8E9F0' }}>
          Checkout
        </span>
      </header>

      <main className="max-w-2xl mx-auto px-6 py-10 flex flex-col gap-6">
        {/* Order summary */}
        <div className="rounded-xl border" style={{ background: '#1A1D27', borderColor: '#2A2D3A' }}>
          <div className="px-5 py-3 border-b" style={{ borderColor: '#2A2D3A' }}>
            <p className="text-xs font-semibold uppercase tracking-wider" style={{ color: '#8B8FA8' }}>
              Order Summary
            </p>
          </div>
          <div className="px-5 py-4 flex flex-col gap-2">
            {cartItems.length === 0 ? (
              <p className="text-sm" style={{ color: '#8B8FA8' }}>
                Cart is empty.{' '}
                <Link href="/shop" style={{ color: '#9D78FF' }}>Back to shop</Link>
              </p>
            ) : (
              <>
                {cartItems.map(({ item, qty }) => (
                  <div key={item.id} className="flex justify-between text-sm">
                    <span style={{ color: '#E8E9F0' }}>
                      {item.icon} {item.name} × {qty}
                    </span>
                    <span style={{ color: '#8B8FA8' }}>${(item.price * qty).toFixed(2)}</span>
                  </div>
                ))}
                <div className="border-t pt-3 mt-1 flex flex-col gap-1" style={{ borderColor: '#2A2D3A' }}>
                  <div className="flex justify-between text-sm">
                    <span style={{ color: '#8B8FA8' }}>Subtotal</span>
                    <span style={{ color: '#E8E9F0' }}>${subtotal.toFixed(2)}</span>
                  </div>
                  {discount > 0 && (
                    <div className="flex justify-between text-sm">
                      <span style={{ color: '#00C389' }}>Promo ({promoResult?.code}) −{discount}%</span>
                      <span style={{ color: '#00C389' }}>−${(subtotal - total).toFixed(2)}</span>
                    </div>
                  )}
                  <div className="flex justify-between font-semibold text-base mt-1">
                    <span style={{ color: '#E8E9F0' }}>Total</span>
                    <span style={{ color: '#FFAA00' }}>${total.toFixed(2)}</span>
                  </div>
                </div>
              </>
            )}
          </div>
        </div>

        {/* Promo code */}
        <div className="rounded-xl border" style={{ background: '#1A1D27', borderColor: '#2A2D3A' }}>
          <div className="px-5 py-3 border-b" style={{ borderColor: '#2A2D3A' }}>
            <p className="text-xs font-semibold uppercase tracking-wider" style={{ color: '#8B8FA8' }}>
              Promo Code
            </p>
            <p className="text-xs mt-0.5" style={{ color: '#8B8FA8' }}>
              nginx → Go → Java GET /promo/verify/:code → Postgres promo_codes
            </p>
          </div>
          <div className="px-5 py-4">
            <div className="flex gap-2">
              <input
                type="text"
                placeholder="e.g. 10OFF"
                value={promoCode}
                onChange={(e) => { setPromoCode(e.target.value.toUpperCase()); setPromoResult(null) }}
                onKeyDown={(e) => { if (e.key === 'Enter') applyPromo() }}
                className="flex-1 rounded-lg px-3 py-2 text-sm outline-none border"
                style={{ background: '#0F1117', borderColor: '#2A2D3A', color: '#E8E9F0' }}
              />
              <button
                onClick={applyPromo}
                disabled={promoLoading || !promoCode.trim()}
                className="px-4 py-2 rounded-lg text-sm font-medium"
                style={{
                  background: promoLoading ? '#2A2D3A' : '#7B4FFF',
                  color: '#fff',
                  opacity: !promoCode.trim() ? 0.5 : 1,
                }}
              >
                {promoLoading ? '...' : 'Apply'}
              </button>
            </div>
            {promoResult?.valid === true && (
              <p className="text-xs mt-2" style={{ color: '#00C389' }}>
                ✓ Code applied — {promoResult.discount}% off
              </p>
            )}
            {promoResult?.valid === false && (
              <p className="text-xs mt-2" style={{ color: '#FF4B4B' }}>
                ✕ Invalid or inactive promo code
              </p>
            )}
          </div>
        </div>

        {/* Checkout error */}
        {checkoutResult && (
          <div
            className="rounded-xl border px-5 py-4"
            style={{ borderColor: '#FF4B4B44', background: '#FF4B4B11' }}
          >
            <p className="text-sm font-semibold mb-1" style={{ color: '#FF4B4B' }}>
              500 — Checkout Failed
            </p>
            <p className="text-xs" style={{ color: '#FF4B4B' }}>
              {checkoutResult.error}
            </p>
            <p className="text-xs mt-2" style={{ color: '#8B8FA8' }}>
              This is an intentional simulated failure — useful for distributed tracing.
            </p>
          </div>
        )}

        {/* Actions */}
        <div className="flex flex-col gap-2">
          <p className="text-xs text-right" style={{ color: '#8B8FA8' }}>
            nginx → Go POST /api/flow/10/checkout → intentional 500
          </p>
          <div className="flex items-center justify-between">
            <Link
              href="/cart"
              className="text-sm px-4 py-2 rounded-lg"
              style={{ background: '#2A2D3A', color: '#8B8FA8' }}
            >
              ← Back to Cart
            </Link>
            <button
              onClick={placeOrder}
              disabled={checkoutLoading || cartItems.length === 0}
              className="text-sm px-5 py-2.5 rounded-lg font-medium"
              style={{
                background: checkoutLoading ? '#2A2D3A' : '#FF4B4B',
                color: '#fff',
                opacity: cartItems.length === 0 ? 0.5 : 1,
              }}
            >
              {checkoutLoading ? 'Processing...' : 'Place Order 💳'}
            </button>
          </div>
        </div>
      </main>
    </div>
  )
}
