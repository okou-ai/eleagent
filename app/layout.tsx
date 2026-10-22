import type { Metadata, Viewport } from 'next';
import './login.css';

export const metadata: Metadata = { title: 'Eleagent', icons: { icon: '/capture/icon.svg' } };
export const viewport: Viewport = { themeColor: '#000000', width: 'device-width', initialScale: 1 };

export default function RootLayout({ children }: LayoutProps<'/'>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
