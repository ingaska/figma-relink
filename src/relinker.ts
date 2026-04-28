import { LogEntry, RelinkResult, RelinkStats } from './types';

// ---------------------------------------------------------------------------
// Yield helper — releases main thread so UI messages can flow
// ---------------------------------------------------------------------------
const tick = (): Promise<void> => new Promise(r => setTimeout(r, 0));

// ---------------------------------------------------------------------------
// Local maps
// ---------------------------------------------------------------------------
interface Maps {
  paintStyles:   Map<string, string>;
  textStyles:    Map<string, string>;
  effectStyles:  Map<string, string>;
  gridStyles:    Map<string, string>;
  localStyleIds: Set<string>;
  variables:     Map<string, Variable>;
  localVarIds:   Set<string>;
  compCache:     Map<string, ComponentNode | null>;
}

function buildMaps(): Maps {
  const paintStyles   = new Map<string, string>();
  const textStyles    = new Map<string, string>();
  const effectStyles  = new Map<string, string>();
  const gridStyles    = new Map<string, string>();
  const localStyleIds = new Set<string>();

  for (const s of figma.getLocalPaintStyles())  { paintStyles.set(s.name, s.id);  localStyleIds.add(s.id); }
  for (const s of figma.getLocalTextStyles())   { textStyles.set(s.name, s.id);   localStyleIds.add(s.id); }
  for (const s of figma.getLocalEffectStyles()) { effectStyles.set(s.name, s.id); localStyleIds.add(s.id); }
  for (const s of figma.getLocalGridStyles())   { gridStyles.set(s.name, s.id);   localStyleIds.add(s.id); }

  const variables   = new Map<string, Variable>();
  const localVarIds = new Set<string>();
  try {
    const colCache = new Map<string, string>();
    for (const v of figma.variables.getLocalVariables()) {
      let col = colCache.get(v.variableCollectionId);
      if (col === undefined) {
        col = figma.variables.getVariableCollectionById(v.variableCollectionId)?.name ?? '';
        colCache.set(v.variableCollectionId, col);
      }
      variables.set(`${col}/${v.name}`, v);
      localVarIds.add(v.id);
    }
  } catch { /* Variables API unavailable */ }

  return { paintStyles, textStyles, effectStyles, gridStyles, localStyleIds, variables, localVarIds, compCache: new Map() };
}

// ---------------------------------------------------------------------------
// Component helpers
// ---------------------------------------------------------------------------
function getSetName(main: ComponentNode, inst: InstanceNode): string | null {
  if (main.parent?.type === 'COMPONENT_SET') return (main.parent as ComponentSetNode).name;
  return inst.name || null;
}

function getVariantProps(inst: InstanceNode): Record<string, string> {
  try {
    const cp = (inst as unknown as Record<string, unknown>).componentProperties as
      Record<string, { type: string; value: unknown }> | undefined;
    if (!cp) return {};
    const out: Record<string, string> = {};
    for (const [k, p] of Object.entries(cp))
      if (p.type === 'VARIANT' && typeof p.value === 'string') out[k] = p.value;
    return out;
  } catch { return {}; }
}

function findLocalVariant(
  setName: string,
  variantProps: Record<string, string>,
  cache: Map<string, ComponentNode | null>,
): ComponentNode | null {
  const key = `${setName}\0${JSON.stringify(Object.entries(variantProps).sort())}`;
  if (cache.has(key)) return cache.get(key)!;

  const hasProps = Object.keys(variantProps).length > 0;
  let found: ComponentNode | null = null;

  const pages = [figma.currentPage, ...figma.root.children.filter(p => p !== figma.currentPage)];
  outer: for (const page of pages) {
    const r = page.findOne((n): boolean => {
      if (n.type !== 'COMPONENT') return false;
      if (n.parent?.type !== 'COMPONENT_SET') return false;
      if ((n.parent as ComponentSetNode).name !== setName) return false;
      if (!hasProps) return true;
      const vp = (n as ComponentNode).variantProperties;
      if (!vp) return false;
      return Object.entries(variantProps).every(([k, v]) => vp[k] === v);
    }) as ComponentNode | null;
    if (r) { found = r; break outer; }
  }

  cache.set(key, found);
  return found;
}

