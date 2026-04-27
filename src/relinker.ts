import { ScanResult, RelinkResult, StyleEntry, VarEntry, CompEntry } from './types';

// ---------------------------------------------------------------------------
// Local lookup maps — built once per scan/relink call
// ---------------------------------------------------------------------------

interface LocalMaps {
  styles: Map<string, string>;       // style name → local id
  styleTypeById: Map<string, string>;// local style id → type label
  localStyleIds: Set<string>;        // quick "is it local?" check
  variables: Map<string, Variable>;  // "Collection/Name" → Variable
  localVarIds: Set<string>;          // quick "is it local?" check
  componentCache: Map<string, ComponentNode | null>; // lazy name → node
}

function buildLocalMaps(): LocalMaps {
  // ── Styles ──────────────────────────────────────────────────────────────
  const styles = new Map<string, string>();
  const styleTypeById = new Map<string, string>();
  const localStyleIds = new Set<string>();

  const allStyles = [
    ...figma.getLocalPaintStyles().map(s => ({ s, t: 'PAINT' })),
    ...figma.getLocalTextStyles().map(s => ({ s, t: 'TEXT' })),
    ...figma.getLocalEffectStyles().map(s => ({ s, t: 'EFFECT' })),
    ...figma.getLocalGridStyles().map(s => ({ s, t: 'GRID' })),
  ];
  for (const { s, t } of allStyles) {
    styles.set(s.name, s.id);
    styleTypeById.set(s.id, t);
    localStyleIds.add(s.id);
  }

  // ── Variables ────────────────────────────────────────────────────────────
  const variables = new Map<string, Variable>();
  const localVarIds = new Set<string>();

  try {
    // getLocalVariables() is one call vs N getVariableById() calls
    const colNameCache = new Map<string, string>();
    for (const v of figma.variables.getLocalVariables()) {
      let colName = colNameCache.get(v.variableCollectionId);
      if (colName === undefined) {
        colName = figma.variables.getVariableCollectionById(v.variableCollectionId)?.name ?? '';
        colNameCache.set(v.variableCollectionId, colName);
      }
      variables.set(`${colName}/${v.name}`, v);
      localVarIds.add(v.id);
    }
  } catch {
    // Variables API unavailable (older Figma plan/version) — skip silently
  }

  // ── Components: lazy — searched on demand, NOT pre-scanned ──────────────
  const componentCache = new Map<string, ComponentNode | null>();

  return { styles, styleTypeById, localStyleIds, variables, localVarIds, componentCache };
}

// ---------------------------------------------------------------------------
// Component lookup — matches by BOTH component-set name AND variant name
// so "breakpoint=mobile" inside "Header" never collides with
// "breakpoint=mobile" inside "SportEntrancePage.Promo"
// ---------------------------------------------------------------------------

function compSetName(comp: ComponentNode): string | null {
  return comp.parent?.type === 'COMPONENT_SET'
    ? (comp.parent as ComponentSetNode).name
    : null;
}

/** Stable cache key: "SetName/variantName" or just "variantName" for standalone */
function compCacheKey(variantName: string, setName: string | null): string {
  return setName ? `${setName}/${variantName}` : variantName;
}

function findLocalComponent(
  variantName: string,
  setName: string | null,
  cache: Map<string, ComponentNode | null>,
): ComponentNode | null {
  const key = compCacheKey(variantName, setName);
  if (cache.has(key)) return cache.get(key)!;

  let found: ComponentNode | null = null;
  const pages = [figma.currentPage, ...figma.root.children.filter(p => p !== figma.currentPage)];

  for (const page of pages) {
    if (setName) {
      // Must match both the variant name AND the parent component-set name
      found = page.findOne(n =>
        n.type === 'COMPONENT' &&
        n.name === variantName &&
        n.parent?.type === 'COMPONENT_SET' &&
        (n.parent as ComponentSetNode).name === setName,
      ) as ComponentNode | null;
    } else {
      // Standalone component — match by name, not inside a component set
      found = page.findOne(n =>
        n.type === 'COMPONENT' &&
        n.name === variantName &&
        n.parent?.type !== 'COMPONENT_SET',
      ) as ComponentNode | null;
    }
    if (found) break;
  }

  cache.set(key, found);
  return found;
}

// ---------------------------------------------------------------------------
// Name helpers
// ---------------------------------------------------------------------------

/** Strip Figma layer-type icon characters that appear in remote component names */
function cleanName(name: string): string {
  return name.replace(/[❖◆◇▾▸]/g, '').replace(/\s{2,}/g, ' ').trim();
}

