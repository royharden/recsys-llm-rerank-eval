import type { RawFiles } from '../../core/data/movielens.ts';
import type { Dataset, ValidationReport } from '../../core/data/types.ts';
import type { FormatChaosMode } from '../../core/data/synthetic.ts';
import type { Manifest } from '../../core/split/manifest.ts';
import type { FrozenConfig, Prereg } from '../../core/prereg/schema.ts';
import type { DryRun } from '../../core/budget/estimate.ts';
import type { DevTuning } from '../../core/arms/tuning.ts';

export interface Caps { total: number; 'llm-list': number; 'jev-point': number; probe: number }
export interface LoadedData {
  dataset: Dataset; report: ValidationReport; manifest: Manifest;
  forcedModes: [string, FormatChaosMode][]; synthetic: boolean;
}
export interface DesignOptions {
  mode: 'mock' | 'live'; split: 'dev' | 'heldout'; preset: 'unbiased' | 'planted-bias';
  prompt: 'llm-list.v1' | 'llm-list.v2'; primary: 'llm-list' | 'jev-point'; caps: Caps;
  selectMock: boolean; prereg: Prereg | null; devDiffs: number[];
}
export interface Design {
  frozen: FrozenConfig; estimate: DryRun; devDiffs: number[]; tuning: DevTuning | null;
  selected: boolean; issues: string[];
}
export type WorkerRequest =
  | { id: number; type: 'load'; files: RawFiles | null; synthetic: boolean; manifest: Manifest | null; salt: string; seed: number }
  | { id: number; type: 'design'; data: LoadedData; options: DesignOptions };
export type WorkerResponse =
  | { id: number; type: 'loaded'; data: LoadedData }
  | { id: number; type: 'designed'; design: Design }
  | { id: number; type: 'error'; error: string; report?: ValidationReport };
