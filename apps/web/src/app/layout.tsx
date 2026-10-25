import type { ReactNode } from 'react';
import { GeistMono } from 'geist/font/mono';
import { GeistSans } from 'geist/font/sans';
import './globals.css';

export const metadata = { title: 'UK Accounting Platform', description: 'Accounting, tax and compliance for practices and businesses' };

/** UI-1 (DEC-076): Geist and Geist Mono are bundled with the app (the `geist` package); no font is fetched from a third party. */
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en-GB" className={`${GeistSans.variable} ${GeistMono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
