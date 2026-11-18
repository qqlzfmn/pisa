import type { WorkerAdapter } from "./types";
import { OmpAdapter } from "./omp";

const REGISTRY: Record<string, () => WorkerAdapter> = {
  omp: () => new OmpAdapter(),
};

/** 已登记的适配器名；docs/extending.md 的适配器表与 docs 测试都以此为准 */
export const ADAPTERS: readonly string[] = Object.keys(REGISTRY);

export function getAdapter(name = "omp"): WorkerAdapter {
  const make = REGISTRY[name];
  if (!make) throw new Error(`未知的 Worker 适配器：${name}（可用：${ADAPTERS.join(", ")}）`);
  return make();
}

export type { AdapterInput, ParsedLine, WorkerAdapter } from "./types";
export { buildPrompt } from "./omp";
