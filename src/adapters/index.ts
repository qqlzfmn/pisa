import type { WorkerAdapter } from "./types";
import { OmpAdapter } from "./omp";
import { defaultPromptSet, type PromptSet } from "../prompts";

const REGISTRY: Record<string, (prompts: PromptSet) => WorkerAdapter> = {
  omp: (prompts) => new OmpAdapter(prompts),
};

export function getAdapter(name = "omp", prompts: PromptSet = defaultPromptSet()): WorkerAdapter {
  const make = REGISTRY[name];
  if (!make) throw new Error(`未知的 Worker 适配器：${name}（可用：${Object.keys(REGISTRY).join(", ")}）`);
  return make(prompts);
}

export type { AdapterInput, ParsedLine, WorkerAdapter } from "./types";
