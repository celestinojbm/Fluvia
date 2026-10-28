import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import * as React from 'react';
import { cn } from '@/lib/utils';

const buttonVariants = cva(
  'inline-flex shrink-0 items-center justify-center gap-3 rounded-full text-xl font-extrabold whitespace-nowrap transition-colors disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-6',
  {
    variants: {
      variant: {
        default: 'bg-[var(--fl-black)] text-[var(--fl-mint)] hover:bg-[var(--fl-black-hover)]',
        outline:
          'border-2 border-[var(--fl-black)] bg-transparent text-[var(--fl-black)] hover:bg-[var(--fl-black)] hover:text-[var(--fl-mint)]',
      },
      size: {
        default: 'h-16 px-8',
        lg: 'h-16 px-9',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  }
);

export function Button({
  className,
  variant,
  size,
  asChild = false,
  ...props
}: React.ComponentProps<'button'> &
  VariantProps<typeof buttonVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot : 'button';
  return <Comp className={cn(buttonVariants({ variant, size }), className)} {...props} />;
}
