"use strict";
(() => {
  // src/relinker.ts
  function buildMaps() {
    var _a, _b;
    const paintStyles = /* @__PURE__ */ new Map();
    const textStyles = /* @__PURE__ */ new Map();
    const effectStyles = /* @__PURE__ */ new Map();
    const gridStyles = /* @__PURE__ */ new Map();
    const localStyleIds = /* @__PURE__ */ new Set();
    for (const s of figma.getLocalPaintStyles()) {
      paintStyles.set(s.name, s.id);
      localStyleIds.add(s.id);
    }
    for (const s of figma.getLocalTextStyles()) {
      textStyles.set(s.name, s.id);
      localStyleIds.add(s.id);
    }
    for (const s of figma.getLocalEffectStyles()) {
      effectStyles.set(s.name, s.id);
      localStyleIds.add(s.id);
    }
    for (const s of figma.getLocalGridStyles()) {
      gridStyles.set(s.name, s.id);
      localStyleIds.add(s.id);
    }
    const variables = /* @__PURE__ */ new Map();
    const localVarIds = /* @__PURE__ */ new Set();
    try {
      const colCache = /* @__PURE__ */ new Map();
      for (const v of figma.variables.getLocalVariables()) {
        let col = colCache.get(v.variableCollectionId);
        if (col === void 0) {
          col = (_b = (_a = figma.variables.getVariableCollectionById(v.variableCollectionId)) == null ? void 0 : _a.name) != null ? _b : "";
          colCache.set(v.variableCollectionId, col);
        }
        variables.set(`${col}/${v.name}`, v);
        localVarIds.add(v.id);
      }
    } catch (e) {
    }
    return {
      paintStyles,
      textStyles,
      effectStyles,
      gridStyles,
      localStyleIds,
      variables,
      localVarIds,
      compCache: /* @__PURE__ */ new Map()
    };
  }
  function getSetName(main, inst) {
    var _a;
    if (((_a = main.parent) == null ? void 0 : _a.type) === "COMPONENT_SET")
      return main.parent.name;
    return inst.name || null;
  }
  function getVariantProps(inst) {
    try {
      const cp = inst.componentProperties;
      if (!cp)
        return {};
      const out = {};
      for (const [k, p] of Object.entries(cp))
        if (p.type === "VARIANT" && typeof p.value === "string")
          out[k] = p.value;
      return out;
    } catch (e) {
      return {};
    }
  }
  function findLocalVariant(setName, variantProps, cache) {
    const cacheKey = `${setName}\0${JSON.stringify(Object.entries(variantProps).sort())}`;
    if (cache.has(cacheKey))
      return cache.get(cacheKey);
    const hasProps = Object.keys(variantProps).length > 0;
    let found = null;
    const pages = [figma.currentPage, ...figma.root.children.filter((p) => p !== figma.currentPage)];
    outer:
      for (const page of pages) {
        const result = page.findOne((n) => {
          var _a;
          if (n.type !== "COMPONENT")
            return false;
          if (((_a = n.parent) == null ? void 0 : _a.type) !== "COMPONENT_SET")
            return false;
          if (n.parent.name !== setName)
            return false;
          if (!hasProps)
            return true;
          const vp = n.variantProperties;
          if (!vp)
            return false;
          return Object.entries(variantProps).every(([k, v]) => vp[k] === v);
        });
        if (result) {
          found = result;
          break outer;
        }
      }
    cache.set(cacheKey, found);
    return found;
  }
  var STYLE_FIELDS = [
    { field: "fillStyleId", getMap: (m) => m.paintStyles },
    { field: "strokeStyleId", getMap: (m) => m.paintStyles },
    { field: "effectStyleId", getMap: (m) => m.effectStyles },
    { field: "textStyleId", getMap: (m) => m.textStyles },
    { field: "gridStyleId", getMap: (m) => m.gridStyles }
  ];
  function resolveVar(alias) {
    try {
      return figma.variables.getVariableById(alias.id);
    } catch (e) {
      return null;
    }
  }
  function varKey(v) {
    try {
      const col = figma.variables.getVariableCollectionById(v.variableCollectionId);
      return col ? `${col.name}/${v.name}` : v.name;
    } catch (e) {
      return v.name;
    }
  }
  var SCALAR_VAR_FIELDS = [
    "opacity",
    "cornerRadius",
    "topLeftRadius",
    "topRightRadius",
    "bottomLeftRadius",
    "bottomRightRadius",
    "itemSpacing",
    "paddingTop",
    "paddingBottom",
    "paddingLeft",
    "paddingRight",
    "strokeWeight",
    "minWidth",
    "maxWidth",
    "minHeight",
    "maxHeight",
    "counterAxisSpacing"
  ];
  var PAINT_VAR_FIELDS = ["color", "opacity", "visible"];
  function push(result, entry) {
    result.log.push(entry);
  }
  function relinkNode(node, maps, result) {
    result.nodesProcessed++;
    for (const { field, getMap } of STYLE_FIELDS) {
      if (!(field in node))
        continue;
      const rawId = node[field];
      if (!rawId || rawId === figma.mixed)
        continue;
      const id = rawId;
      if (maps.localStyleIds.has(id))
        continue;
      const style = figma.getStyleById(id);
      if (!style)
        continue;
      const localId = getMap(maps).get(style.name);
      if (localId) {
        try {
          node[field] = localId;
          result.stylesRelinked++;
          push(result, { status: "ok", category: "style", name: style.name });
        } catch (e) {
          const msg = `Style "${style.name}": ${e instanceof Error ? e.message : e}`;
          result.errors.push(msg);
          push(result, { status: "error", category: "style", name: style.name });
        }
      } else {
        if (!result.missing.includes(style.name))
          result.missing.push(style.name);
        push(result, { status: "missing", category: "style", name: style.name });
      }
    }
    if ("boundVariables" in node) {
      const bv = node.boundVariables;
      if (bv) {
        for (const f of SCALAR_VAR_FIELDS) {
          const alias = bv[f];
          if (!(alias == null ? void 0 : alias.id))
            continue;
          if (maps.localVarIds.has(alias.id))
            continue;
          const v = resolveVar(alias);
          if (!v)
            continue;
          const key = varKey(v);
          const localVar = maps.variables.get(key);
          if (localVar) {
            try {
              node.setBoundVariable(f, localVar);
              result.variablesRelinked++;
              push(result, { status: "ok", category: "variable", name: key });
            } catch (e) {
              const msg = `Variable "${key}": ${e instanceof Error ? e.message : e}`;
              result.errors.push(msg);
              push(result, { status: "error", category: "variable", name: key });
            }
          } else {
            if (!result.missing.includes(key))
              result.missing.push(key);
            push(result, { status: "missing", category: "variable", name: key });
          }
        }
      }
    }
    for (const prop of ["fills", "strokes"]) {
      if (!(prop in node))
        continue;
      const paints = node[prop];
      if (!paints || paints === figma.mixed)
        continue;
      let dirty = false;
      const newPaints = paints.map((paint) => {
        if (!paint.boundVariables)
          return paint;
        let p = paint;
        for (const pf of PAINT_VAR_FIELDS) {
          const alias = paint.boundVariables[pf];
          if (!alias || Array.isArray(alias))
            continue;
          const a = alias;
          if (maps.localVarIds.has(a.id))
            continue;
          const v = resolveVar(a);
          if (!v)
            continue;
          const key = varKey(v);
          const localVar = maps.variables.get(key);
          if (localVar) {
            try {
              p = figma.variables.setBoundVariableForPaint(p, pf, localVar);
              result.variablesRelinked++;
              dirty = true;
              push(result, { status: "ok", category: "variable", name: key });
            } catch (e) {
              result.errors.push(`Variable "${key}": ${e instanceof Error ? e.message : e}`);
              push(result, { status: "error", category: "variable", name: key });
            }
          } else {
            if (!result.missing.includes(key))
              result.missing.push(key);
            push(result, { status: "missing", category: "variable", name: key });
          }
        }
        return p;
      });
      if (dirty)
        node[prop] = newPaints;
    }
    if (node.type === "INSTANCE") {
      const inst = node;
      const main = inst.mainComponent;
      if (main) {
        const setName = getSetName(main, inst);
        if (setName) {
          const variantProps = getVariantProps(inst);
          const local = findLocalVariant(setName, variantProps, maps.compCache);
          const display = Object.keys(variantProps).length > 0 ? `${setName} / ${Object.entries(variantProps).map(([k, v]) => `${k}=${v}`).join(", ")}` : setName;
          if (local && local.key !== main.key) {
            try {
              inst.swapComponent(local);
              result.componentsSwapped++;
              push(result, { status: "ok", category: "component", name: display });
            } catch (e) {
              result.errors.push(`Component "${display}": ${e instanceof Error ? e.message : e}`);
              push(result, { status: "error", category: "component", name: display });
            }
          } else if (!local) {
            if (!result.missing.includes(display))
              result.missing.push(display);
            push(result, { status: "missing", category: "component", name: display });
          }
        }
      }
    }
    if ("children" in node) {
      for (const child of node.children)
        relinkNode(child, maps, result);
    }
  }
  function relinkSelection() {
    const sel = figma.currentPage.selection;
    if (sel.length === 0)
      throw new Error("Select a frame or component first.");
    const maps = buildMaps();
    const result = {
      stylesRelinked: 0,
      variablesRelinked: 0,
      componentsSwapped: 0,
      missing: [],
      errors: [],
      log: [],
      nodesProcessed: 0
    };
    for (const node of sel)
      relinkNode(node, maps, result);
    return result;
  }

  // src/code.ts
  figma.showUI(__html__, { width: 360, height: 520, title: "Relinker" });
  function send(msg) {
    figma.ui.postMessage(msg);
  }
  function pushSelectionInfo() {
    const sel = figma.currentPage.selection;
    send(sel.length === 0 ? { type: "selection-info", hasSelection: false, name: "", nodeType: "" } : { type: "selection-info", hasSelection: true, name: sel[0].name, nodeType: sel[0].type });
  }
  figma.on("selectionchange", pushSelectionInfo);
  figma.ui.onmessage = (msg) => {
    try {
      switch (msg.type) {
        case "get-selection-info":
          pushSelectionInfo();
          break;
        case "relink-selection":
          send({ type: "relink-result", result: relinkSelection() });
          break;
        case "close":
          figma.closePlugin();
          break;
      }
    } catch (err) {
      send({ type: "error", message: err instanceof Error ? err.message : String(err) });
    }
  };
})();
