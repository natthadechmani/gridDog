import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'GridDog — Observability Sandbox',
  description: 'Mock observability testing dashboard for distributed services',
  themeColor: '#0F1117',
  viewport: 'width=device-width, initial-scale=1',
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en" className="dark">
      <head>
        <meta name="color-scheme" content="dark" />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
      </head>
      <body className="bg-background text-text-primary antialiased min-h-screen">
        {children}
      </body>
    </html>
  )
}
