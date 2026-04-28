import { ScanResult, RelinkResult, StyleEntry, VarEntry, CompEntry } from './types';

// ---------------------------------------------------------------------------
// Local maps — built once per scan/relink call
// ---------------------------------------------------------------------------

interface Maps {
  paintStyles:  Map<string, string>;   // name → id
  textStyles:   Map<string, string>;
  effectStyles: Map<string, string>;
  gridStyles:   Map<string, string>;
  localStyleIds: Set<string>;

  variables:   Map<string, Variable>;  // "Collection/Name" → Variable
  localVarIds: Set<string>;

  compCache: Map<string, ComponentNode | null>; // lookup cache
}

function buildMaps(): Maps {
  const paintStyles  = new Map<string, string>();
  const textStyles   = new Map<string, string>();
  const effectStyles = new Map<string, string>();
  const gridStyles   = new Map<string, string>();
  const localStyleIds = new Set<string>();

  for (const s of figma.getLocalPaintStyles())  { paintStyles.set(s.name, s.id);  localStyleIds.add(s.id); }
  for (const s of figma.getLocalTextStyles())   { textStyles.set(s.name, s.id);   localStyleIds.add(s.id); }
  for (const s of figma.getLocalEffectStyles()) { effectStyles.set(s.name, s.id); localStyleIds.add(s.id); }
  for (const s of figma.getLocalGridStyles())   { gridStyles.set(s.name, s.id);   localStyleIds.add(s.id); }

  const variables  = new Map<string, Variable>();
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
  } catch { /* Variables API unavailable on this plan/version */ }

  return { paintStyles, textStyles, effectStyles, gridStyles, localStyleIds, variables, localVarIds, compCache: new Map() };
}

// ---------------------------------------------------------------------------
// Component helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the component-set name for a main component.
 * Prefers main.parent (reliable when the library is accessible).
 * Falls back to the instance layer name, which Figma defaults to the set name.
 */
function getSetName(main: ComponentNode, inst: InstanceNode): string | null {
  if (main.parent?.type === 'COMPONENT_SET') return (main.parent as ComponentSetNode).name;
  return inst.name || null;
}

/**
 * Extract VARIANT-type entries from inst.componentProperties.
 * This is always accessible (unlike mainComponent.name which can be garbled
 * for remote library components). Returns e.g. { breakpoint: "mobile" }.
 */
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

/**
 * Find a local component that matches setName + variant properties.
 *
 * Matching strategy (in order):
 *   1. variantProperties on ComponentNode compared to the instance's variant props
 *      (property-based — survives garbled/inaccessible mainComponent.name)
 *   2. If no variant props (standalone or single-variant set): first component in
 *      the named set whose parent is that ComponentSetNode
 *
 * Results are cached keyed by setName + sorted prop pairs.
 */
function findLocalVariant(
  setName: string,
  variantProps: Record<string, string>,
  cache: Map<string, ComponentNode | null>,
): ComponentNode | null {
  const cacheKey = `${setName}\0${JSON.stringify(Object.entries(variantProps).sort())}`;
  if (cache.has(cacheKey)) return cache.get(cacheKey)!;

  const hasProps  = Object.keys(variantProps).length > 0;
  let found: ComponentNode | null = null;

  const pages = [figma.currentPage, ...figma.root.children.filter(p => p !== figma.currentPage)];

  outer: for (const page of pages) {
    const result = page.findOne((n): boolean => {
      if (n.type !== 'COMPONENT') return false;
      if (n.parent?.type !== 'COMPONENT_SET') return false;
      if ((n.parent as ComponentSetNode).name !== setName) return false;
      if (!hasProps) return true; // no variant constraints — first in set wins
      const vp = (n as ComponentNode).variantProperties;
      if (!vp) return false;
      // Every variant prop from the instance must match
      return Object.entries(variantProps).every(([k, v]) => vp[k] === v);
    }) as ComponentNode | null;
    if (result) { found = result; break outer; }
  }

  cache.set(cacheKey, found);
  return found;
}

// ---------------------------------------------------------------------------
// Style fields
// ---------------------------------------------------------------------------

const STYLE_FIELDS: { field: string; getMap: (m: Maps) => Map<string, string> }[] = [
  { field: 'fillStyleId',   getMap: m => m.paintStyles  },
  { field: 'strokeStyleId', getMap: m => m.paintStyles  },
  { field: 'effectStyleId', getMap: m => m.effectStyles },
  { field: 'textStyleId',   getMap: m => m.textStyles   },
  { field: 'gridStyleId',   getMap: m => m.gridStyles   },
];

