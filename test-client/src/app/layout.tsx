import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'Stexio Test Client',
  description: 'Feature verification dashboard for the Stexio payment proxy',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body className="min-h-screen bg-gray-950 text-gray-100 antialiased">
        {children}
      </body>
    </html>
  )
}
