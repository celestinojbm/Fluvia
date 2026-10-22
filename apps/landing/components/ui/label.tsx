import * as React from 'react';
import { cn } from '@/lib/utils';

export function Label({ className, ...props }: React.ComponentProps<'label'>) {
  return (
    <label
      className={cn(
        'text-xs font-extrabold tracking-[0.1em] text-[var(--fl-ink-2)] uppercase',
        className
      )}
      {...props}
    />
  );
}
