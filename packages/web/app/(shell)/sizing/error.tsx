'use client';

import { ErrorState } from '@/src/components/states';

export default function RouteError({ reset }: { error: Error; reset: () => void }) {
  return (
    <ErrorState
      description="This screen could not be loaded. The API may be unreachable or your session may have expired."
      onRetry={reset}
    />
  );
}