// ---------------------------------------------------------------------------
// Style helpers
// ---------------------------------------------------------------------------

function getStyleName(styleId: string): string | null {
  try { return figma.getStyleById(styleId)?.name ?? null; } catch { return null; }
}

const STYLE_FIELDS = [
  'fillStyleId', 'strokeStyleId', 'effectStyleId', 'textStyleId', 'gridStyleId',
] as const;

// ---------------------------------------------------------------------------
// Variable helpers
// ---------------------------------------------------------------------------

function getVarKey(v: Variable): string {
  try {
    const col = figma.variables.getVariableCollectionById(v.variableCollectionId);
    return col ? `${col.name}/${v.name}` : v.name;
  } catch { return v.name; }
}

function resolveAlias(alias: VariableAlias): Variable | null {
  try { return figma.variables.getVariableById(alias.id); } catch { return null; }
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
// SCAN — read-only tree walk
// ---------------------------------------------------------------------------

function scanNode(
  node: SceneNode,
  maps: LocalMaps,
  styles: Map<string, StyleEntry>,
  variables: Map<string, VarEntry>,
  components: Map<string, CompEntry>,
  counter: { n: number },
): void {
  counter.n++;

  // Styles
  for (const field of STYLE_FIELDS) {
    if (!(field in node)) continue;
    const rawId = (node as Record<string, unknown>)[field];
    if (!rawId || rawId === figma.mixed) continue;
    const id = rawId as string;
    if (maps.localStyleIds.has(id) || styles.has(id)) continue;
    const name = getStyleName(id);
    if (!name) continue;
    styles.set(id, {
      name,
      styleType: maps.styleTypeById.get(id) ?? 'STYLE',
      hasLocal: maps.styles.has(name),
    });
  }

  // Scalar variable bindings
  if ('boundVariables' in node) {
    const bv = (node as Record<string, unknown>).boundVariables as Record<string, VariableAlias> | undefined;
    if (bv) {
      for (const field of SCALAR_VAR_FIELDS) {
        const alias = bv[field];
        if (!alias || !('id' in alias)) continue;
        if (maps.localVarIds.has(alias.id)) continue;
        const v = resolveAlias(alias);
        if (!v) continue;
        const key = getVarKey(v);
        if (!variables.has(key)) variables.set(key, { key, hasLocal: maps.variables.has(key) });
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
        if (maps.localVarIds.has((alias as VariableAlias).id)) continue;
        const v = resolveAlias(alias as VariableAlias);
        if (!v) continue;
        const key = getVarKey(v);
        if (!variables.has(key)) variables.set(key, { key, hasLocal: maps.variables.has(key) });
      }
    }
  }

  // Instances — match by set+variant name to avoid false positives
  if (node.type === 'INSTANCE') {
    const inst = node as InstanceNode;
    const main = inst.mainComponent;
    if (main) {
      // compSetName() returns null when the remote component's parent is inaccessible.
      // Fall back to the instance's own name, which Figma keeps as "<SetName>" for variants.
      const setName = compSetName(main) ?? (inst.name !== main.name ? inst.name : null);
      const cacheKey = compCacheKey(main.name, setName);
      if (!components.has(cacheKey)) {
        const localComp = findLocalComponent(main.name, setName, maps.componentCache);
        const needsSwap = localComp !== null && localComp.key !== main.key;
        if (localComp === null || needsSwap) {
          const displayName = cleanName(setName ? `${setName} / ${main.name}` : main.name);
          components.set(cacheKey, { name: displayName, hasLocal: localComp !== null });
        }
      }
    }
    return; // don't recurse into instance children
  }

  if ('children' in node) {
    for (const child of (node as ChildrenMixin).children as SceneNode[]) {
      scanNode(child, maps, styles, variables, components, counter);
    }
  }
}

export function scanSelection(): ScanResult {
  const sel = figma.currentPage.selection;
  if (sel.length === 0) throw new Error('Select a frame or component first.');

  const maps = buildLocalMaps();
  const stylesMap = new Map<string, StyleEntry>();
  const variablesMap = new Map<string, VarEntry>();
  const componentsMap = new Map<string, CompEntry>();
  const counter = { n: 0 };

  for (const node of sel) {
    scanNode(node as SceneNode, maps, stylesMap, variablesMap, componentsMap, counter);
  }

  return {
    styles: Array.from(stylesMap.values()),
    variables: Array.from(variablesMap.values()),
    components: Array.from(componentsMap.values()),
    nodesScanned: counter.n,
  };
}

// ---------------------------------------------------------------------------
// RELINK — mutating tree walk
// ---------------------------------------------------------------------------

function relinkStyles(node: SceneNode, maps: LocalMaps, result: RelinkResult): void {
  for (const field of STYLE_FIELDS) {
    if (!(field in node)) continue;
    const rawId = (node as Record<string, unknown>)[field];
    if (!rawId || rawId === figma.mixed) continue;
    const id = rawId as string;
    if (maps.localStyleIds.has(id)) continue;

    const name = getStyleName(id);
    if (!name) continue;

    const localId = maps.styles.get(name);
    if (localId) {
      (node as Record<string, unknown>)[field] = localId;
      result.stylesRelinked++;
    } else if (!result.stylesMissing.includes(name)) {
      result.stylesMissing.push(name);
    }
  }
}

function relinkScalarVars(node: SceneNode, maps: LocalMaps, result: RelinkResult): void {
  if (!('boundVariables' in node)) return;
  const bv = (node as Record<string, unknown>).boundVariables as Record<string, VariableAlias> | undefined;
  if (!bv) return;

  for (const field of SCALAR_VAR_FIELDS) {
    const alias = bv[field];
    if (!alias || !('id' in alias)) continue;
    if (maps.localVarIds.has(alias.id)) continue;
    const donorVar = resolveAlias(alias);
    if (!donorVar) continue;
    const key = getVarKey(donorVar);
    const localVar = maps.variables.get(key);
    if (localVar) {
      try {
        (node as SceneNode & { setBoundVariable(f: string, v: Variable | null): void })
          .setBoundVariable(field, localVar);
        result.variablesRelinked++;
      } catch { /* field may not support variable binding on this node type */ }
    } else if (!result.variablesMissing.includes(key)) {
      result.variablesMissing.push(key);
    }
  }
}

function relinkPaintVars(
  paints: readonly Paint[],
  maps: LocalMaps,
  result: RelinkResult,
): Paint[] {
  return paints.map(paint => {
    if (!paint.boundVariables) return paint;
    let updated = paint;
    for (const pf of PAINT_VAR_FIELDS) {
      const alias = paint.boundVariables[pf];
      if (!alias || Array.isArray(alias)) continue;
      const a = alias as VariableAlias;
      if (maps.localVarIds.has(a.id)) continue;
      const donorVar = resolveAlias(a);
      if (!donorVar) continue;
      const key = getVarKey(donorVar);
      const localVar = maps.variables.get(key);
      if (localVar) {
        try {
          updated = figma.variables.setBoundVariableForPaint(updated, pf, localVar);
          result.variablesRelinked++;
        } catch { /* unsupported paint field */ }
      } else if (!result.variablesMissing.includes(key)) {
        result.variablesMissing.push(key);
      }
    }
    return updated;
  });
}

function relinkNode(node: SceneNode, maps: LocalMaps, result: RelinkResult): void {
  result.nodesProcessed++;

  relinkStyles(node, maps, result);
  relinkScalarVars(node, maps, result);

  if ('fills' in node && node.fills !== figma.mixed) {
    (node as GeometryMixin).fills = relinkPaintVars(node.fills as Paint[], maps, result);
  }
  if ('strokes' in node) {
    (node as GeometryMixin).strokes = relinkPaintVars((node as GeometryMixin).strokes as Paint[], maps, result);
  }

  if (node.type === 'INSTANCE') {
    const inst = node as InstanceNode;
    const main = inst.mainComponent;
    if (main) {
      const setName = compSetName(main) ?? (inst.name !== main.name ? inst.name : null);
      const localComp = findLocalComponent(main.name, setName, maps.componentCache);
      if (localComp && localComp.key !== main.key) {
        inst.swapComponent(localComp);
        result.componentsSwapped++;
      } else if (!localComp) {
        const displayName = cleanName(setName ? `${setName} / ${main.name}` : main.name);
        if (!result.componentsMissing.includes(displayName)) {
          result.componentsMissing.push(displayName);
        }
      }
    }
    return; // don't recurse into instance children
  }

  if ('children' in node) {
    for (const child of (node as ChildrenMixin).children as SceneNode[]) {
      relinkNode(child, maps, result);
    }
  }
}

export function relinkSelection(): RelinkResult {
  const sel = figma.currentPage.selection;
  if (sel.length === 0) throw new Error('Select a frame or component first.');

  const maps = buildLocalMaps();
  const result: RelinkResult = {
    stylesRelinked: 0, stylesMissing: [],
    variablesRelinked: 0, variablesMissing: [],
    componentsSwapped: 0, componentsMissing: [],
    nodesProcessed: 0,
  };

  for (const node of sel) relinkNode(node as SceneNode, maps, result);
  return result;
}
