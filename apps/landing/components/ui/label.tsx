import * as React from 'react';
import { cn } from '@/lib/utils';

export function Label({ className, ...props }: React.ComponentProps<'label'>) {
  return (
    <label
      className={cn(
        'text-lg leading-snug font-extrabold tracking-[0.06em] text-[var(--fl-ink-2)] uppercase md:text-xl',
        className
      )}
      {...props}
    />
  );
}
