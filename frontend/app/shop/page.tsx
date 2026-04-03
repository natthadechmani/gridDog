'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { SHOP_ITEMS, BACKEND_URL, Cart, getCart, saveCart, cartCount } from '../lib/shop'

type ShopItem = { id: string; name: string; price: number; icon: string }

export default function ShopPage() {
  const [cart, setCart] = useState<Cart>({})
  const [mounted, setMounted] = useState(false)
  const [items, setItems] = useState<ShopItem[]>([])
  const [itemsLoading, setItemsLoading] = useState(true)

  useEffect(() => {
    setCart(getCart())
    setMounted(true)

    fetch(`${BACKEND_URL}/api/shop/items`)
      .then((r) => r.json())
      .then((data) => {
        if (Array.isArray(data) && data.length > 0) setItems(data)
        else setItems(SHOP_ITEMS)
      })
      .catch(() => setItems(SHOP_ITEMS))
      .finally(() => setItemsLoading(false))
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

  const count = mounted ? cartCount(cart) : 0

  return (
    <div className="min-h-screen" style={{ background: '#0F1117' }}>
      {/* Header */}
      <header
        className="sticky top-0 z-10 flex items-center justify-between px-6 py-4 border-b"
        style={{ background: '#1A1D27', borderColor: '#2A2D3A' }}
      >
        <div className="flex items-center gap-4">
          <Link
            href="/"
            className="text-sm flex items-center gap-1"
            style={{ color: '#8B8FA8' }}
          >
            ← Dashboard
          </Link>
          <div className="flex items-center gap-2">
            <span style={{ fontSize: 20 }}>🐶</span>
            <span className="font-semibold" style={{ color: '#E8E9F0' }}>
              Datadog Merch Store
            </span>
          </div>
        </div>
        <Link
          href="/cart"
          className="flex items-center gap-2 text-sm px-4 py-2 rounded-lg font-medium"
          style={{
            background: count > 0 ? '#7B4FFF' : '#2A2D3A',
            color: '#fff',
            opacity: count === 0 ? 0.5 : 1,
            pointerEvents: count === 0 ? 'none' : 'auto',
          }}
        >
          🛒{count > 0 && <span>{count}</span>} View Cart
        </Link>
      </header>

      {/* Product grid */}
      <main className="max-w-4xl mx-auto px-6 py-10">
        <p className="text-sm mb-1" style={{ color: '#8B8FA8' }}>
          6 items — add to cart then proceed to checkout to trace the full distributed flow.
        </p>
        <p className="text-xs mb-6" style={{ color: '#8B8FA8' }}>
          nginx → Go GET /api/shop/items → Express GET /shop/items → MongoDB shop_items
        </p>
        {itemsLoading ? (
          <p className="text-sm" style={{ color: '#8B8FA8' }}>Loading items…</p>
        ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-5">
          {items.map((item) => {
            const qty = cart[item.id] || 0
            return (
              <div
                key={item.id}
                className="rounded-xl border flex flex-col items-center gap-3 p-5 text-center"
                style={{ background: '#1A1D27', borderColor: '#2A2D3A' }}
              >
                <span style={{ fontSize: 44 }}>{item.icon}</span>
                <div>
                  <p className="text-sm font-medium" style={{ color: '#E8E9F0' }}>
                    {item.name}
                  </p>
                  <p className="text-sm mt-0.5" style={{ color: '#FFAA00' }}>
                    ${item.price.toFixed(2)}
                  </p>
                </div>
                {qty === 0 ? (
                  <button
                    onClick={() => updateCart(item.id, 1)}
                    className="w-full text-sm py-2 rounded-lg font-medium"
                    style={{ background: '#7B4FFF', color: '#fff' }}
                  >
                    Add to Cart
                  </button>
                ) : (
                  <div className="flex items-center gap-3">
                    <button
                      onClick={() => updateCart(item.id, -1)}
                      className="w-8 h-8 rounded-lg font-bold text-sm"
                      style={{ background: '#2A2D3A', color: '#E8E9F0' }}
                    >
                      −
                    </button>
                    <span className="text-sm w-4 text-center" style={{ color: '#E8E9F0' }}>
                      {qty}
                    </span>
                    <button
                      onClick={() => updateCart(item.id, 1)}
                      className="w-8 h-8 rounded-lg font-bold text-sm"
                      style={{ background: '#2A2D3A', color: '#E8E9F0' }}
                    >
                      +
                    </button>
                  </div>
                )}
              </div>
            )
          })}
        </div>
        )}
      </main>
    </div>
  )
}
