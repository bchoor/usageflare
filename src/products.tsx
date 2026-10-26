import { iconOf } from '@columenlabs/lumen-ui';
import {
  Activity,
  Archive,
  ArrowLeftRight,
  BookOpen,
  BrainCircuit,
  Container,
  Cpu,
  Database,
  Hammer,
  HardDrive,
  KeyRound,
  ListOrdered,
  type LucideIcon,
  MemoryStick,
  Orbit,
  PenLine,
  ScatterChart,
  Search,
  Server,
  Sparkles,
  Table2,
  Workflow,
  Zap,
} from 'lucide-react';
import {
  CATEGORY,
  type CategoryId,
  type FamilyId,
  type Metric,
  PRODUCT,
  type ProductId,
} from '../shared/catalog';

export const PRODUCT_ICON: Record<ProductId, LucideIcon> = {
  workers: Server,
  workflows: Workflow,
  containers: Container,
  do: Orbit,
  builds: Hammer,
  kv: KeyRound,
  d1: Database,
  r2: HardDrive,
  hyperdrive: Zap,
  ai: BrainCircuit,
  vectorize: ScatterChart,
  queues: ListOrdered,
  basin: Table2,
};

export const CATEGORY_ICON: Record<CategoryId, LucideIcon> = {
  compute: Cpu,
  storage: Database,
  ai: BrainCircuit,
  messaging: ListOrdered,
};

/** A meter's default icon, by its family, so one product's meters look apart (R2 Storage vs ops). */
export const FAMILY_ICON: Record<FamilyId, LucideIcon> = {
  req: ArrowLeftRight,
  q: Search,
  ops: Activity,
  units: Sparkles,
  cpu: Cpu,
  mem: MemoryStick,
  read: BookOpen,
  write: PenLine,
  stor: Archive,
};

/** A meter's icon in its product's colour: the person's pick (`icons`, by metric key), else its family's. */
export function MeterIcon({
  metric,
  icons,
  className = 'size-4 shrink-0',
}: {
  metric: Metric;
  icons?: Record<string, string>;
  className?: string;
}) {
  const Icon = iconOf(icons?.[metric.key], FAMILY_ICON[metric.family]);
  return (
    <span className="inline-flex shrink-0" style={{ color: PRODUCT[metric.product].color }} aria-hidden>
      <Icon className={className} />
    </span>
  );
}

/** A product's icon in its colour. */
export function ProductIcon({ id, className = 'size-4 shrink-0' }: { id: ProductId; className?: string }) {
  const Icon = PRODUCT_ICON[id];
  return <Icon className={className} style={{ color: PRODUCT[id].color }} aria-hidden />;
}

export function CategoryIcon({ id, className = 'size-4 shrink-0' }: { id: CategoryId; className?: string }) {
  const Icon = CATEGORY_ICON[id];
  return <Icon className={className} style={{ color: CATEGORY[id].color }} aria-hidden />;
}