// ---------------------------------------------------------------------------
// Variable fields
// ---------------------------------------------------------------------------

function resolveVar(alias: VariableAlias): Variable | null {
  try { return figma.variables.getVariableById(alias.id); } catch { return null; }
}

function varKey(v: Variable): string {
  try {
    const col = figma.variables.getVariableCollectionById(v.variableCollectionId);
    return col ? `${col.name}/${v.name}` : v.name;
  } catch { return v.name; }
}

const SCALAR_VAR_FIELDS: VariableBindableNodeField[] = [
  'opacity', 'cornerRadius', 'topLeftRadius', 'topRightRadius',
  'bottomLeftRadius', 'bottomRightRadius', 'itemSpacing',
  'paddingTop', 'paddingBottom', 'paddingLeft', 'paddingRight',
  'strokeWeight', 'minWidth', 'maxWidth', 'minHeight', 'maxHeight',
  'counterAxisSpacing',
];

const PAINT_VAR_FIELDS: VariableBindablePaintField[] = ['color', 'opacity', 'visible'];

// ---------------------------------------------------------------------------
// Shared display name for a component instance
// ---------------------------------------------------------------------------

function compDisplayName(setName: string, variantProps: Record<string, string>, fallback: string): string {
  const varStr = Object.keys(variantProps).length > 0
    ? Object.entries(variantProps).map(([k, v]) => `${k}=${v}`).join(', ')
    : fallback;
  return `${setName} / ${varStr}`;
}

// ---------------------------------------------------------------------------
// SCAN
// ---------------------------------------------------------------------------

function scanNode(
  node: SceneNode,
  maps: Maps,
  out: { styles: Map<string, StyleEntry>; vars: Map<string, VarEntry>; comps: Map<string, CompEntry> },
  counter: { n: number },
): void {
  counter.n++;

  // Styles
  for (const { field, getMap } of STYLE_FIELDS) {
    if (!(field in node)) continue;
    const rawId = (node as Record<string, unknown>)[field];
    if (!rawId || rawId === figma.mixed) continue;
    const id = rawId as string;
    if (maps.localStyleIds.has(id) || out.styles.has(id)) continue;
    const style = figma.getStyleById(id);
    if (!style) continue;
    out.styles.set(id, { name: style.name, styleType: style.type, hasLocal: getMap(maps).has(style.name) });
  }

  // Scalar variable bindings
  if ('boundVariables' in node) {
    const bv = (node as Record<string, unknown>).boundVariables as Record<string, VariableAlias> | undefined;
    if (bv) {
      for (const f of SCALAR_VAR_FIELDS) {
        const alias = bv[f];
        if (!alias?.id) continue;
        if (maps.localVarIds.has(alias.id)) continue;
        const v = resolveVar(alias);
        if (!v) continue;
        const key = varKey(v);
        if (!out.vars.has(key)) out.vars.set(key, { key, hasLocal: maps.variables.has(key) });
      }
    }
  }

  // Paint variable bindings
  for (const prop of ['fills', 'strokes'] as const) {
    if (!(prop in node)) continue;
    const paints = (node as GeometryMixin)[prop];
    if (!paints || paints === figma.mixed) continue;
    for (const paint of paints as Paint[]) {
      if (!paint.boundVariables) continue;
      for (const pf of PAINT_VAR_FIELDS) {
        const alias = paint.boundVariables[pf];
        if (!alias || Array.isArray(alias)) continue;
        const a = alias as VariableAlias;
        if (maps.localVarIds.has(a.id)) continue;
        const v = resolveVar(a);
        if (!v) continue;
        const key = varKey(v);
        if (!out.vars.has(key)) out.vars.set(key, { key, hasLocal: maps.variables.has(key) });
      }
    }
  }

  // Instances
  if (node.type === 'INSTANCE') {
    const inst = node as InstanceNode;
    const main = inst.mainComponent;
    if (main) {
      const setName = getSetName(main, inst);
      if (setName) {
        const variantProps = getVariantProps(inst);
        const cacheKey = `${setName}\0${JSON.stringify(Object.entries(variantProps).sort())}`;
        if (!out.comps.has(cacheKey)) {
          const local = findLocalVariant(setName, variantProps, maps.compCache);
          const needsSwap = local !== null && local.key !== main.key;
          if (local === null || needsSwap) {
            const display = compDisplayName(setName, variantProps, local?.name ?? main.name);
            out.comps.set(cacheKey, { name: display, hasLocal: local !== null });
          }
        }
      }
    }
    return; // never recurse into instance children
  }

  if ('children' in node) {
    for (const child of (node as ChildrenMixin).children as SceneNode[])
      scanNode(child, maps, out, counter);
  }
}

