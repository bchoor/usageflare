import {
  BrainCircuit,
  Container,
  Cpu,
  Database,
  Hammer,
  HardDrive,
  KeyRound,
  ListOrdered,
  type LucideIcon,
  Orbit,
  ScatterChart,
  Server,
  Workflow,
  Zap,
} from 'lucide-react';
import { CATEGORY, type CategoryId, PRODUCT, type ProductId } from '../shared/catalog';

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
};

export const CATEGORY_ICON: Record<CategoryId, LucideIcon> = {
  compute: Cpu,
  storage: Database,
  ai: BrainCircuit,
  messaging: ListOrdered,
};

/** A product's icon in its colour. */
export function ProductIcon({ id, className = 'size-4 shrink-0' }: { id: ProductId; className?: string }) {
  const Icon = PRODUCT_ICON[id];
  return <Icon className={className} style={{ color: PRODUCT[id].color }} aria-hidden />;
}

export function CategoryIcon({ id, className = 'size-4 shrink-0' }: { id: CategoryId; className?: string }) {
  const Icon = CATEGORY_ICON[id];
  return <Icon className={className} style={{ color: CATEGORY[id].color }} aria-hidden />;
}