// ---------------------------------------------------------------------------
// Style / variable field tables
// ---------------------------------------------------------------------------
const STYLE_FIELDS: { field: string; getMap: (m: Maps) => Map<string, string> }[] = [
  { field: 'fillStyleId',   getMap: m => m.paintStyles  },
  { field: 'strokeStyleId', getMap: m => m.paintStyles  },
  { field: 'effectStyleId', getMap: m => m.effectStyles },
  { field: 'textStyleId',   getMap: m => m.textStyles   },
  { field: 'gridStyleId',   getMap: m => m.gridStyles   },
];

const SCALAR_VAR_FIELDS: VariableBindableNodeField[] = [
  'opacity', 'cornerRadius', 'topLeftRadius', 'topRightRadius',
  'bottomLeftRadius', 'bottomRightRadius', 'itemSpacing',
  'paddingTop', 'paddingBottom', 'paddingLeft', 'paddingRight',
  'strokeWeight', 'minWidth', 'maxWidth', 'minHeight', 'maxHeight',
  'counterAxisSpacing',
];
const PAINT_VAR_FIELDS: VariableBindablePaintField[] = ['color', 'opacity', 'visible'];

function resolveVar(alias: VariableAlias): Variable | null {
  try { return figma.variables.getVariableById(alias.id); } catch { return null; }
}
function varKey(v: Variable): string {
  try {
    const col = figma.variables.getVariableCollectionById(v.variableCollectionId);
    return col ? `${col.name}/${v.name}` : v.name;
  } catch { return v.name; }
}

// ---------------------------------------------------------------------------
// Per-node processing — synchronous, returns new log entries
// ---------------------------------------------------------------------------
function processNode(
  node: SceneNode,
  maps: Maps,
  stats: RelinkStats,
  missingItems: string[],
  errorItems:   string[],
): LogEntry[] {
  const entries: LogEntry[] = [];

  const log = (e: LogEntry) => entries.push(e);

  // Styles
  for (const { field, getMap } of STYLE_FIELDS) {
    if (!(field in node)) continue;
    const rawId = (node as Record<string, unknown>)[field];
    if (!rawId || rawId === figma.mixed) continue;
    const id = rawId as string;
    if (maps.localStyleIds.has(id)) continue;
    const style = figma.getStyleById(id);
    if (!style) continue;
    const localId = getMap(maps).get(style.name);
    if (localId) {
      try { (node as Record<string, unknown>)[field] = localId; stats.relinked++; log({ status: 'ok', category: 'style', name: style.name }); }
      catch (e) { const m = `Style "${style.name}": ${e instanceof Error ? e.message : e}`; if (!errorItems.includes(m)) errorItems.push(m); stats.errors++; log({ status: 'error', category: 'style', name: style.name }); }
    } else {
      if (!missingItems.includes(style.name)) { missingItems.push(style.name); stats.missing++; log({ status: 'missing', category: 'style', name: style.name }); }
    }
  }

  // Scalar variable bindings
  if ('boundVariables' in node) {
    const bv = (node as Record<string, unknown>).boundVariables as Record<string, VariableAlias> | undefined;
    if (bv) {
      for (const f of SCALAR_VAR_FIELDS) {
        const alias = bv[f]; if (!alias?.id) continue;
        if (maps.localVarIds.has(alias.id)) continue;
        const v = resolveVar(alias); if (!v) continue;
        const key = varKey(v);
        const localVar = maps.variables.get(key);
        if (localVar) {
          try {
            (node as SceneNode & { setBoundVariable(f: string, v: Variable | null): void }).setBoundVariable(f, localVar);
            stats.relinked++;
            log({ status: 'ok', category: 'variable', name: key });
          } catch (e) { const m = `Var "${key}": ${e instanceof Error ? e.message : e}`; if (!errorItems.includes(m)) errorItems.push(m); stats.errors++; log({ status: 'error', category: 'variable', name: key }); }
        } else {
          if (!missingItems.includes(key)) { missingItems.push(key); stats.missing++; log({ status: 'missing', category: 'variable', name: key }); }
        }
      }
    }
  }

  // Paint variable bindings
  for (const prop of ['fills', 'strokes'] as const) {
    if (!(prop in node)) continue;
    const paints = (node as GeometryMixin)[prop];
    if (!paints || paints === figma.mixed) continue;
    let dirty = false;
    const newPaints = (paints as Paint[]).map(paint => {
      if (!paint.boundVariables) return paint;
      let p = paint;
      for (const pf of PAINT_VAR_FIELDS) {
        const alias = paint.boundVariables[pf];
        if (!alias || Array.isArray(alias)) continue;
        const a = alias as VariableAlias;
        if (maps.localVarIds.has(a.id)) continue;
        const v = resolveVar(a); if (!v) continue;
        const key = varKey(v);
        const localVar = maps.variables.get(key);
        if (localVar) {
          try { p = figma.variables.setBoundVariableForPaint(p, pf, localVar); stats.relinked++; dirty = true; log({ status: 'ok', category: 'variable', name: key }); }
          catch (e) { const m = `Var "${key}": ${e instanceof Error ? e.message : e}`; if (!errorItems.includes(m)) errorItems.push(m); stats.errors++; log({ status: 'error', category: 'variable', name: key }); }
        } else {
          if (!missingItems.includes(key)) { missingItems.push(key); stats.missing++; log({ status: 'missing', category: 'variable', name: key }); }
        }
      }
      return p;
    });
    if (dirty) (node as GeometryMixin)[prop] = newPaints;
  }

  // Component instance
  if (node.type === 'INSTANCE') {
    const inst = node as InstanceNode;
    const main = inst.mainComponent;
    if (main) {
      const setName = getSetName(main, inst);
      if (setName) {
        const vp = getVariantProps(inst);
        const display = Object.keys(vp).length > 0
          ? `${setName} / ${Object.entries(vp).map(([k, v]) => `${k}=${v}`).join(', ')}`
          : setName;
        const local = findLocalVariant(setName, vp, maps.compCache);
        if (local && local.key !== main.key) {
          try { inst.swapComponent(local); stats.relinked++; log({ status: 'ok', category: 'component', name: display }); }
          catch (e) { const m = `Comp "${display}": ${e instanceof Error ? e.message : e}`; if (!errorItems.includes(m)) errorItems.push(m); stats.errors++; log({ status: 'error', category: 'component', name: display }); }
        } else if (!local) {
          if (!missingItems.includes(display)) { missingItems.push(display); stats.missing++; log({ status: 'missing', category: 'component', name: display }); }
        }
      }
    }
  }

  return entries;
}

