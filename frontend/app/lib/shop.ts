// Empty default → browser uses the page's origin (relative URLs).
// Works behind a same-origin reverse proxy like nginx, which is how
// docker-compose, the VM stack, and EKS all serve frontend + /api/* together.
// For local `npm run dev` against a separately-running backend, set
// NEXT_PUBLIC_BACKEND_URL=http://localhost:8080 in frontend/.env.local
export const BACKEND_URL = process.env.NEXT_PUBLIC_BACKEND_URL || ''

export const SHOP_ITEMS = [
  { id: 'tshirt',   name: 'Datadog T-Shirt',  price: 29.99, icon: '👕' },
  { id: 'hoodie',   name: 'Datadog Hoodie',    price: 59.99, icon: '🧥' },
  { id: 'sticker',  name: 'Sticker Pack',      price:  9.99, icon: '🐶' },
  { id: 'plush',    name: 'Dog Plush Toy',      price: 19.99, icon: '🧸' },
  { id: 'mug',      name: 'Datadog Mug',        price: 14.99, icon: '☕' },
  { id: 'notebook', name: 'Datadog Notebook',   price: 12.99, icon: '📓' },
]

export type Cart = Record<string, number>

export function getCart(): Cart {
  if (typeof window === 'undefined') return {}
  try {
    return JSON.parse(localStorage.getItem('griddog_cart') || '{}')
  } catch {
    return {}
  }
}

export function saveCart(cart: Cart) {
  localStorage.setItem('griddog_cart', JSON.stringify(cart))
}

export function calcTotal(cart: Cart, itemList: typeof SHOP_ITEMS = SHOP_ITEMS): number {
  return Object.entries(cart).reduce((sum, [id, qty]) => {
    const item = itemList.find((i) => i.id === id)
    return sum + (item ? item.price * qty : 0)
  }, 0)
}

export function cartCount(cart: Cart): number {
  return Object.values(cart).reduce((a, b) => a + b, 0)
}
