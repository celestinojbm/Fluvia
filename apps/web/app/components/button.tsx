import { Loader2 } from 'lucide-react';
import type { ReactNode } from 'react';

export type ButtonVariant = 'primary' | 'secondary' | 'mint' | 'destructive';

type Common = {
  variant?: ButtonVariant;
  /** Secundario sobre fondo negro: contorno blanco. */
  onDark?: boolean;
  busy?: boolean;
  icon?: ReactNode;
  children: ReactNode;
  className?: string;
};

type ButtonProps = Common &
  Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'children'> & { href?: undefined };

type LinkProps = Common &
  Omit<React.AnchorHTMLAttributes<HTMLAnchorElement>, 'children'> & { href: string };

function classNames(variant: ButtonVariant, onDark: boolean, extra?: string, busy?: boolean) {
  return ['btn', `btn-${variant}`, onDark ? 'on-dark' : '', busy ? 'is-busy' : '', extra ?? '']
    .filter(Boolean)
    .join(' ');
}

function Inner({
  busy,
  reserve,
  icon,
  children,
}: Pick<Common, 'busy' | 'icon' | 'children'> & { reserve: boolean }) {
  return (
    <>
      {busy ? <Loader2 className="spin" size={16} strokeWidth={1.75} aria-hidden="true" /> : icon}
      <span className="btn-label">
        <span className="rest" aria-hidden={busy ? true : undefined}>
          {children}
        </span>
        {reserve ? (
          <span className="busy-text" aria-hidden={busy ? undefined : true}>
            Procesando
          </span>
        ) : null}
      </span>
    </>
  );
}

export function Button(props: ButtonProps | LinkProps) {
  const variant = props.variant ?? 'primary';
  const onDark = props.onDark ?? false;
  const busy = Boolean(props.busy);
  const cls = classNames(variant, onDark, props.className, busy);
  if ('href' in props && props.href && !busy) {
    return (
      <a href={props.href} className={cls} onClick={props.onClick} id={props.id}>
        <Inner busy={false} reserve={false} icon={props.icon}>
          {props.children}
        </Inner>
      </a>
    );
  }

  const button = props as ButtonProps;
  return (
    <button
      type={button.type ?? 'button'}
      className={cls}
      disabled={button.disabled}
      aria-busy={busy || undefined}
      aria-disabled={busy || undefined}
      onClick={busy ? undefined : button.onClick}
      id={button.id}
    >
      <Inner busy={busy} reserve icon={props.icon}>
        {props.children}
      </Inner>
    </button>
  );
}