// ---------------------------------------------------------------------------
// Streaming iterative tree walk
// ---------------------------------------------------------------------------
const BATCH = 12; // nodes per tick

export async function relinkSelectionStreaming(
  onProgress: (entries: LogEntry[], stats: RelinkStats) => void,
  isStopped:  () => boolean,
): Promise<RelinkResult> {
  const sel = figma.currentPage.selection;
  if (sel.length === 0) throw new Error('Select a frame or component first.');

  const maps  = buildMaps();
  const stats: RelinkStats = { relinked: 0, missing: 0, errors: 0, processed: 0 };
  const missingItems: string[] = [];
  const errorItems:   string[] = [];

  // Iterative DFS stack — avoids call-stack limits on deep trees
  const stack: SceneNode[] = [...(sel as unknown as SceneNode[])].reverse();
  let batchEntries: LogEntry[] = [];
  let batchCount = 0;

  while (stack.length > 0 && !isStopped()) {
    const node = stack.pop()!;
    stats.processed++;

    const entries = processNode(node, maps, stats, missingItems, errorItems);
    batchEntries.push(...entries);

    // Push children in reverse order to maintain document order
    if ('children' in node) {
      const children = (node as ChildrenMixin).children as SceneNode[];
      for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]);
    }

    batchCount++;
    if (batchCount >= BATCH) {
      batchCount = 0;
      if (batchEntries.length > 0) { onProgress([...batchEntries], { ...stats }); batchEntries = []; }
      await tick(); // yield main thread → UI renders + stop message can arrive
    }
  }

  // Flush tail
  if (batchEntries.length > 0) onProgress([...batchEntries], { ...stats });

  return { stats, missingItems, errorItems, stopped: isStopped() };
}
