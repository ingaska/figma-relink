import { PluginMessage, UIMessage } from './types';
import { relinkSelection } from './relinker';

figma.showUI(__html__, { width: 360, height: 520, title: 'Relinker' });

function send(msg: UIMessage): void {
  figma.ui.postMessage(msg);
}

function pushSelectionInfo(): void {
  const sel = figma.currentPage.selection;
  send(sel.length === 0
    ? { type: 'selection-info', hasSelection: false, name: '', nodeType: '' }
    : { type: 'selection-info', hasSelection: true, name: sel[0].name, nodeType: sel[0].type });
}

figma.on('selectionchange', pushSelectionInfo);

figma.ui.onmessage = (msg: PluginMessage) => {
  try {
    switch (msg.type) {
      case 'get-selection-info':
        pushSelectionInfo();
        break;

      case 'relink-selection':
        send({ type: 'relink-result', result: relinkSelection() });
        break;

      case 'close':
        figma.closePlugin();
        break;
    }
  } catch (err) {
    send({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};
