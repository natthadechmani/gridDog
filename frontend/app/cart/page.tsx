'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { SHOP_ITEMS, BACKEND_URL, Cart, getCart, saveCart, calcTotal } from '../lib/shop'

type ShopItem = { id: string; name: string; price: number; icon: string }

export default function CartPage() {
  const [cart, setCart] = useState<Cart>({})
  const [mounted, setMounted] = useState(false)
  const [items, setItems] = useState<ShopItem[]>(SHOP_ITEMS)

  useEffect(() => {
    setCart(getCart())
    setMounted(true)
    fetch(`${BACKEND_URL}/api/shop/items`)
      .then((r) => r.json())
      .then((data) => { if (Array.isArray(data) && data.length > 0) setItems(data) })
      .catch(() => {})
  }, [])

  const updateCart = (id: string, delta: number) => {
    setCart((prev) => {
      const next = { ...prev }
      const qty = (next[id] || 0) + delta
      if (qty <= 0) delete next[id]
      else next[id] = qty
      saveCart(next)
      return next
    })
  }

  const cartItems = mounted
    ? Object.entries(cart).map(([id, qty]) => ({ item: items.find((i) => i.id === id)!, qty })).filter((e) => e.item)
    : []

  const total = mounted ? calcTotal(cart, items) : 0
  const isEmpty = cartItems.length === 0

  return (
    <div className="min-h-screen" style={{ background: '#0F1117' }}>
      {/* Header */}
      <header
        className="sticky top-0 z-10 flex items-center gap-4 px-6 py-4 border-b"
        style={{ background: '#1A1D27', borderColor: '#2A2D3A' }}
      >
        <Link href="/shop" className="text-sm" style={{ color: '#8B8FA8' }}>
          ← Shop
        </Link>
        <span className="font-semibold" style={{ color: '#E8E9F0' }}>
          Your Cart
        </span>
      </header>

      <main className="max-w-2xl mx-auto px-6 py-10">
        {isEmpty ? (
          <div className="text-center py-20">
            <p className="text-4xl mb-4">🛒</p>
            <p className="mb-6" style={{ color: '#8B8FA8' }}>Your cart is empty.</p>
            <Link
              href="/shop"
              className="text-sm px-5 py-2.5 rounded-lg font-medium"
              style={{ background: '#7B4FFF', color: '#fff' }}
            >
              Browse the Shop
            </Link>
          </div>
        ) : (
          <>
            <div className="flex flex-col gap-3 mb-6">
              {cartItems.map(({ item, qty }) => (
                <div
                  key={item.id}
                  className="flex items-center justify-between rounded-xl border px-5 py-4"
                  style={{ background: '#1A1D27', borderColor: '#2A2D3A' }}
                >
                  <div className="flex items-center gap-4">
                    <span style={{ fontSize: 28 }}>{item.icon}</span>
                    <div>
                      <p className="text-sm font-medium" style={{ color: '#E8E9F0' }}>
                        {item.name}
                      </p>
                      <p className="text-xs mt-0.5" style={{ color: '#8B8FA8' }}>
                        ${item.price.toFixed(2)} each
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-4">
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => updateCart(item.id, -1)}
                        className="w-7 h-7 rounded text-sm font-bold"
                        style={{ background: '#2A2D3A', color: '#E8E9F0' }}
                      >
                        −
                      </button>
                      <span className="text-sm w-4 text-center" style={{ color: '#E8E9F0' }}>
                        {qty}
                      </span>
                      <button
                        onClick={() => updateCart(item.id, 1)}
                        className="w-7 h-7 rounded text-sm font-bold"
                        style={{ background: '#2A2D3A', color: '#E8E9F0' }}
                      >
                        +
                      </button>
                    </div>
                    <span className="text-sm w-16 text-right" style={{ color: '#FFAA00' }}>
                      ${(item.price * qty).toFixed(2)}
                    </span>
                  </div>
                </div>
              ))}
            </div>

            {/* Subtotal */}
            <div
              className="flex justify-between items-center rounded-xl border px-5 py-4 mb-8"
              style={{ background: '#1A1D27', borderColor: '#2A2D3A' }}
            >
              <span className="font-medium" style={{ color: '#8B8FA8' }}>Subtotal</span>
              <span className="font-semibold text-lg" style={{ color: '#E8E9F0' }}>
                ${total.toFixed(2)}
              </span>
            </div>

            {/* Actions */}
            <div className="flex items-center justify-between">
              <Link
                href="/shop"
                className="text-sm px-4 py-2 rounded-lg"
                style={{ background: '#2A2D3A', color: '#8B8FA8' }}
              >
                ← Continue Shopping
              </Link>
              <Link
                href="/checkout"
                className="text-sm px-5 py-2.5 rounded-lg font-medium"
                style={{ background: '#7B4FFF', color: '#fff' }}
              >
                Proceed to Checkout →
              </Link>
            </div>
          </>
        )}
      </main>
    </div>
  )
}
