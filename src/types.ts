export interface LogEntry {
  status:   'ok' | 'missing' | 'error';
  category: 'style' | 'variable' | 'component';
  name: string;
}

export interface RelinkResult {
  stylesRelinked:    number;
  variablesRelinked: number;
  componentsSwapped: number;
  missing: string[];   // items not found locally
  errors:  string[];   // items found but failed to apply
  log:     LogEntry[]; // full ordered action log
  nodesProcessed: number;
}

export type PluginMessage =
  | { type: 'relink-selection' }
  | { type: 'get-selection-info' }
  | { type: 'close' };

export type UIMessage =
  | { type: 'selection-info'; hasSelection: boolean; name: string; nodeType: string }
  | { type: 'relink-result'; result: RelinkResult }
  | { type: 'error'; message: string };
