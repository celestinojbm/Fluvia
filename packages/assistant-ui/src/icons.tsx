import {
  ArrowRight,
  Camera,
  Image,
  List,
  Mic,
  MicOff,
  MonitorUp,
  Phone,
  PhoneOff,
  Plus,
  RotateCcw,
  Send,
  Sparkles,
  Square,
  Trash2,
  Volume2,
  X,
  type LucideIcon,
} from 'lucide-react';

/**
 * Iconos del asistente (Lucide, ISC), decorativos (`aria-hidden`): el texto
 * que los acompaña da el significado. Mismos nombres que en el panel.
 */
const MAP = {
  ai: Sparkles,
  'arrow-right': ArrowRight,
  camera: Camera,
  close: X,
  image: Image,
  list: List,
  mic: Mic,
  'mic-off': MicOff,
  phone: Phone,
  'phone-off': PhoneOff,
  plus: Plus,
  retry: RotateCcw,
  screen: MonitorUp,
  send: Send,
  stop: Square,
  trash: Trash2,
  volume: Volume2,
} satisfies Record<string, LucideIcon>;

export type AssistantIconName = keyof typeof MAP;

export function Icon({ name, size = 18 }: { name: AssistantIconName; size?: number }) {
  const C = MAP[name];
  return <C size={size} strokeWidth={2} aria-hidden="true" focusable="false" />;
}
