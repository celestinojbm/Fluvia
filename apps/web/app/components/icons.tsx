import {
  ArrowRight,
  BookOpen,
  Check,
  CircleAlert,
  Copy,
  Info,
  KeyRound,
  Landmark,
  Link2,
  Lock,
  Menu,
  Minus,
  Plus,
  ReceiptText,
  RefreshCcw,
  Scale,
  ScrollText,
  ShieldCheck,
  Smartphone,
  Store,
  Webhook,
  X,
  type LucideIcon,
} from 'lucide-react';

/** Lucide, trazo 1,75 fijo, currentColor. Decorativos: el texto lleva el significado. */
const ICONS = {
  smartphone: Smartphone,
  book: BookOpen,
  landmark: Landmark,
  shield: ShieldCheck,
  key: KeyRound,
  refresh: RefreshCcw,
  receipt: ReceiptText,
  scale: Scale,
  link: Link2,
  webhook: Webhook,
  store: Store,
  lock: Lock,
  scroll: ScrollText,
  info: Info,
  alert: CircleAlert,
  copy: Copy,
  check: Check,
  arrow: ArrowRight,
  menu: Menu,
  close: X,
  plus: Plus,
  minus: Minus,
} as const;

export type IconName = keyof typeof ICONS;

export function Icon({ name, size = 20 }: { name: IconName; size?: 16 | 20 | 24 }) {
  const Glyph: LucideIcon = ICONS[name];
  return <Glyph size={size} strokeWidth={1.75} aria-hidden="true" focusable="false" />;
}
