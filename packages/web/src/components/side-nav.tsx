'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { navFor, type UserRole } from '@saakshi/shared';

/**
 * The left nav, rendered from the **shared capability matrix**.
 *
 * A role never sees a destination it cannot use — but that is a courtesy, not a boundary: the
 * middleware refuses the direct URL and the API refuses the data. Three layers, one matrix.
 */
export function SideNav({ role }: { role: UserRole }) {
  const pathname = usePathname();
  const items = navFor(role);

  return (
    <nav
      aria-label="Main"
      className="flex flex-col border-r border-slate-800 bg-slate-900/60 px-4 py-5"
    >
      <Link
        href="/registry"
        className="mb-6 block rounded-md px-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400"
      >
        <span className="block text-[0.6rem] uppercase tracking-[0.25em] text-slate-400">
          साक्षी
        </span>
        <span className="block text-lg font-semibold text-slate-100">SAAKSHI</span>
      </Link>

      <ul className="space-y-1">
        {items.map((item) => {
          const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
          return (
            <li key={item.href}>
              <Link
                href={item.href}
                aria-current={active ? 'page' : undefined}
                className={`block rounded-md px-3 py-2 text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400 ${
                  active
                    ? 'bg-sky-950/60 text-sky-200'
                    : 'text-slate-300 hover:bg-slate-800 hover:text-slate-100'
                }`}
              >
                {item.label}
              </Link>
            </li>
          );
        })}
      </ul>

      <p className="mt-auto px-3 pt-6 text-xs text-slate-400">
        Signed in as <span className="uppercase tracking-wide">{role}</span>
      </p>
    </nav>
  );
}
