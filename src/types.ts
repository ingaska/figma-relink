export interface StyleEntry {
  name: string;
  styleType: string; // 'PAINT' | 'TEXT' | 'EFFECT' | 'GRID'
  hasLocal: boolean;
}

export interface VarEntry {
  key: string; // "Collection/Name"
  hasLocal: boolean;
}

export interface CompEntry {
  name: string;
  hasLocal: boolean;
}

export interface ScanResult {
  styles: StyleEntry[];
  variables: VarEntry[];
  components: CompEntry[];
  nodesScanned: number;
}

export interface RelinkResult {
  stylesRelinked: number;
  stylesMissing: string[];
  variablesRelinked: number;
  variablesMissing: string[];
  componentsSwapped: number;
  componentsMissing: string[];
  nodesProcessed: number;
}

export type PluginMessage =
  | { type: 'scan-selection' }
  | { type: 'relink-selection' }
  | { type: 'get-selection-info' }
  | { type: 'close' };

export type UIMessage =
  | { type: 'selection-info'; hasSelection: boolean; name: string; nodeType: string }
  | { type: 'scan-result'; result: ScanResult }
  | { type: 'relink-result'; result: RelinkResult }
  | { type: 'error'; message: string };
