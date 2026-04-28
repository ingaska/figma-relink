"use strict";
(() => {
  var __defProp = Object.defineProperty;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __getOwnPropSymbols = Object.getOwnPropertySymbols;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __propIsEnum = Object.prototype.propertyIsEnumerable;
  var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
  var __spreadValues = (a, b) => {
    for (var prop in b || (b = {}))
      if (__hasOwnProp.call(b, prop))
        __defNormalProp(a, prop, b[prop]);
    if (__getOwnPropSymbols)
      for (var prop of __getOwnPropSymbols(b)) {
        if (__propIsEnum.call(b, prop))
          __defNormalProp(a, prop, b[prop]);
      }
    return a;
  };
  var __esm = (fn, res) => function __init() {
    return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
  };
  var __commonJS = (cb, mod) => function __require() {
    return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
  };
  var __async = (__this, __arguments, generator) => {
    return new Promise((resolve, reject) => {
      var fulfilled = (value) => {
        try {
          step(generator.next(value));
        } catch (e) {
          reject(e);
        }
      };
      var rejected = (value) => {
        try {
          step(generator.throw(value));
        } catch (e) {
          reject(e);
        }
      };
      var step = (x) => x.done ? resolve(x.value) : Promise.resolve(x.value).then(fulfilled, rejected);
      step((generator = generator.apply(__this, __arguments)).next());
    });
  };

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
    return { paintStyles, textStyles, effectStyles, gridStyles, localStyleIds, variables, localVarIds, compCache: /* @__PURE__ */ new Map() };
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
    const key = `${setName}\0${JSON.stringify(Object.entries(variantProps).sort())}`;
    if (cache.has(key))
      return cache.get(key);
    const hasProps = Object.keys(variantProps).length > 0;
    let found = null;
    const pages = [figma.currentPage, ...figma.root.children.filter((p) => p !== figma.currentPage)];
    outer:
      for (const page of pages) {
        const r = page.findOne((n) => {
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
        if (r) {
          found = r;
          break outer;
        }
      }
    cache.set(key, found);
    return found;
  }
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
  function processNode(node, maps, stats, missingItems, errorItems) {
    const entries = [];
    const log = (e) => entries.push(e);
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
          stats.relinked++;
          log({ status: "ok", category: "style", name: style.name });
        } catch (e) {
          const m = `Style "${style.name}": ${e instanceof Error ? e.message : e}`;
          if (!errorItems.includes(m))
            errorItems.push(m);
          stats.errors++;
          log({ status: "error", category: "style", name: style.name });
        }
      } else {
        if (!missingItems.includes(style.name)) {
          missingItems.push(style.name);
          stats.missing++;
          log({ status: "missing", category: "style", name: style.name });
        }
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
              stats.relinked++;
              log({ status: "ok", category: "variable", name: key });
            } catch (e) {
              const m = `Var "${key}": ${e instanceof Error ? e.message : e}`;
              if (!errorItems.includes(m))
                errorItems.push(m);
              stats.errors++;
              log({ status: "error", category: "variable", name: key });
            }
          } else {
            if (!missingItems.includes(key)) {
              missingItems.push(key);
              stats.missing++;
              log({ status: "missing", category: "variable", name: key });
            }
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
              stats.relinked++;
              dirty = true;
              log({ status: "ok", category: "variable", name: key });
            } catch (e) {
              const m = `Var "${key}": ${e instanceof Error ? e.message : e}`;
              if (!errorItems.includes(m))
                errorItems.push(m);
              stats.errors++;
              log({ status: "error", category: "variable", name: key });
            }
          } else {
            if (!missingItems.includes(key)) {
              missingItems.push(key);
              stats.missing++;
              log({ status: "missing", category: "variable", name: key });
            }
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
          const vp = getVariantProps(inst);
          const display = Object.keys(vp).length > 0 ? `${setName} / ${Object.entries(vp).map(([k, v]) => `${k}=${v}`).join(", ")}` : setName;
          const local = findLocalVariant(setName, vp, maps.compCache);
          if (local && local.key !== main.key) {
            try {
              inst.swapComponent(local);
              stats.relinked++;
              log({ status: "ok", category: "component", name: display });
            } catch (e) {
              const m = `Comp "${display}": ${e instanceof Error ? e.message : e}`;
              if (!errorItems.includes(m))
                errorItems.push(m);
              stats.errors++;
              log({ status: "error", category: "component", name: display });
            }
          } else if (!local) {
            if (!missingItems.includes(display)) {
              missingItems.push(display);
              stats.missing++;
              log({ status: "missing", category: "component", name: display });
            }
          }
        }
      }
    }
    return entries;
  }
  function relinkSelectionStreaming(onProgress, isStopped) {
    return __async(this, null, function* () {
      const sel = figma.currentPage.selection;
      if (sel.length === 0)
        throw new Error("Select a frame or component first.");
      const maps = buildMaps();
      const stats = { relinked: 0, missing: 0, errors: 0, processed: 0 };
      const missingItems = [];
      const errorItems = [];
      const stack = [...sel].reverse();
      let batchEntries = [];
      let batchCount = 0;
      while (stack.length > 0 && !isStopped()) {
        const node = stack.pop();
        stats.processed++;
        const entries = processNode(node, maps, stats, missingItems, errorItems);
        batchEntries.push(...entries);
        if ("children" in node) {
          const children = node.children;
          for (let i = children.length - 1; i >= 0; i--)
            stack.push(children[i]);
        }
        batchCount++;
        if (batchCount >= BATCH) {
          batchCount = 0;
          if (batchEntries.length > 0) {
            onProgress([...batchEntries], __spreadValues({}, stats));
            batchEntries = [];
          }
          yield tick();
        }
      }
      if (batchEntries.length > 0)
        onProgress([...batchEntries], __spreadValues({}, stats));
      return { stats, missingItems, errorItems, stopped: isStopped() };
    });
  }
  var tick, STYLE_FIELDS, SCALAR_VAR_FIELDS, PAINT_VAR_FIELDS, BATCH;
  var init_relinker = __esm({
    "src/relinker.ts"() {
      "use strict";
      tick = () => new Promise((r) => setTimeout(r, 0));
      STYLE_FIELDS = [
        { field: "fillStyleId", getMap: (m) => m.paintStyles },
        { field: "strokeStyleId", getMap: (m) => m.paintStyles },
        { field: "effectStyleId", getMap: (m) => m.effectStyles },
        { field: "textStyleId", getMap: (m) => m.textStyles },
        { field: "gridStyleId", getMap: (m) => m.gridStyles }
      ];
      SCALAR_VAR_FIELDS = [
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
      PAINT_VAR_FIELDS = ["color", "opacity", "visible"];
      BATCH = 12;
    }
  });

  // src/code.ts
  var require_code = __commonJS({
    "src/code.ts"(exports) {
      init_relinker();
      figma.showUI(__html__, { width: 360, height: 520, title: "Relinker" });
      function send(msg) {
        figma.ui.postMessage(msg);
      }
      function pushSelectionInfo() {
        const sel = figma.currentPage.selection;
        send(sel.length === 0 ? { type: "selection-info", hasSelection: false, name: "", nodeType: "" } : { type: "selection-info", hasSelection: true, name: sel[0].name, nodeType: sel[0].type });
      }
      figma.on("selectionchange", pushSelectionInfo);
      var stopFlag = false;
      figma.ui.onmessage = (msg) => __async(exports, null, function* () {
        try {
          switch (msg.type) {
            case "get-selection-info":
              pushSelectionInfo();
              break;
            case "stop-relink":
              stopFlag = true;
              break;
            case "relink-selection":
              stopFlag = false;
              send({ type: "relink-start" });
              const result = yield relinkSelectionStreaming(
                (entries, stats) => send({ type: "relink-progress", entries, stats }),
                () => stopFlag
              );
              send({ type: "relink-done", result });
              break;
            case "close":
              figma.closePlugin();
              break;
          }
        } catch (err) {
          send({ type: "error", message: err instanceof Error ? err.message : String(err) });
        }
      });
    }
  });
  require_code();
})();