export function scanSelection(): ScanResult {
  const sel = figma.currentPage.selection;
  if (sel.length === 0) throw new Error('Select a frame or component first.');

  const maps = buildMaps();
  const out = {
    styles: new Map<string, StyleEntry>(),
    vars:   new Map<string, VarEntry>(),
    comps:  new Map<string, CompEntry>(),
  };
  const counter = { n: 0 };
  for (const node of sel) scanNode(node as SceneNode, maps, out, counter);

  return {
    styles:       [...out.styles.values()],
    variables:    [...out.vars.values()],
    components:   [...out.comps.values()],
    nodesScanned: counter.n,
  };
}

// ---------------------------------------------------------------------------
// RELINK
// ---------------------------------------------------------------------------

function relinkNode(node: SceneNode, maps: Maps, result: RelinkResult): void {
  result.nodesProcessed++;

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
      (node as Record<string, unknown>)[field] = localId;
      result.stylesRelinked++;
    } else if (!result.stylesMissing.includes(style.name)) {
      result.stylesMissing.push(style.name);
    }
  }

  // Scalar variable bindings
  if ('boundVariables' in node) {
    const bv = (node as Record<string, unknown>).boundVariables as Record<string, VariableAlias> | undefined;
    if (bv) {
      for (const f of SCALAR_VAR_FIELDS) {
        const alias = bv[f];
        if (!alias?.id) continue;
        if (maps.localVarIds.has(alias.id)) continue;
        const v = resolveVar(alias);
        if (!v) continue;
        const key = varKey(v);
        const localVar = maps.variables.get(key);
        if (localVar) {
          try {
            (node as SceneNode & { setBoundVariable(f: string, v: Variable | null): void })
              .setBoundVariable(f, localVar);
            result.variablesRelinked++;
          } catch { /* field may not support binding on this node type */ }
        } else if (!result.variablesMissing.includes(key)) {
          result.variablesMissing.push(key);
        }
      }
    }
  }

  // Paint variable bindings (fills + strokes)
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
        const v = resolveVar(a);
        if (!v) continue;
        const key = varKey(v);
        const localVar = maps.variables.get(key);
        if (localVar) {
          try {
            p = figma.variables.setBoundVariableForPaint(p, pf, localVar);
            result.variablesRelinked++;
            dirty = true;
          } catch { /* unsupported paint field */ }
        } else if (!result.variablesMissing.includes(key)) {
          result.variablesMissing.push(key);
        }
      }
      return p;
    });
    if (dirty) (node as GeometryMixin)[prop] = newPaints;
  }

  // Instances
  if (node.type === 'INSTANCE') {
    const inst = node as InstanceNode;
    const main = inst.mainComponent;
    if (main) {
      const setName = getSetName(main, inst);
      if (setName) {
        const variantProps = getVariantProps(inst);
        const local = findLocalVariant(setName, variantProps, maps.compCache);
        if (local && local.key !== main.key) {
          inst.swapComponent(local);
          result.componentsSwapped++;
        } else if (!local) {
          const display = compDisplayName(setName, variantProps, main.name);
          if (!result.componentsMissing.includes(display)) result.componentsMissing.push(display);
        }
      }
    }
    return; // never recurse into instance children
  }

  if ('children' in node) {
    for (const child of (node as ChildrenMixin).children as SceneNode[])
      relinkNode(child, maps, result);
  }
}

export function relinkSelection(): RelinkResult {
  const sel = figma.currentPage.selection;
  if (sel.length === 0) throw new Error('Select a frame or component first.');

  const maps = buildMaps();
  const result: RelinkResult = {
    stylesRelinked: 0,   stylesMissing: [],
    variablesRelinked: 0, variablesMissing: [],
    componentsSwapped: 0, componentsMissing: [],
    nodesProcessed: 0,
  };
  for (const node of sel) relinkNode(node as SceneNode, maps, result);
  return result;
}
