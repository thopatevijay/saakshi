'use client';

import { ErrorState } from '@/src/components/states';

export default function GlobalError({ reset }: { error: Error; reset: () => void }) {
  return (
    <main className="flex min-h-dvh items-center justify-center px-6">
      <div className="w-full max-w-md">
        <ErrorState description="An unexpected error occurred." onRetry={reset} />
      </div>
    </main>
  );
}
