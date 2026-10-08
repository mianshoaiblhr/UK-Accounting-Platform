import type { ReactNode } from 'react';
import './globals.css';

export const metadata = { title: 'UK Accounting Platform', description: 'Accounting, tax and compliance for practices and businesses' };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en-GB">
      <body>{children}</body>
    </html>
  );
}
