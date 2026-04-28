export interface LogEntry {
  status:   'ok' | 'missing' | 'error';
  category: 'style' | 'variable' | 'component';
  name: string;
}

export interface RelinkStats {
  relinked:  number;
  missing:   number;
  errors:    number;
  processed: number;
}

export interface RelinkResult {
  stats:        RelinkStats;
  missingItems: string[];
  errorItems:   string[];
  stopped:      boolean;
}

export type PluginMessage =
  | { type: 'relink-selection' }
  | { type: 'stop-relink' }
  | { type: 'get-selection-info' }
  | { type: 'close' };

export type UIMessage =
  | { type: 'selection-info'; hasSelection: boolean; name: string; nodeType: string }
  | { type: 'relink-start' }
  | { type: 'relink-progress'; entries: LogEntry[]; stats: RelinkStats }
  | { type: 'relink-done'; result: RelinkResult }
  | { type: 'error'; message: string };
