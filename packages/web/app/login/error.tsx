'use client';

import { ErrorState } from '@/src/components/states';

export default function LoginError({ reset }: { error: Error; reset: () => void }) {
  return (
    <main className="flex min-h-dvh items-center justify-center px-6">
      <div className="w-full max-w-sm">
        <ErrorState
          title="Sign in is unavailable"
          description="The API did not respond. Check that it is running, then try again."
          onRetry={reset}
        />
      </div>
    </main>
  );
}
