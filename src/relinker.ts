import { RelinkResult, LogEntry } from './types';

// ---------------------------------------------------------------------------
// Local maps — built once per relink call
// ---------------------------------------------------------------------------

interface Maps {
  paintStyles:   Map<string, string>;
  textStyles:    Map<string, string>;
  effectStyles:  Map<string, string>;
  gridStyles:    Map<string, string>;
  localStyleIds: Set<string>;

  variables:    Map<string, Variable>;   // "Collection/Name" → Variable
  localVarIds:  Set<string>;

  compCache: Map<string, ComponentNode | null>;
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

  return {
    paintStyles, textStyles, effectStyles, gridStyles, localStyleIds,
    variables, localVarIds,
    compCache: new Map(),
  };
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
  const cacheKey = `${setName}\0${JSON.stringify(Object.entries(variantProps).sort())}`;
  if (cache.has(cacheKey)) return cache.get(cacheKey)!;

  const hasProps = Object.keys(variantProps).length > 0;
  let found: ComponentNode | null = null;

  const pages = [figma.currentPage, ...figma.root.children.filter(p => p !== figma.currentPage)];

  outer: for (const page of pages) {
    const result = page.findOne((n): boolean => {
      if (n.type !== 'COMPONENT') return false;
      if (n.parent?.type !== 'COMPONENT_SET') return false;
      if ((n.parent as ComponentSetNode).name !== setName) return false;
      if (!hasProps) return true;
      const vp = (n as ComponentNode).variantProperties;
      if (!vp) return false;
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
// Log helper
// ---------------------------------------------------------------------------

function push(result: RelinkResult, entry: LogEntry): void {
  result.log.push(entry);
}

// ---------------------------------------------------------------------------
// RELINK — full tree walk including inside instances
// ---------------------------------------------------------------------------

function relinkNode(node: SceneNode, maps: Maps, result: RelinkResult): void {
  result.nodesProcessed++;

  // ── Styles ──────────────────────────────────────────────────────────────
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
      try {
        (node as Record<string, unknown>)[field] = localId;
        result.stylesRelinked++;
        push(result, { status: 'ok', category: 'style', name: style.name });
      } catch (e) {
        const msg = `Style "${style.name}": ${e instanceof Error ? e.message : e}`;
        result.errors.push(msg);
        push(result, { status: 'error', category: 'style', name: style.name });
      }
    } else {
      if (!result.missing.includes(style.name)) result.missing.push(style.name);
      push(result, { status: 'missing', category: 'style', name: style.name });
    }
  }

  // ── Scalar variable bindings ─────────────────────────────────────────────
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
            push(result, { status: 'ok', category: 'variable', name: key });
          } catch (e) {
            const msg = `Variable "${key}": ${e instanceof Error ? e.message : e}`;
            result.errors.push(msg);
            push(result, { status: 'error', category: 'variable', name: key });
          }
        } else {
          if (!result.missing.includes(key)) result.missing.push(key);
          push(result, { status: 'missing', category: 'variable', name: key });
        }
      }
    }
  }

  // ── Paint variable bindings ──────────────────────────────────────────────
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
            push(result, { status: 'ok', category: 'variable', name: key });
          } catch (e) {
            result.errors.push(`Variable "${key}": ${e instanceof Error ? e.message : e}`);
            push(result, { status: 'error', category: 'variable', name: key });
          }
        } else {
          if (!result.missing.includes(key)) result.missing.push(key);
          push(result, { status: 'missing', category: 'variable', name: key });
        }
      }
      return p;
    });
    if (dirty) (node as GeometryMixin)[prop] = newPaints;
  }

  // ── Component instance swap ──────────────────────────────────────────────
  if (node.type === 'INSTANCE') {
    const inst = node as InstanceNode;
    const main = inst.mainComponent;
    if (main) {
      const setName = getSetName(main, inst);
      if (setName) {
        const variantProps = getVariantProps(inst);
        const local = findLocalVariant(setName, variantProps, maps.compCache);
        const display = Object.keys(variantProps).length > 0
          ? `${setName} / ${Object.entries(variantProps).map(([k, v]) => `${k}=${v}`).join(', ')}`
          : setName;

        if (local && local.key !== main.key) {
          try {
            inst.swapComponent(local);
            result.componentsSwapped++;
            push(result, { status: 'ok', category: 'component', name: display });
          } catch (e) {
            result.errors.push(`Component "${display}": ${e instanceof Error ? e.message : e}`);
            push(result, { status: 'error', category: 'component', name: display });
          }
        } else if (!local) {
          if (!result.missing.includes(display)) result.missing.push(display);
          push(result, { status: 'missing', category: 'component', name: display });
        }
        // local.key === main.key → already local, nothing to do
      }
    }
    // ↓ fall through — recurse into instance children to catch nested
    //   style/variable overrides applied on individual child nodes
  }

  if ('children' in node) {
    for (const child of (node as ChildrenMixin).children as SceneNode[])
      relinkNode(child, maps, result);
  }
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export function relinkSelection(): RelinkResult {
  const sel = figma.currentPage.selection;
  if (sel.length === 0) throw new Error('Select a frame or component first.');

  const maps = buildMaps();
  const result: RelinkResult = {
    stylesRelinked: 0, variablesRelinked: 0, componentsSwapped: 0,
    missing: [], errors: [], log: [],
    nodesProcessed: 0,
  };

  for (const node of sel) relinkNode(node as SceneNode, maps, result);
  return result;
}
