'use client';

import dynamic from 'next/dynamic';

const BarbellTracker = dynamic(
  () => import('@/components/BarbellTracker'),
  {
    ssr: false,
    loading: () => (
      <div className="flex items-center justify-center min-h-screen bg-slate-950 text-white">
        Loading tracker...
      </div>
    ),
  }
);

export default function Home() {
  return <BarbellTracker />;
}