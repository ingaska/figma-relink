import { PluginMessage, UIMessage } from './types';
import { relinkSelectionStreaming } from './relinker';

figma.showUI(__html__, { width: 360, height: 520, title: 'Relinker' });

function send(msg: UIMessage): void { figma.ui.postMessage(msg); }

function pushSelectionInfo(): void {
  const sel = figma.currentPage.selection;
  send(sel.length === 0
    ? { type: 'selection-info', hasSelection: false, name: '', nodeType: '' }
    : { type: 'selection-info', hasSelection: true, name: sel[0].name, nodeType: sel[0].type });
}

figma.on('selectionchange', pushSelectionInfo);

let stopFlag = false;

figma.ui.onmessage = async (msg: PluginMessage) => {
  try {
    switch (msg.type) {
      case 'get-selection-info':
        pushSelectionInfo();
        break;

      case 'stop-relink':
        stopFlag = true;
        break;

      case 'relink-selection':
        stopFlag = false;
        send({ type: 'relink-start' });
        const result = await relinkSelectionStreaming(
          (entries, stats) => send({ type: 'relink-progress', entries, stats }),
          () => stopFlag,
        );
        send({ type: 'relink-done', result });
        break;

      case 'close':
        figma.closePlugin();
        break;
    }
  } catch (err) {
    send({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};
