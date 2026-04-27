"use strict";
(() => {
  // src/relinker.ts
  function buildLocalMaps() {
    var _a, _b;
    const styles = /* @__PURE__ */ new Map();
    const styleTypeById = /* @__PURE__ */ new Map();
    const localStyleIds = /* @__PURE__ */ new Set();
    const allStyles = [
      ...figma.getLocalPaintStyles().map((s) => ({ s, t: "PAINT" })),
      ...figma.getLocalTextStyles().map((s) => ({ s, t: "TEXT" })),
      ...figma.getLocalEffectStyles().map((s) => ({ s, t: "EFFECT" })),
      ...figma.getLocalGridStyles().map((s) => ({ s, t: "GRID" }))
    ];
    for (const { s, t } of allStyles) {
      styles.set(s.name, s.id);
      styleTypeById.set(s.id, t);
      localStyleIds.add(s.id);
    }
    const variables = /* @__PURE__ */ new Map();
    const localVarIds = /* @__PURE__ */ new Set();
    try {
      const colNameCache = /* @__PURE__ */ new Map();
      for (const v of figma.variables.getLocalVariables()) {
        let colName = colNameCache.get(v.variableCollectionId);
        if (colName === void 0) {
          colName = (_b = (_a = figma.variables.getVariableCollectionById(v.variableCollectionId)) == null ? void 0 : _a.name) != null ? _b : "";
          colNameCache.set(v.variableCollectionId, colName);
        }
        variables.set(`${colName}/${v.name}`, v);
        localVarIds.add(v.id);
      }
    } catch (e) {
    }
    const componentCache = /* @__PURE__ */ new Map();
    return { styles, styleTypeById, localStyleIds, variables, localVarIds, componentCache };
  }
  function compSetName(comp) {
    var _a;
    return ((_a = comp.parent) == null ? void 0 : _a.type) === "COMPONENT_SET" ? comp.parent.name : null;
  }
  function compCacheKey(variantName, setName) {
    return setName ? `${setName}/${variantName}` : variantName;
  }
  function findLocalComponent(variantName, setName, cache) {
    const key = compCacheKey(variantName, setName);
    if (cache.has(key))
      return cache.get(key);
    let found = null;
    const pages = [figma.currentPage, ...figma.root.children.filter((p) => p !== figma.currentPage)];
    for (const page of pages) {
      if (setName) {
        found = page.findOne(
          (n) => {
            var _a;
            return n.type === "COMPONENT" && n.name === variantName && ((_a = n.parent) == null ? void 0 : _a.type) === "COMPONENT_SET" && n.parent.name === setName;
          }
        );
      } else {
        found = page.findOne(
          (n) => {
            var _a;
            return n.type === "COMPONENT" && n.name === variantName && ((_a = n.parent) == null ? void 0 : _a.type) !== "COMPONENT_SET";
          }
        );
      }
      if (found)
        break;
    }
    cache.set(key, found);
    return found;
  }
  function cleanName(name) {
    return name.replace(/[❖◆◇▾▸]/g, "").replace(/\s{2,}/g, " ").trim();
  }
  function getStyleName(styleId) {
    var _a, _b;
    try {
      return (_b = (_a = figma.getStyleById(styleId)) == null ? void 0 : _a.name) != null ? _b : null;
    } catch (e) {
      return null;
    }
  }
  var STYLE_FIELDS = [
    "fillStyleId",
    "strokeStyleId",
    "effectStyleId",
    "textStyleId",
    "gridStyleId"
  ];
  function getVarKey(v) {
    try {
      const col = figma.variables.getVariableCollectionById(v.variableCollectionId);
      return col ? `${col.name}/${v.name}` : v.name;
    } catch (e) {
      return v.name;
    }
  }
  function resolveAlias(alias) {
    try {
      return figma.variables.getVariableById(alias.id);
    } catch (e) {
      return null;
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
  function scanNode(node, maps, styles, variables, components, counter) {
    var _a, _b;
    counter.n++;
    for (const field of STYLE_FIELDS) {
      if (!(field in node))
        continue;
      const rawId = node[field];
      if (!rawId || rawId === figma.mixed)
        continue;
      const id = rawId;
      if (maps.localStyleIds.has(id) || styles.has(id))
        continue;
      const name = getStyleName(id);
      if (!name)
        continue;
      styles.set(id, {
        name,
        styleType: (_a = maps.styleTypeById.get(id)) != null ? _a : "STYLE",
        hasLocal: maps.styles.has(name)
      });
    }
    if ("boundVariables" in node) {
      const bv = node.boundVariables;
      if (bv) {
        for (const field of SCALAR_VAR_FIELDS) {
          const alias = bv[field];
          if (!alias || !("id" in alias))
            continue;
          if (maps.localVarIds.has(alias.id))
            continue;
          const v = resolveAlias(alias);
          if (!v)
            continue;
          const key = getVarKey(v);
          if (!variables.has(key))
            variables.set(key, { key, hasLocal: maps.variables.has(key) });
        }
      }
    }
    for (const prop of ["fills", "strokes"]) {
      if (!(prop in node))
        continue;
      const paints = node[prop];
      if (!paints || paints === figma.mixed)
        continue;
      for (const paint of paints) {
        if (!paint.boundVariables)
          continue;
        for (const pf of PAINT_VAR_FIELDS) {
          const alias = paint.boundVariables[pf];
          if (!alias || Array.isArray(alias))
            continue;
          if (maps.localVarIds.has(alias.id))
            continue;
          const v = resolveAlias(alias);
          if (!v)
            continue;
          const key = getVarKey(v);
          if (!variables.has(key))
            variables.set(key, { key, hasLocal: maps.variables.has(key) });
        }
      }
    }
    if (node.type === "INSTANCE") {
      const inst = node;
      const main = inst.mainComponent;
      if (main) {
        const setName = (_b = compSetName(main)) != null ? _b : inst.name !== main.name ? inst.name : null;
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
      return;
    }
    if ("children" in node) {
      for (const child of node.children) {
        scanNode(child, maps, styles, variables, components, counter);
      }
    }
  }
  function scanSelection() {
    const sel = figma.currentPage.selection;
    if (sel.length === 0)
      throw new Error("Select a frame or component first.");
    const maps = buildLocalMaps();
    const stylesMap = /* @__PURE__ */ new Map();
    const variablesMap = /* @__PURE__ */ new Map();
    const componentsMap = /* @__PURE__ */ new Map();
    const counter = { n: 0 };
    for (const node of sel) {
      scanNode(node, maps, stylesMap, variablesMap, componentsMap, counter);
    }
    return {
      styles: Array.from(stylesMap.values()),
      variables: Array.from(variablesMap.values()),
      components: Array.from(componentsMap.values()),
      nodesScanned: counter.n
    };
  }
  function relinkStyles(node, maps, result) {
    for (const field of STYLE_FIELDS) {
      if (!(field in node))
        continue;
      const rawId = node[field];
      if (!rawId || rawId === figma.mixed)
        continue;
      const id = rawId;
      if (maps.localStyleIds.has(id))
        continue;
      const name = getStyleName(id);
      if (!name)
        continue;
      const localId = maps.styles.get(name);
      if (localId) {
        node[field] = localId;
        result.stylesRelinked++;
      } else if (!result.stylesMissing.includes(name)) {
        result.stylesMissing.push(name);
      }
    }
  }
  function relinkScalarVars(node, maps, result) {
    if (!("boundVariables" in node))
      return;
    const bv = node.boundVariables;
    if (!bv)
      return;
    for (const field of SCALAR_VAR_FIELDS) {
      const alias = bv[field];
      if (!alias || !("id" in alias))
        continue;
      if (maps.localVarIds.has(alias.id))
        continue;
      const donorVar = resolveAlias(alias);
      if (!donorVar)
        continue;
      const key = getVarKey(donorVar);
      const localVar = maps.variables.get(key);
      if (localVar) {
        try {
          node.setBoundVariable(field, localVar);
          result.variablesRelinked++;
        } catch (e) {
        }
      } else if (!result.variablesMissing.includes(key)) {
        result.variablesMissing.push(key);
      }
    }
  }
  function relinkPaintVars(paints, maps, result) {
    return paints.map((paint) => {
      if (!paint.boundVariables)
        return paint;
      let updated = paint;
      for (const pf of PAINT_VAR_FIELDS) {
        const alias = paint.boundVariables[pf];
        if (!alias || Array.isArray(alias))
          continue;
        const a = alias;
        if (maps.localVarIds.has(a.id))
          continue;
        const donorVar = resolveAlias(a);
        if (!donorVar)
          continue;
        const key = getVarKey(donorVar);
        const localVar = maps.variables.get(key);
        if (localVar) {
          try {
            updated = figma.variables.setBoundVariableForPaint(updated, pf, localVar);
            result.variablesRelinked++;
          } catch (e) {
          }
        } else if (!result.variablesMissing.includes(key)) {
          result.variablesMissing.push(key);
        }
      }
      return updated;
    });
  }
  function relinkNode(node, maps, result) {
    var _a;
    result.nodesProcessed++;
    relinkStyles(node, maps, result);
    relinkScalarVars(node, maps, result);
    if ("fills" in node && node.fills !== figma.mixed) {
      node.fills = relinkPaintVars(node.fills, maps, result);
    }
    if ("strokes" in node) {
      node.strokes = relinkPaintVars(node.strokes, maps, result);
    }
    if (node.type === "INSTANCE") {
      const inst = node;
      const main = inst.mainComponent;
      if (main) {
        const setName = (_a = compSetName(main)) != null ? _a : inst.name !== main.name ? inst.name : null;
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
      return;
    }
    if ("children" in node) {
      for (const child of node.children) {
        relinkNode(child, maps, result);
      }
    }
  }
  function relinkSelection() {
    const sel = figma.currentPage.selection;
    if (sel.length === 0)
      throw new Error("Select a frame or component first.");
    const maps = buildLocalMaps();
    const result = {
      stylesRelinked: 0,
      stylesMissing: [],
      variablesRelinked: 0,
      variablesMissing: [],
      componentsSwapped: 0,
      componentsMissing: [],
      nodesProcessed: 0
    };
    for (const node of sel)
      relinkNode(node, maps, result);
    return result;
  }

  // src/code.ts
  figma.showUI(__html__, { width: 360, height: 480, title: "Import Forge" });
  function send(msg) {
    figma.ui.postMessage(msg);
  }
  function pushSelectionInfo() {
    const sel = figma.currentPage.selection;
    if (sel.length === 0) {
      send({ type: "selection-info", hasSelection: false, name: "", nodeType: "" });
    } else {
      send({ type: "selection-info", hasSelection: true, name: sel[0].name, nodeType: sel[0].type });
    }
  }
  figma.on("selectionchange", pushSelectionInfo);
  figma.ui.onmessage = (msg) => {
    try {
      switch (msg.type) {
        case "get-selection-info":
          pushSelectionInfo();
          break;
        case "scan-selection":
          send({ type: "scan-result", result: scanSelection() });
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
