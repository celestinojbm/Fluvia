import {
  ArrowDownToLine,
  ArrowRight,
  ArrowUpFromLine,
  Ban,
  Banknote,
  CalendarDays,
  Check,
  CircleHelp,
  Clock,
  CreditCard,
  Eye,
  Flag,
  House,
  Layers,
  List,
  Lock,
  Minus,
  Package,
  Plus,
  Printer,
  Receipt,
  RefreshCw,
  Search,
  Send,
  Settings,
  ShieldCheck,
  ShoppingCart,
  Store,
  Tag,
  Trash2,
  TrendingUp,
  TriangleAlert,
  Truck,
  Undo2,
  User,
  Users,
  UsersRound,
  Wallet,
  Wrench,
  type LucideIcon,
} from 'lucide-react';

/**
 * Iconos de la plataforma: Lucide (ISC), trazo 2 sobre 24×24, `currentColor`,
 * siempre decorativos (`aria-hidden`): el texto que los acompaña da el
 * significado. Un único sistema de iconos para todo el panel.
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

const ICONS: Record<IconName, LucideIcon> = {
  home: House,
  cart: ShoppingCart,
  terminal: Store,
  receipt: Receipt,
  box: Package,
  users: Users,
  cash: Banknote,
  calendar: CalendarDays,
  card: CreditCard,
  undo: Undo2,
  team: UsersRound,
  gear: Settings,
  tools: Wrench,
  search: Search,
  plus: Plus,
  minus: Minus,
  trash: Trash2,
  check: Check,
  alert: TriangleAlert,
  clock: Clock,
  ban: Ban,
  'arrow-right': ArrowRight,
  trend: TrendingUp,
  tag: Tag,
  layers: Layers,
  printer: Printer,
  in: ArrowDownToLine,
  out: ArrowUpFromLine,
  shield: ShieldCheck,
  lock: Lock,
  wallet: Wallet,
  user: User,
  help: CircleHelp,
  eye: Eye,
  refresh: RefreshCw,
  flag: Flag,
  list: List,
  send: Send,
  truck: Truck,
};

export function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  const Glyph = ICONS[name];
  return <Glyph size={size} strokeWidth={2} aria-hidden="true" focusable="false" />;
}
