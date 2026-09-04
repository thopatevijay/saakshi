import { Spinner } from '@/src/components/states';

export default function Loading() {
  return (
    <main className="flex min-h-dvh items-center justify-center">
      <Spinner label="Loading sign in" />
    </main>
  );
}
