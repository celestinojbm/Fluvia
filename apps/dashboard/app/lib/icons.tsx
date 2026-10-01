/**
 * Iconos de la plataforma: trazo 1.8 sobre 24×24, `currentColor`, siempre
 * decorativos (`aria-hidden`): el texto que los acompaña da el significado.
 */

export type IconName =
  | 'home'
  | 'cart'
  | 'terminal'
  | 'receipt'
  | 'box'
  | 'users'
  | 'cash'
  | 'calendar'
  | 'card'
  | 'undo'
  | 'team'
  | 'gear'
  | 'tools'
  | 'search'
  | 'plus'
  | 'minus'
  | 'trash'
  | 'check'
  | 'alert'
  | 'clock'
  | 'ban'
  | 'arrow-right'
  | 'trend'
  | 'tag'
  | 'layers'
  | 'printer'
  | 'in'
  | 'out'
  | 'shield'
  | 'lock'
  | 'wallet'
  | 'user'
  | 'help'
  | 'eye'
  | 'refresh'
  | 'flag'
  | 'list'
  | 'send'
  | 'truck';

const PATHS: Record<IconName, string> = {
  home: 'M3 10.5 12 3l9 7.5V21h-6v-6H9v6H3z',
  cart: 'M3 4h2l2.4 11h11L21 7H6.2M9 20a1 1 0 1 0 0-2 1 1 0 0 0 0 2Zm9 0a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z',
  terminal: 'M5 3h14v18H5zM8 7h8M8 11h8M9 15h2m2 0h2M9 18h6',
  receipt: 'M6 3h12v18l-3-2-3 2-3-2-3 2zM9 8h6M9 12h6',
  box: 'M3 7.5 12 3l9 4.5v9L12 21l-9-4.5zM3 7.5 12 12l9-4.5M12 12v9',
  users:
    'M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm-7 10a7 7 0 0 1 14 0M17 3.5a4 4 0 0 1 0 7.5M22 21a7 7 0 0 0-4-6.3',
  cash: 'M2 6h20v12H2zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM6 9v6m12-6v6',
  calendar: 'M4 5h16v16H4zM4 9h16M8 3v4m8-4v4M8 13h2m4 0h2M8 17h2',
  card: 'M2 5h20v14H2zM2 10h20M6 15h4',
  undo: 'M9 14 4 9l5-5M4 9h11a5 5 0 0 1 0 10h-3',
  team: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm-8 9a8 8 0 0 1 16 0',
  gear: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm7.4-3a7.4 7.4 0 0 0-.1-1.3l2-1.6-2-3.4-2.4 1a7.5 7.5 0 0 0-2.2-1.3L14.4 2h-4l-.4 2.4a7.5 7.5 0 0 0-2.2 1.3l-2.4-1-2 3.4 2 1.6a7.4 7.4 0 0 0 0 2.6l-2 1.6 2 3.4 2.4-1a7.5 7.5 0 0 0 2.2 1.3l.4 2.4h4l.4-2.4a7.5 7.5 0 0 0 2.2-1.3l2.4 1 2-3.4-2-1.6c.1-.4.1-.9.1-1.3Z',
  tools: 'M14 6a4 4 0 0 0 5 5l-9 9a2 2 0 0 1-3-3l9-9a4 4 0 0 0-2-2Z',
  search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14Zm5-2 5 5',
  plus: 'M12 5v14M5 12h14',
  minus: 'M5 12h14',
  trash: 'M4 7h16M10 11v6m4-6v6M6 7l1 13h10l1-13M9 7V4h6v3',
  check: 'M5 12.5 10 17l9-10',
  alert: 'M12 3 2 20h20zM12 10v4m0 3v.5',
  clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Zm0-13v5l3 2',
  ban: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM5.6 5.6l12.8 12.8',
  'arrow-right': 'M5 12h14m-6-6 6 6-6 6',
  trend: 'M3 17l6-6 4 4 8-8M15 7h6v6',
  tag: 'M3 12V4h8l10 10-8 8zM7.5 8.5h.01',
  layers: 'M12 3 2 8l10 5 10-5zM2 13l10 5 10-5',
  printer: 'M6 9V3h12v6M6 17H3v-8h18v8h-3M6 14h12v7H6z',
  in: 'M12 3v12m-5-5 5 5 5-5M4 21h16',
  out: 'M12 15V3m-5 5 5-5 5 5M4 21h16',
  shield: 'M12 3 4 6v6c0 4.5 3.4 8.2 8 9 4.6-.8 8-4.5 8-9V6zM9 12l2 2 4-4',
  lock: 'M6 11h12v10H6zM8 11V7a4 4 0 0 1 8 0v4M12 15v2',
  wallet: 'M3 7h16a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H3zM3 7l12-3v3M16 13.5h.01',
  user: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm-7 9a7 7 0 0 1 14 0',
  help: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Zm-2.5-11.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6V14m0 3v.5',
  eye: 'M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Zm10 3a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z',
  refresh: 'M20 11a8 8 0 0 0-14.6-4.5L3 9m0-5v5h5m-4 4a8 8 0 0 0 14.6 4.5L21 15m0 5v-5h-5',
  flag: 'M5 21V4h11l-2 4 2 4H5',
  list: 'M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01',
  send: 'M21 3 3 10l7 3 3 7zM10 13l11-10',
  truck:
    'M2 6h11v10H2zM13 10h5l3 3v3h-8M6 19a2 2 0 1 0 0-4 2 2 0 0 0 0 4Zm11 0a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z',
};

export function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
