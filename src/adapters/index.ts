import type { WorkerAdapter } from "./types";
import { OmpAdapter } from "./omp";

const REGISTRY: Record<string, () => WorkerAdapter> = {
  omp: () => new OmpAdapter(),
};

export function getAdapter(name = "omp"): WorkerAdapter {
  const make = REGISTRY[name];
  if (!make) throw new Error(`未知的 Worker 适配器：${name}（可用：${Object.keys(REGISTRY).join(", ")}）`);
  return make();
}

export type { AdapterInput, ParsedLine, WorkerAdapter } from "./types";
export { buildPrompt } from "./omp";
