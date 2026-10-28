import * as React from 'react';
import { cn } from '@/lib/utils';

export function Input({ className, type, ...props }: React.ComponentProps<'input'>) {
  return (
    <input
      type={type}
      className={cn(
        'flex h-14 w-full rounded-xl border-[1.5px] border-[var(--fl-ink-2)] bg-[var(--fl-white)] px-4 text-lg leading-normal text-[var(--fl-black)] outline-none placeholder:text-[var(--fl-ink-2)] md:h-16 md:text-xl',
        className
      )}
      {...props}
    />
  );
}
