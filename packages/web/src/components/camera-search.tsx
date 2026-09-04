'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { useState } from 'react';

/** Global camera search. Navigates the registry rather than holding its own result list. */
export function CameraSearch() {
  const router = useRouter();
  const params = useSearchParams();
  const [value, setValue] = useState(params.get('q') ?? '');

  return (
    <form
      role="search"
      className="w-full max-w-md"
      onSubmit={(event) => {
        event.preventDefault();
        const trimmed = value.trim();
        router.push(trimmed === '' ? '/registry' : `/registry?q=${encodeURIComponent(trimmed)}`);
      }}
    >
      <label htmlFor="camera-search" className="sr-only">
        Search cameras by id, name or district
      </label>
      <input
        id="camera-search"
        type="search"
        value={value}
        onChange={(event) => {
          setValue(event.target.value);
        }}
        placeholder="Search cameras — cam01, Paldi, Ahmedabad"
        className="w-full rounded-md border border-slate-700 bg-slate-900 px-3 py-1.5 text-sm text-slate-100 placeholder:text-slate-400 focus-visible:border-sky-500 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-sky-500"
      />
    </form>
  );
}
