import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Barbell Tracker',
  description: 'Real-time computer vision barbell velocity tracker',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}