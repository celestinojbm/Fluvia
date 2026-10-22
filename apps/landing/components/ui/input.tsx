import * as React from 'react';
import { cn } from '@/lib/utils';

export function Input({ className, type, ...props }: React.ComponentProps<'input'>) {
  return (
    <input
      type={type}
      className={cn(
        'flex h-12 w-full rounded-xl border-[1.5px] border-[var(--fl-ink-2)] bg-[var(--fl-white)] px-3 text-base text-[var(--fl-black)] outline-none placeholder:text-[var(--fl-ink-2)]',
        className
      )}
      {...props}
    />
  );
}
