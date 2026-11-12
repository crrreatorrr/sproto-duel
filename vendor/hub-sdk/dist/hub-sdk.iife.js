/*! @metaverse/hub-sdk 0.7.2 IIFE global HubSDK. Built from packages/hub-sdk/src. Not a CDN import. */
"use strict";
var HubSDK = (() => {
  var __defProp = Object.defineProperty;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __esm = (fn, res, err) => function __init() {
    if (err) throw err[0];
    try {
      return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
    } catch (e) {
      throw err = [e], e;
    }
  };
  var __export = (target, all) => {
    for (var name in all)
      __defProp(target, name, { get: all[name], enumerable: true });
  };
  var __copyProps = (to, from, except, desc) => {
    if (from && typeof from === "object" || typeof from === "function") {
      for (let key of __getOwnPropNames(from))
        if (!__hasOwnProp.call(to, key) && key !== except)
          __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
    }
    return to;
  };
  var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

  // packages/hub-sdk/src/third_party/modern-screenshot.js
  var modern_screenshot_exports = {};
  __export(modern_screenshot_exports, {
    createContext: () => createContext,
    destroyContext: () => destroyContext,
    domToBlob: () => domToBlob,
    domToCanvas: () => domToCanvas,
    domToDataUrl: () => domToDataUrl,
    domToForeignObjectSvg: () => domToForeignObjectSvg,
    domToImage: () => domToImage,
    domToJpeg: () => domToJpeg,
    domToPixel: () => domToPixel,
    domToPng: () => domToPng,
    domToSvg: () => domToSvg,
    domToWebp: () => domToWebp,
    loadMedia: () => loadMedia,
    waitUntilLoad: () => waitUntilLoad
  });
  function changeJpegDpi(uint8Array, dpi) {
    uint8Array[13] = 1;
    uint8Array[14] = dpi >> 8;
    uint8Array[15] = dpi & 255;
    uint8Array[16] = dpi >> 8;
    uint8Array[17] = dpi & 255;
    return uint8Array;
  }
  function createPngDataTable() {
    const crcTable = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) {
        c = c & 1 ? 3988292384 ^ c >>> 1 : c >>> 1;
      }
      crcTable[n] = c;
    }
    return crcTable;
  }
  function calcCrc(uint8Array) {
    let c = -1;
    if (!pngDataTable)
      pngDataTable = createPngDataTable();
    for (let n = 0; n < uint8Array.length; n++) {
      c = pngDataTable[(c ^ uint8Array[n]) & 255] ^ c >>> 8;
    }
    return c ^ -1;
  }
  function searchStartOfPhys(uint8Array) {
    const length = uint8Array.length - 1;
    for (let i = length; i >= 4; i--) {
      if (uint8Array[i - 4] === 9 && uint8Array[i - 3] === _P && uint8Array[i - 2] === _H && uint8Array[i - 1] === _Y && uint8Array[i] === _S) {
        return i - 3;
      }
    }
    return 0;
  }
  function changePngDpi(uint8Array, dpi, overwritepHYs = false) {
    const physChunk = new Uint8Array(13);
    dpi *= 39.3701;
    physChunk[0] = _P;
    physChunk[1] = _H;
    physChunk[2] = _Y;
    physChunk[3] = _S;
    physChunk[4] = dpi >>> 24;
    physChunk[5] = dpi >>> 16;
    physChunk[6] = dpi >>> 8;
    physChunk[7] = dpi & 255;
    physChunk[8] = physChunk[4];
    physChunk[9] = physChunk[5];
    physChunk[10] = physChunk[6];
    physChunk[11] = physChunk[7];
    physChunk[12] = 1;
    const crc = calcCrc(physChunk);
    const crcChunk = new Uint8Array(4);
    crcChunk[0] = crc >>> 24;
    crcChunk[1] = crc >>> 16;
    crcChunk[2] = crc >>> 8;
    crcChunk[3] = crc & 255;
    if (overwritepHYs) {
      const startingIndex = searchStartOfPhys(uint8Array);
      uint8Array.set(physChunk, startingIndex);
      uint8Array.set(crcChunk, startingIndex + 13);
      return uint8Array;
    } else {
      const chunkLength = new Uint8Array(4);
      chunkLength[0] = 0;
      chunkLength[1] = 0;
      chunkLength[2] = 0;
      chunkLength[3] = 9;
      const finalHeader = new Uint8Array(54);
      finalHeader.set(uint8Array, 0);
      finalHeader.set(chunkLength, 33);
      finalHeader.set(physChunk, 37);
      finalHeader.set(crcChunk, 50);
      return finalHeader;
    }
  }
  function detectPhysChunkFromDataUrl(dataUrl) {
    let b64index = dataUrl.indexOf(b64PhysSignature1);
    if (b64index === -1) {
      b64index = dataUrl.indexOf(b64PhysSignature2);
    }
    if (b64index === -1) {
      b64index = dataUrl.indexOf(b64PhysSignature3);
    }
    return b64index;
  }
  function supportWebp(ownerDocument) {
    const canvas = ownerDocument?.createElement?.("canvas");
    if (canvas) {
      canvas.height = canvas.width = 1;
    }
    return Boolean(canvas) && "toDataURL" in canvas && Boolean(canvas.toDataURL("image/webp").includes("image/webp"));
  }
  function resolveUrl(url, baseUrl) {
    if (url.match(/^[a-z]+:\/\//i))
      return url;
    if (IN_BROWSER && url.match(/^\/\//))
      return window.location.protocol + url;
    if (url.match(/^[a-z]+:/i))
      return url;
    if (!IN_BROWSER)
      return url;
    const doc = getDocument().implementation.createHTMLDocument();
    const base = doc.createElement("base");
    const a = doc.createElement("a");
    doc.head.appendChild(base);
    doc.body.appendChild(a);
    if (baseUrl)
      base.href = baseUrl;
    a.href = url;
    return a.href;
  }
  function getDocument(target) {
    return (target && isElementNode(target) ? target?.ownerDocument : target) ?? window.document;
  }
  function createSvg(width, height, ownerDocument) {
    const svg = getDocument(ownerDocument).createElementNS(XMLNS, "svg");
    svg.setAttributeNS(null, "width", width.toString());
    svg.setAttributeNS(null, "height", height.toString());
    svg.setAttributeNS(null, "viewBox", `0 0 ${width} ${height}`);
    return svg;
  }
  function svgToDataUrl(svg, removeControlCharacter) {
    let xhtml = new XMLSerializer().serializeToString(svg);
    if (removeControlCharacter) {
      xhtml = xhtml.replace(/[\u0000-\u0008\v\f\u000E-\u001F\uD800-\uDFFF\uFFFE\uFFFF]/gu, "");
    }
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(xhtml)}`;
  }
  async function canvasToBlob(canvas, type = "image/png", quality = 1) {
    try {
      return await new Promise((resolve, reject) => {
        canvas.toBlob((blob) => {
          if (blob) {
            resolve(blob);
          } else {
            reject(new Error("Blob is null"));
          }
        }, type, quality);
      });
    } catch (error) {
      if (SUPPORT_ATOB) {
        return dataUrlToBlob(canvas.toDataURL(type, quality));
      }
      throw error;
    }
  }
  function dataUrlToBlob(dataUrl) {
    const [header, base64] = dataUrl.split(",");
    const type = header.match(/data:(.+);/)?.[1] ?? void 0;
    const decoded = window.atob(base64);
    const length = decoded.length;
    const buffer = new Uint8Array(length);
    for (let i = 0; i < length; i += 1) {
      buffer[i] = decoded.charCodeAt(i);
    }
    return new Blob([buffer], { type });
  }
  function readBlob(blob, type) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.onabort = () => reject(new Error(`Failed read blob to ${type}`));
      if (type === "dataUrl") {
        reader.readAsDataURL(blob);
      } else if (type === "arrayBuffer") {
        reader.readAsArrayBuffer(blob);
      }
    });
  }
  function createImage(url, ownerDocument) {
    const img = getDocument(ownerDocument).createElement("img");
    img.decoding = "sync";
    img.loading = "eager";
    img.src = url;
    return img;
  }
  function loadMedia(media, options) {
    return new Promise((resolve) => {
      const { timeout, ownerDocument, onError: userOnError, onWarn } = options ?? {};
      const node = typeof media === "string" ? createImage(media, getDocument(ownerDocument)) : media;
      let timer = null;
      let removeEventListeners = null;
      function onResolve() {
        resolve(node);
        timer && clearTimeout(timer);
        removeEventListeners?.();
      }
      if (timeout) {
        timer = setTimeout(onResolve, timeout);
      }
      if (isVideoElement(node)) {
        const currentSrc = node.currentSrc || node.src;
        if (!currentSrc) {
          if (node.poster) {
            return loadMedia(node.poster, options).then(resolve);
          }
          return onResolve();
        }
        if (node.readyState >= 2) {
          return onResolve();
        }
        const onLoadeddata = onResolve;
        const onError = (error) => {
          onWarn?.(
            "Failed video load",
            currentSrc,
            error
          );
          userOnError?.(error);
          onResolve();
        };
        removeEventListeners = () => {
          node.removeEventListener("loadeddata", onLoadeddata);
          node.removeEventListener("error", onError);
        };
        node.addEventListener("loadeddata", onLoadeddata, { once: true });
        node.addEventListener("error", onError, { once: true });
      } else {
        const currentSrc = isSVGImageElementNode(node) ? node.href.baseVal : node.currentSrc || node.src;
        if (!currentSrc) {
          return onResolve();
        }
        const onLoad = async () => {
          if (isImageElement(node) && "decode" in node) {
            try {
              await node.decode();
            } catch (error) {
              onWarn?.(
                "Failed to decode image, trying to render anyway",
                node.dataset.originalSrc || currentSrc,
                error
              );
            }
          }
          onResolve();
        };
        const onError = (error) => {
          onWarn?.(
            "Failed image load",
            node.dataset.originalSrc || currentSrc,
            error
          );
          onResolve();
        };
        if (isImageElement(node) && node.complete) {
          return onLoad();
        }
        removeEventListeners = () => {
          node.removeEventListener("load", onLoad);
          node.removeEventListener("error", onError);
        };
        node.addEventListener("load", onLoad, { once: true });
        node.addEventListener("error", onError, { once: true });
      }
    });
  }
  async function waitUntilLoad(node, options) {
    if (isHTMLElementNode(node)) {
      if (isImageElement(node) || isVideoElement(node)) {
        await loadMedia(node, options);
      } else {
        await Promise.all(
          ["img", "video"].flatMap((selectors) => {
            return Array.from(node.querySelectorAll(selectors)).map((el) => loadMedia(el, options));
          })
        );
      }
    }
  }
  function splitFontFamily(fontFamily) {
    return fontFamily?.split(",").map((val) => val.trim().replace(/"|'/g, "").toLowerCase()).filter(Boolean);
  }
  function createLogger(debug) {
    const prefix = `${PREFIX}[#${uid}]`;
    uid++;
    return {
      // eslint-disable-next-line no-console
      time: (label) => debug && console.time(`${prefix} ${label}`),
      // eslint-disable-next-line no-console
      timeEnd: (label) => debug && console.timeEnd(`${prefix} ${label}`),
      warn: (...args) => debug && consoleWarn(...args)
    };
  }
  function getDefaultRequestInit(bypassingCache) {
    return {
      cache: bypassingCache ? "no-cache" : "force-cache"
    };
  }
  async function orCreateContext(node, options) {
    return isContext(node) ? node : createContext(node, { ...options, autoDestruct: true });
  }
  async function createContext(node, options) {
    const { scale = 1, workerUrl, workerNumber = 1 } = options || {};
    const debug = Boolean(options?.debug);
    const features = options?.features ?? true;
    const ownerDocument = node.ownerDocument ?? (IN_BROWSER ? window.document : void 0);
    const ownerWindow = node.ownerDocument?.defaultView ?? (IN_BROWSER ? window : void 0);
    const requests = /* @__PURE__ */ new Map();
    const context = {
      // Options
      width: 0,
      height: 0,
      quality: 1,
      type: "image/png",
      scale,
      backgroundColor: null,
      style: null,
      filter: null,
      maximumCanvasSize: 0,
      timeout: 3e4,
      progress: null,
      debug,
      fetch: {
        requestInit: getDefaultRequestInit(options?.fetch?.bypassingCache),
        placeholderImage: "data:image/png;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
        bypassingCache: false,
        ...options?.fetch
      },
      fetchFn: null,
      font: {},
      drawImageInterval: 100,
      workerUrl: null,
      workerNumber,
      onCloneEachNode: null,
      onCloneNode: null,
      onEmbedNode: null,
      onCreateForeignObjectSvg: null,
      includeStyleProperties: null,
      autoDestruct: false,
      ...options,
      // InternalContext
      __CONTEXT__: true,
      log: createLogger(debug),
      node,
      ownerDocument,
      ownerWindow,
      dpi: scale === 1 ? null : 96 * scale,
      svgStyleElement: createStyleElement(ownerDocument),
      svgDefsElement: ownerDocument?.createElementNS(XMLNS, "defs"),
      svgStyles: /* @__PURE__ */ new Map(),
      defaultComputedStyles: /* @__PURE__ */ new Map(),
      workers: [
        ...Array.from({
          length: SUPPORT_WEB_WORKER && workerUrl && workerNumber ? workerNumber : 0
        })
      ].map(() => {
        try {
          const worker = new Worker(workerUrl);
          worker.onmessage = async (event) => {
            const { url, result } = event.data;
            if (result) {
              requests.get(url)?.resolve?.(result);
            } else {
              requests.get(url)?.reject?.(new Error(`Error receiving message from worker: ${url}`));
            }
          };
          worker.onmessageerror = (event) => {
            const { url } = event.data;
            requests.get(url)?.reject?.(new Error(`Error receiving message from worker: ${url}`));
          };
          return worker;
        } catch (error) {
          context.log.warn("Failed to new Worker", error);
          return null;
        }
      }).filter(Boolean),
      fontFamilies: /* @__PURE__ */ new Map(),
      fontCssTexts: /* @__PURE__ */ new Map(),
      acceptOfImage: `${[
        supportWebp(ownerDocument) && "image/webp",
        "image/svg+xml",
        "image/*",
        "*/*"
      ].filter(Boolean).join(",")};q=0.8`,
      requests,
      drawImageCount: 0,
      tasks: [],
      features,
      isEnable: (key) => {
        if (key === "restoreScrollPosition") {
          return typeof features === "boolean" ? false : features[key] ?? false;
        }
        if (typeof features === "boolean") {
          return features;
        }
        return features[key] ?? true;
      },
      shadowRoots: []
    };
    context.log.time("wait until load");
    await waitUntilLoad(node, { timeout: context.timeout, onWarn: context.log.warn });
    context.log.timeEnd("wait until load");
    const { width, height } = resolveBoundingBox(node, context);
    context.width = width;
    context.height = height;
    return context;
  }
  function createStyleElement(ownerDocument) {
    if (!ownerDocument)
      return void 0;
    const style = ownerDocument.createElement("style");
    const cssText = style.ownerDocument.createTextNode(`
.______background-clip--text {
  background-clip: text;
  -webkit-background-clip: text;
}
`);
    style.appendChild(cssText);
    return style;
  }
  function resolveBoundingBox(node, context) {
    let { width, height } = context;
    if (isElementNode(node) && (!width || !height)) {
      const box = node.getBoundingClientRect();
      width = width || box.width || Number(node.getAttribute("width")) || 0;
      height = height || box.height || Number(node.getAttribute("height")) || 0;
    }
    return { width, height };
  }
  async function imageToCanvas(image, context) {
    const {
      log,
      timeout,
      drawImageCount,
      drawImageInterval
    } = context;
    log.time("image to canvas");
    const loaded = await loadMedia(image, { timeout, onWarn: context.log.warn });
    const { canvas, context2d } = createCanvas(image.ownerDocument, context);
    const drawImage = () => {
      try {
        context2d?.drawImage(loaded, 0, 0, canvas.width, canvas.height);
      } catch (error) {
        context.log.warn("Failed to drawImage", error);
      }
    };
    drawImage();
    if (context.isEnable("fixSvgXmlDecode")) {
      for (let i = 0; i < drawImageCount; i++) {
        await new Promise((resolve) => {
          setTimeout(() => {
            context2d?.clearRect(0, 0, canvas.width, canvas.height);
            drawImage();
            resolve();
          }, i + drawImageInterval);
        });
      }
    }
    context.drawImageCount = 0;
    log.timeEnd("image to canvas");
    return canvas;
  }
  function createCanvas(ownerDocument, context) {
    const { width, height, scale, backgroundColor, maximumCanvasSize: max } = context;
    const canvas = ownerDocument.createElement("canvas");
    canvas.width = Math.floor(width * scale);
    canvas.height = Math.floor(height * scale);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    if (max) {
      if (canvas.width > max || canvas.height > max) {
        if (canvas.width > max && canvas.height > max) {
          if (canvas.width > canvas.height) {
            canvas.height *= max / canvas.width;
            canvas.width = max;
          } else {
            canvas.width *= max / canvas.height;
            canvas.height = max;
          }
        } else if (canvas.width > max) {
          canvas.height *= max / canvas.width;
          canvas.width = max;
        } else {
          canvas.width *= max / canvas.height;
          canvas.height = max;
        }
      }
    }
    const context2d = canvas.getContext("2d");
    if (context2d && backgroundColor) {
      context2d.fillStyle = backgroundColor;
      context2d.fillRect(0, 0, canvas.width, canvas.height);
    }
    return { canvas, context2d };
  }
  function cloneCanvas(canvas, context) {
    if (canvas.ownerDocument) {
      try {
        const dataURL = canvas.toDataURL();
        if (dataURL !== "data:,") {
          return createImage(dataURL, canvas.ownerDocument);
        }
      } catch (error) {
        context.log.warn("Failed to clone canvas", error);
      }
    }
    const cloned = canvas.cloneNode(false);
    const ctx = canvas.getContext("2d");
    const clonedCtx = cloned.getContext("2d");
    try {
      if (ctx && clonedCtx) {
        clonedCtx.putImageData(
          ctx.getImageData(0, 0, canvas.width, canvas.height),
          0,
          0
        );
      }
      return cloned;
    } catch (error) {
      context.log.warn("Failed to clone canvas", error);
    }
    return cloned;
  }
  function cloneIframe(iframe, context) {
    try {
      if (iframe?.contentDocument?.documentElement) {
        return cloneNode(iframe.contentDocument.documentElement, context);
      }
    } catch (error) {
      context.log.warn("Failed to clone iframe", error);
    }
    return iframe.cloneNode(false);
  }
  function cloneImage(image) {
    const cloned = image.cloneNode(false);
    if (image.currentSrc && image.currentSrc !== image.src) {
      cloned.src = image.currentSrc;
      cloned.srcset = "";
    }
    if (cloned.loading === "lazy") {
      cloned.loading = "eager";
    }
    return cloned;
  }
  async function cloneVideo(video, context) {
    if (video.ownerDocument && !video.currentSrc && video.poster) {
      return createImage(video.poster, video.ownerDocument);
    }
    const cloned = video.cloneNode(false);
    cloned.crossOrigin = "anonymous";
    if (video.currentSrc && video.currentSrc !== video.src) {
      cloned.src = video.currentSrc;
    }
    const ownerDocument = cloned.ownerDocument;
    if (ownerDocument) {
      let canPlay = true;
      await loadMedia(cloned, { onError: () => canPlay = false, onWarn: context.log.warn });
      if (!canPlay) {
        if (video.poster) {
          return createImage(video.poster, video.ownerDocument);
        }
        return cloned;
      }
      cloned.currentTime = video.currentTime;
      await new Promise((resolve) => {
        cloned.addEventListener("seeked", resolve, { once: true });
      });
      const canvas = ownerDocument.createElement("canvas");
      canvas.width = video.offsetWidth;
      canvas.height = video.offsetHeight;
      try {
        const ctx = canvas.getContext("2d");
        if (ctx)
          ctx.drawImage(cloned, 0, 0, canvas.width, canvas.height);
      } catch (error) {
        context.log.warn("Failed to clone video", error);
        if (video.poster) {
          return createImage(video.poster, video.ownerDocument);
        }
        return cloned;
      }
      return cloneCanvas(canvas, context);
    }
    return cloned;
  }
  function cloneElement(node, context) {
    if (isCanvasElement(node)) {
      return cloneCanvas(node, context);
    }
    if (isIFrameElement(node)) {
      return cloneIframe(node, context);
    }
    if (isImageElement(node)) {
      return cloneImage(node);
    }
    if (isVideoElement(node)) {
      return cloneVideo(node, context);
    }
    return node.cloneNode(false);
  }
  function getSandBox(context) {
    let sandbox = context.sandbox;
    if (!sandbox) {
      const { ownerDocument } = context;
      try {
        if (ownerDocument) {
          sandbox = ownerDocument.createElement("iframe");
          sandbox.id = `__SANDBOX__${uuid()}`;
          sandbox.width = "0";
          sandbox.height = "0";
          sandbox.style.visibility = "hidden";
          sandbox.style.position = "fixed";
          ownerDocument.body.appendChild(sandbox);
          sandbox.srcdoc = '<!DOCTYPE html><meta charset="UTF-8"><title></title><body>';
          context.sandbox = sandbox;
        }
      } catch (error) {
        context.log.warn("Failed to getSandBox", error);
      }
    }
    return sandbox;
  }
  function getDefaultStyle(node, pseudoElement, context) {
    const { defaultComputedStyles } = context;
    const nodeName = node.nodeName.toLowerCase();
    const isSvgNode = isSVGElementNode(node) && nodeName !== "svg";
    const attributes = isSvgNode ? includedAttributes.map((name) => [name, node.getAttribute(name)]).filter(([, value]) => value !== null) : [];
    const key = [
      isSvgNode && "svg",
      nodeName,
      attributes.map((name, value) => `${name}=${value}`).join(","),
      pseudoElement
    ].filter(Boolean).join(":");
    if (defaultComputedStyles.has(key))
      return defaultComputedStyles.get(key);
    const sandbox = getSandBox(context);
    const sandboxWindow = sandbox?.contentWindow;
    if (!sandboxWindow)
      return /* @__PURE__ */ new Map();
    const sandboxDocument = sandboxWindow?.document;
    let root;
    let el;
    if (isSvgNode) {
      root = sandboxDocument.createElementNS(XMLNS, "svg");
      el = root.ownerDocument.createElementNS(root.namespaceURI, nodeName);
      attributes.forEach(([name, value]) => {
        el.setAttributeNS(null, name, value);
      });
      root.appendChild(el);
    } else {
      root = el = sandboxDocument.createElement(nodeName);
    }
    el.textContent = " ";
    sandboxDocument.body.appendChild(root);
    const computedStyle = sandboxWindow.getComputedStyle(el, pseudoElement);
    const styles = /* @__PURE__ */ new Map();
    for (let len = computedStyle.length, i = 0; i < len; i++) {
      const name = computedStyle.item(i);
      if (ignoredStyles.includes(name))
        continue;
      styles.set(name, computedStyle.getPropertyValue(name));
    }
    sandboxDocument.body.removeChild(root);
    defaultComputedStyles.set(key, styles);
    return styles;
  }
  function getDiffStyle(style, defaultStyle, includeStyleProperties) {
    const diffStyle = /* @__PURE__ */ new Map();
    const prefixs = [];
    const prefixTree = /* @__PURE__ */ new Map();
    if (includeStyleProperties) {
      for (const name of includeStyleProperties) {
        applyTo(name);
      }
    } else {
      for (let len = style.length, i = 0; i < len; i++) {
        const name = style.item(i);
        applyTo(name);
      }
    }
    for (let len = prefixs.length, i = 0; i < len; i++) {
      prefixTree.get(prefixs[i])?.forEach((value, name) => diffStyle.set(name, value));
    }
    function applyTo(name) {
      const value = style.getPropertyValue(name);
      const priority = style.getPropertyPriority(name);
      const subIndex = name.lastIndexOf("-");
      const prefix = subIndex > -1 ? name.substring(0, subIndex) : void 0;
      if (prefix) {
        let map = prefixTree.get(prefix);
        if (!map) {
          map = /* @__PURE__ */ new Map();
          prefixTree.set(prefix, map);
        }
        map.set(name, [value, priority]);
      }
      if (defaultStyle.get(name) === value && !priority)
        return;
      if (prefix) {
        prefixs.push(prefix);
      } else {
        diffStyle.set(name, [value, priority]);
      }
    }
    return diffStyle;
  }
  function copyCssStyles(node, cloned, isRoot, context) {
    const { ownerWindow, includeStyleProperties, currentParentNodeStyle } = context;
    const clonedStyle = cloned.style;
    const computedStyle = ownerWindow.getComputedStyle(node);
    const defaultStyle = getDefaultStyle(node, null, context);
    currentParentNodeStyle?.forEach((_, key) => {
      defaultStyle.delete(key);
    });
    const style = getDiffStyle(computedStyle, defaultStyle, includeStyleProperties);
    style.delete("transition-property");
    style.delete("all");
    style.delete("d");
    style.delete("content");
    if (isRoot) {
      style.delete("position");
      style.delete("margin-top");
      style.delete("margin-right");
      style.delete("margin-bottom");
      style.delete("margin-left");
      style.delete("margin-block-start");
      style.delete("margin-block-end");
      style.delete("margin-inline-start");
      style.delete("margin-inline-end");
      style.set("box-sizing", ["border-box", ""]);
    }
    if (style.get("background-clip")?.[0] === "text") {
      cloned.classList.add("______background-clip--text");
    }
    if (IN_CHROME) {
      if (!style.has("font-kerning"))
        style.set("font-kerning", ["normal", ""]);
      if ((style.get("overflow-x")?.[0] === "hidden" || style.get("overflow-y")?.[0] === "hidden") && style.get("text-overflow")?.[0] === "ellipsis" && node.scrollWidth === node.clientWidth) {
        style.set("text-overflow", ["clip", ""]);
      }
    }
    for (let len = clonedStyle.length, i = 0; i < len; i++) {
      clonedStyle.removeProperty(clonedStyle.item(i));
    }
    style.forEach(([value, priority], name) => {
      clonedStyle.setProperty(name, value, priority);
    });
    return style;
  }
  function copyInputValue(node, cloned) {
    if (isTextareaElement(node) || isInputElement(node) || isSelectElement(node)) {
      cloned.setAttribute("value", node.value);
    }
  }
  function copyPseudoClass(node, cloned, copyScrollbar, context, addWordToFontFamilies) {
    const { ownerWindow, svgStyleElement, svgStyles, currentNodeStyle } = context;
    if (!svgStyleElement || !ownerWindow)
      return;
    function copyBy(pseudoClass) {
      const computedStyle = ownerWindow.getComputedStyle(node, pseudoClass);
      let content = computedStyle.getPropertyValue("content");
      if (!content || content === "none")
        return;
      addWordToFontFamilies?.(content);
      content = content.replace(/(')|(")|(counter\(.+\))/g, "");
      const klasses = [uuid()];
      const defaultStyle = getDefaultStyle(node, pseudoClass, context);
      currentNodeStyle?.forEach((_, key) => {
        defaultStyle.delete(key);
      });
      const style = getDiffStyle(computedStyle, defaultStyle, context.includeStyleProperties);
      style.delete("content");
      style.delete("-webkit-locale");
      if (style.get("background-clip")?.[0] === "text") {
        cloned.classList.add("______background-clip--text");
      }
      const cloneStyle = [
        `content: '${content}';`
      ];
      style.forEach(([value, priority], name) => {
        cloneStyle.push(`${name}: ${value}${priority ? " !important" : ""};`);
      });
      if (cloneStyle.length === 1)
        return;
      try {
        cloned.className = [cloned.className, ...klasses].join(" ");
      } catch (err) {
        context.log.warn("Failed to copyPseudoClass", err);
        return;
      }
      const cssText = cloneStyle.join("\n  ");
      let allClasses = svgStyles.get(cssText);
      if (!allClasses) {
        allClasses = [];
        svgStyles.set(cssText, allClasses);
      }
      allClasses.push(`.${klasses[0]}${pseudoClass}`);
    }
    pseudoClasses.forEach(copyBy);
    if (copyScrollbar)
      scrollbarPseudoClasses.forEach(copyBy);
  }
  async function appendChildNode(node, cloned, child, context, addWordToFontFamilies) {
    if (isElementNode(child) && (isStyleElement(child) || isScriptElement(child)))
      return;
    if (context.filter && !context.filter(child))
      return;
    if (excludeParentNodes.has(cloned.nodeName) || excludeParentNodes.has(child.nodeName)) {
      context.currentParentNodeStyle = void 0;
    } else {
      context.currentParentNodeStyle = context.currentNodeStyle;
    }
    const childCloned = await cloneNode(child, context, false, addWordToFontFamilies);
    if (context.isEnable("restoreScrollPosition")) {
      restoreScrollPosition(node, childCloned);
    }
    cloned.appendChild(childCloned);
  }
  async function cloneChildNodes(node, cloned, context, addWordToFontFamilies) {
    let firstChild = node.firstChild;
    if (isElementNode(node)) {
      if (node.shadowRoot) {
        firstChild = node.shadowRoot?.firstChild;
        context.shadowRoots.push(node.shadowRoot);
      }
    }
    for (let child = firstChild; child; child = child.nextSibling) {
      if (isCommentNode(child))
        continue;
      if (isElementNode(child) && isSlotElement(child) && typeof child.assignedNodes === "function") {
        const nodes = child.assignedNodes();
        for (let i = 0; i < nodes.length; i++) {
          await appendChildNode(node, cloned, nodes[i], context, addWordToFontFamilies);
        }
      } else {
        await appendChildNode(node, cloned, child, context, addWordToFontFamilies);
      }
    }
  }
  function restoreScrollPosition(node, chlidCloned) {
    if (!isHTMLElementNode(node) || !isHTMLElementNode(chlidCloned))
      return;
    const { scrollTop, scrollLeft } = node;
    if (!scrollTop && !scrollLeft) {
      return;
    }
    const { transform } = chlidCloned.style;
    const matrix = new DOMMatrix(transform);
    const { a, b, c, d } = matrix;
    matrix.a = 1;
    matrix.b = 0;
    matrix.c = 0;
    matrix.d = 1;
    matrix.translateSelf(-scrollLeft, -scrollTop);
    matrix.a = a;
    matrix.b = b;
    matrix.c = c;
    matrix.d = d;
    chlidCloned.style.transform = matrix.toString();
  }
  function applyCssStyleWithOptions(cloned, context) {
    const { backgroundColor, width, height, style: styles } = context;
    const clonedStyle = cloned.style;
    if (backgroundColor)
      clonedStyle.setProperty("background-color", backgroundColor, "important");
    if (width)
      clonedStyle.setProperty("width", `${width}px`, "important");
    if (height)
      clonedStyle.setProperty("height", `${height}px`, "important");
    if (styles) {
      for (const name in styles) clonedStyle[name] = styles[name];
    }
  }
  async function cloneNode(node, context, isRoot = false, addWordToFontFamilies) {
    const { ownerDocument, ownerWindow, fontFamilies, onCloneEachNode } = context;
    if (ownerDocument && isTextNode(node)) {
      if (addWordToFontFamilies && /\S/.test(node.data)) {
        addWordToFontFamilies(node.data);
      }
      return ownerDocument.createTextNode(node.data);
    }
    if (ownerDocument && ownerWindow && isElementNode(node) && (isHTMLElementNode(node) || isSVGElementNode(node))) {
      const cloned2 = await cloneElement(node, context);
      if (context.isEnable("removeAbnormalAttributes")) {
        const names = cloned2.getAttributeNames();
        for (let len = names.length, i = 0; i < len; i++) {
          const name = names[i];
          if (!NORMAL_ATTRIBUTE_RE.test(name)) {
            cloned2.removeAttribute(name);
          }
        }
      }
      const style = context.currentNodeStyle = copyCssStyles(node, cloned2, isRoot, context);
      if (isRoot)
        applyCssStyleWithOptions(cloned2, context);
      let copyScrollbar = false;
      if (context.isEnable("copyScrollbar")) {
        const overflow = [
          style.get("overflow-x")?.[0],
          style.get("overflow-y")?.[0]
        ];
        copyScrollbar = overflow.includes("scroll") || (overflow.includes("auto") || overflow.includes("overlay")) && (node.scrollHeight > node.clientHeight || node.scrollWidth > node.clientWidth);
      }
      const textTransform = style.get("text-transform")?.[0];
      const families = splitFontFamily(style.get("font-family")?.[0]);
      const addWordToFontFamilies2 = families ? (word) => {
        if (textTransform === "uppercase") {
          word = word.toUpperCase();
        } else if (textTransform === "lowercase") {
          word = word.toLowerCase();
        } else if (textTransform === "capitalize") {
          word = word[0].toUpperCase() + word.substring(1);
        }
        families.forEach((family) => {
          let fontFamily = fontFamilies.get(family);
          if (!fontFamily) {
            fontFamilies.set(family, fontFamily = /* @__PURE__ */ new Set());
          }
          word.split("").forEach((text) => fontFamily.add(text));
        });
      } : void 0;
      copyPseudoClass(
        node,
        cloned2,
        copyScrollbar,
        context,
        addWordToFontFamilies2
      );
      copyInputValue(node, cloned2);
      if (!isVideoElement(node)) {
        await cloneChildNodes(
          node,
          cloned2,
          context,
          addWordToFontFamilies2
        );
      }
      await onCloneEachNode?.(cloned2);
      return cloned2;
    }
    const cloned = node.cloneNode(false);
    await cloneChildNodes(node, cloned, context);
    await onCloneEachNode?.(cloned);
    return cloned;
  }
  function destroyContext(context) {
    context.ownerDocument = void 0;
    context.ownerWindow = void 0;
    context.svgStyleElement = void 0;
    context.svgDefsElement = void 0;
    context.svgStyles.clear();
    context.defaultComputedStyles.clear();
    if (context.sandbox) {
      try {
        context.sandbox.remove();
      } catch (err) {
        context.log.warn("Failed to destroyContext", err);
      }
      context.sandbox = void 0;
    }
    context.workers = [];
    context.fontFamilies.clear();
    context.fontCssTexts.clear();
    context.requests.clear();
    context.tasks = [];
    context.shadowRoots = [];
  }
  function baseFetch(options) {
    const { url, timeout, responseType, ...requestInit } = options;
    const controller = new AbortController();
    const timer = timeout ? setTimeout(() => controller.abort(), timeout) : void 0;
    return fetch(url, { signal: controller.signal, ...requestInit }).then((response) => {
      if (!response.ok) {
        throw new Error("Failed fetch, not 2xx response", { cause: response });
      }
      switch (responseType) {
        case "arrayBuffer":
          return response.arrayBuffer();
        case "dataUrl":
          return response.blob().then(blobToDataUrl);
        case "text":
        default:
          return response.text();
      }
    }).finally(() => clearTimeout(timer));
  }
  function contextFetch(context, options) {
    const { url: rawUrl, requestType = "text", responseType = "text", imageDom } = options;
    let url = rawUrl;
    const {
      timeout,
      acceptOfImage,
      requests,
      fetchFn,
      fetch: {
        requestInit,
        bypassingCache,
        placeholderImage
      },
      font,
      workers,
      fontFamilies
    } = context;
    if (requestType === "image" && (IN_SAFARI || IN_FIREFOX)) {
      context.drawImageCount++;
    }
    let request = requests.get(rawUrl);
    if (!request) {
      if (bypassingCache) {
        if (bypassingCache instanceof RegExp && bypassingCache.test(url)) {
          url += (/\?/.test(url) ? "&" : "?") + (/* @__PURE__ */ new Date()).getTime();
        }
      }
      const canFontMinify = requestType.startsWith("font") && font && font.minify;
      const fontTexts = /* @__PURE__ */ new Set();
      if (canFontMinify) {
        const families = requestType.split(";")[1].split(",");
        families.forEach((family) => {
          if (!fontFamilies.has(family))
            return;
          fontFamilies.get(family).forEach((text) => fontTexts.add(text));
        });
      }
      const needFontMinify = canFontMinify && fontTexts.size;
      const baseFetchOptions = {
        url,
        timeout,
        responseType: needFontMinify ? "arrayBuffer" : responseType,
        headers: requestType === "image" ? { accept: acceptOfImage } : void 0,
        ...requestInit
      };
      request = {
        type: requestType,
        resolve: void 0,
        reject: void 0,
        response: null
      };
      request.response = (async () => {
        if (fetchFn && requestType === "image") {
          const result = await fetchFn(rawUrl);
          if (result)
            return result;
        }
        if (!IN_SAFARI && rawUrl.startsWith("http") && workers.length) {
          return new Promise((resolve, reject) => {
            const worker = workers[requests.size & workers.length - 1];
            worker.postMessage({ rawUrl, ...baseFetchOptions });
            request.resolve = resolve;
            request.reject = reject;
          });
        }
        return baseFetch(baseFetchOptions);
      })().catch((error) => {
        requests.delete(rawUrl);
        if (requestType === "image" && placeholderImage) {
          context.log.warn("Failed to fetch image base64, trying to use placeholder image", url);
          return typeof placeholderImage === "string" ? placeholderImage : placeholderImage(imageDom);
        }
        throw error;
      });
      requests.set(rawUrl, request);
    }
    return request.response;
  }
  async function replaceCssUrlToDataUrl(cssText, baseUrl, context, isImage) {
    if (!hasCssUrl(cssText))
      return cssText;
    for (const [rawUrl, url] of parseCssUrls(cssText, baseUrl)) {
      try {
        const dataUrl = await contextFetch(
          context,
          {
            url,
            requestType: isImage ? "image" : "text",
            responseType: "dataUrl"
          }
        );
        cssText = cssText.replace(toRE(rawUrl), `$1${dataUrl}$3`);
      } catch (error) {
        context.log.warn("Failed to fetch css data url", rawUrl, error);
      }
    }
    return cssText;
  }
  function hasCssUrl(cssText) {
    return /url\((['"]?)([^'"]+?)\1\)/.test(cssText);
  }
  function parseCssUrls(cssText, baseUrl) {
    const result = [];
    cssText.replace(URL_RE, (raw, quotation, url) => {
      result.push([url, resolveUrl(url, baseUrl)]);
      return raw;
    });
    return result.filter(([url]) => !isDataUrl(url));
  }
  function toRE(url) {
    const escaped = url.replace(/([.*+?^${}()|\[\]\/\\])/g, "\\$1");
    return new RegExp(`(url\\(['"]?)(${escaped})(['"]?\\))`, "g");
  }
  function embedCssStyleImage(style, context) {
    return properties.map((property) => {
      const value = style.getPropertyValue(property);
      if (!value || value === "none") {
        return null;
      }
      if (IN_SAFARI || IN_FIREFOX) {
        context.drawImageCount++;
      }
      return replaceCssUrlToDataUrl(value, null, context, true).then((newValue) => {
        if (!newValue || value === newValue)
          return;
        style.setProperty(
          property,
          newValue,
          style.getPropertyPriority(property)
        );
      });
    }).filter(Boolean);
  }
  function embedImageElement(cloned, context) {
    if (isImageElement(cloned)) {
      const originalSrc = cloned.currentSrc || cloned.src;
      if (!isDataUrl(originalSrc)) {
        return [
          contextFetch(context, {
            url: originalSrc,
            imageDom: cloned,
            requestType: "image",
            responseType: "dataUrl"
          }).then((url) => {
            if (!url)
              return;
            cloned.srcset = "";
            cloned.dataset.originalSrc = originalSrc;
            cloned.src = url || "";
          })
        ];
      }
      if (IN_SAFARI || IN_FIREFOX) {
        context.drawImageCount++;
      }
    } else if (isSVGElementNode(cloned) && !isDataUrl(cloned.href.baseVal)) {
      const originalSrc = cloned.href.baseVal;
      return [
        contextFetch(context, {
          url: originalSrc,
          imageDom: cloned,
          requestType: "image",
          responseType: "dataUrl"
        }).then((url) => {
          if (!url)
            return;
          cloned.dataset.originalSrc = originalSrc;
          cloned.href.baseVal = url || "";
        })
      ];
    }
    return [];
  }
  function embedSvgUse(cloned, context) {
    const { ownerDocument, svgDefsElement } = context;
    const href = cloned.getAttribute("href") ?? cloned.getAttribute("xlink:href");
    if (!href)
      return [];
    const [svgUrl, id] = href.split("#");
    if (id) {
      const query = `#${id}`;
      const definition = context.shadowRoots.reduce(
        (res, root) => {
          return res ?? root.querySelector(`svg ${query}`);
        },
        ownerDocument?.querySelector(`svg ${query}`)
      );
      if (svgUrl) {
        cloned.setAttribute("href", query);
      }
      if (svgDefsElement?.querySelector(query))
        return [];
      if (definition) {
        svgDefsElement?.appendChild(definition.cloneNode(true));
        return [];
      } else if (svgUrl) {
        return [
          contextFetch(context, {
            url: svgUrl,
            responseType: "text"
          }).then((svgData) => {
            svgDefsElement?.insertAdjacentHTML("beforeend", svgData);
          })
        ];
      }
    }
    return [];
  }
  function embedNode(cloned, context) {
    const { tasks } = context;
    if (isElementNode(cloned)) {
      if (isImageElement(cloned) || isSVGImageElementNode(cloned)) {
        tasks.push(...embedImageElement(cloned, context));
      }
      if (isSVGUseElementNode(cloned)) {
        tasks.push(...embedSvgUse(cloned, context));
      }
    }
    if (isHTMLElementNode(cloned)) {
      tasks.push(...embedCssStyleImage(cloned.style, context));
    }
    cloned.childNodes.forEach((child) => {
      embedNode(child, context);
    });
  }
  async function embedWebFont(clone, context) {
    const {
      ownerDocument,
      svgStyleElement,
      fontFamilies,
      fontCssTexts,
      tasks,
      font
    } = context;
    if (!ownerDocument || !svgStyleElement || !fontFamilies.size) {
      return;
    }
    if (font && font.cssText) {
      const cssText = filterPreferredFormat(font.cssText, context);
      svgStyleElement.appendChild(ownerDocument.createTextNode(`${cssText}
`));
    } else {
      const styleSheets = Array.from(ownerDocument.styleSheets).filter((styleSheet) => {
        try {
          return "cssRules" in styleSheet && Boolean(styleSheet.cssRules.length);
        } catch (error) {
          context.log.warn(`Error while reading CSS rules from ${styleSheet.href}`, error);
          return false;
        }
      });
      const tempDoc = ownerDocument.implementation.createHTMLDocument("");
      const tempStyleEl = tempDoc.createElement("style");
      tempDoc.head.appendChild(tempStyleEl);
      const tempStyleSheet = tempStyleEl.sheet;
      await Promise.all(
        styleSheets.flatMap((styleSheet) => {
          return Array.from(styleSheet.cssRules).map(async (cssRule) => {
            if (isCSSImportRule(cssRule)) {
              const baseUrl = cssRule.href;
              let cssText = "";
              try {
                cssText = await contextFetch(context, {
                  url: baseUrl,
                  requestType: "text",
                  responseType: "text"
                });
              } catch (error) {
                context.log.warn(`Error fetch remote css import from ${baseUrl}`, error);
              }
              const replacedCssText = cssText.replace(
                URL_RE,
                (raw, quotation, url) => raw.replace(url, resolveUrl(url, baseUrl))
              );
              for (const rule of parseCss(replacedCssText)) {
                try {
                  tempStyleSheet.insertRule(rule, tempStyleSheet.cssRules.length);
                } catch (error) {
                  context.log.warn("Error inserting rule from remote css import", { rule, error });
                }
              }
            }
          });
        })
      );
      if (tempStyleSheet.cssRules.length)
        styleSheets.push(tempStyleSheet);
      const cssRules = [];
      styleSheets.forEach((sheet) => {
        unwrapCssLayers(sheet.cssRules, cssRules);
      });
      cssRules.filter((cssRule) => isCssFontFaceRule(cssRule) && hasCssUrl(cssRule.style.getPropertyValue("src")) && splitFontFamily(cssRule.style.getPropertyValue("font-family"))?.some((val) => fontFamilies.has(val))).forEach((value) => {
        const rule = value;
        const cssText = fontCssTexts.get(rule.cssText);
        if (cssText) {
          svgStyleElement.appendChild(ownerDocument.createTextNode(`${cssText}
`));
        } else {
          tasks.push(
            replaceCssUrlToDataUrl(
              rule.cssText,
              rule.parentStyleSheet ? rule.parentStyleSheet.href : null,
              context
            ).then((cssText2) => {
              cssText2 = filterPreferredFormat(cssText2, context);
              fontCssTexts.set(rule.cssText, cssText2);
              svgStyleElement.appendChild(ownerDocument.createTextNode(`${cssText2}
`));
            })
          );
        }
      });
    }
  }
  function parseCss(source) {
    if (source == null)
      return [];
    const result = [];
    let cssText = source.replace(COMMENTS_RE, "");
    while (true) {
      const matches = KEYFRAMES_RE.exec(cssText);
      if (!matches)
        break;
      result.push(matches[0]);
    }
    cssText = cssText.replace(KEYFRAMES_RE, "");
    const IMPORT_RE = /@import[\s\S]*?url\([^)]*\)[\s\S]*?;/gi;
    const UNIFIED_RE = new RegExp(
      // eslint-disable-next-line
      "((\\s*?(?:\\/\\*[\\s\\S]*?\\*\\/)?\\s*?@media[\\s\\S]*?){([\\s\\S]*?)}\\s*?})|(([\\s\\S]*?){([\\s\\S]*?)})",
      "gi"
    );
    while (true) {
      let matches = IMPORT_RE.exec(cssText);
      if (!matches) {
        matches = UNIFIED_RE.exec(cssText);
        if (!matches) {
          break;
        } else {
          IMPORT_RE.lastIndex = UNIFIED_RE.lastIndex;
        }
      } else {
        UNIFIED_RE.lastIndex = IMPORT_RE.lastIndex;
      }
      result.push(matches[0]);
    }
    return result;
  }
  function filterPreferredFormat(str, context) {
    const { font } = context;
    const preferredFormat = font ? font?.preferredFormat : void 0;
    return preferredFormat ? str.replace(FONT_SRC_RE, (match) => {
      while (true) {
        const [src, , format] = URL_WITH_FORMAT_RE.exec(match) || [];
        if (!format)
          return "";
        if (format === preferredFormat)
          return `src: ${src};`;
      }
    }) : str;
  }
  function unwrapCssLayers(rules, out = []) {
    for (const rule of Array.from(rules)) {
      if (isLayerBlockRule(rule)) {
        out.push(...unwrapCssLayers(rule.cssRules));
      } else if ("cssRules" in rule) {
        unwrapCssLayers(rule.cssRules, out);
      } else {
        out.push(rule);
      }
    }
    return out;
  }
  function svgHasExternalResources(svg) {
    return SVG_EXTERNAL_RESOURCE_REGEX.test(svg.innerHTML);
  }
  async function domToForeignObjectSvg(node, options) {
    const context = await orCreateContext(node, options);
    if (isElementNode(context.node) && isSVGElementNode(context.node) && !svgHasExternalResources(context.node))
      return context.node;
    const {
      ownerDocument,
      log,
      tasks,
      svgStyleElement,
      svgDefsElement,
      svgStyles,
      font,
      progress,
      autoDestruct,
      onCloneNode,
      onEmbedNode,
      onCreateForeignObjectSvg
    } = context;
    log.time("clone node");
    const clone = await cloneNode(context.node, context, true);
    if (svgStyleElement && ownerDocument) {
      let allCssText = "";
      svgStyles.forEach((klasses, cssText) => {
        allCssText += `${klasses.join(",\n")} {
  ${cssText}
}
`;
      });
      svgStyleElement.appendChild(ownerDocument.createTextNode(allCssText));
    }
    log.timeEnd("clone node");
    await onCloneNode?.(clone);
    if (font !== false && isElementNode(clone)) {
      log.time("embed web font");
      await embedWebFont(clone, context);
      log.timeEnd("embed web font");
    }
    log.time("embed node");
    embedNode(clone, context);
    const count = tasks.length;
    let current = 0;
    const runTask = async () => {
      while (true) {
        const task = tasks.pop();
        if (!task)
          break;
        try {
          await task;
        } catch (error) {
          context.log.warn("Failed to run task", error);
        }
        progress?.(++current, count);
      }
    };
    progress?.(current, count);
    await Promise.all([...Array.from({ length: 4 })].map(runTask));
    log.timeEnd("embed node");
    await onEmbedNode?.(clone);
    const svg = createForeignObjectSvg(clone, context);
    svgDefsElement && svg.insertBefore(svgDefsElement, svg.children[0]);
    svgStyleElement && svg.insertBefore(svgStyleElement, svg.children[0]);
    autoDestruct && destroyContext(context);
    await onCreateForeignObjectSvg?.(svg);
    return svg;
  }
  function createForeignObjectSvg(clone, context) {
    const { width, height } = context;
    const svg = createSvg(width, height, clone.ownerDocument);
    const foreignObject = svg.ownerDocument.createElementNS(svg.namespaceURI, "foreignObject");
    foreignObject.setAttributeNS(null, "x", "0%");
    foreignObject.setAttributeNS(null, "y", "0%");
    foreignObject.setAttributeNS(null, "width", "100%");
    foreignObject.setAttributeNS(null, "height", "100%");
    foreignObject.append(clone);
    svg.appendChild(foreignObject);
    return svg;
  }
  async function domToCanvas(node, options) {
    const context = await orCreateContext(node, options);
    const svg = await domToForeignObjectSvg(context);
    const dataUrl = svgToDataUrl(svg, context.isEnable("removeControlCharacter"));
    if (!context.autoDestruct) {
      context.svgStyleElement = createStyleElement(context.ownerDocument);
      context.svgDefsElement = context.ownerDocument?.createElementNS(XMLNS, "defs");
      context.svgStyles.clear();
    }
    const image = createImage(dataUrl, svg.ownerDocument);
    return await imageToCanvas(image, context);
  }
  async function domToBlob(node, options) {
    const context = await orCreateContext(node, options);
    const { log, type, quality, dpi } = context;
    const canvas = await domToCanvas(context);
    log.time("canvas to blob");
    const blob = await canvasToBlob(canvas, type, quality);
    if (["image/png", "image/jpeg"].includes(type) && dpi) {
      const arrayBuffer = await blobToArrayBuffer(blob.slice(0, 33));
      let uint8Array = new Uint8Array(arrayBuffer);
      if (type === "image/png") {
        uint8Array = changePngDpi(uint8Array, dpi);
      } else if (type === "image/jpeg") {
        uint8Array = changeJpegDpi(uint8Array, dpi);
      }
      log.timeEnd("canvas to blob");
      return new Blob([uint8Array, blob.slice(33)], { type });
    }
    log.timeEnd("canvas to blob");
    return blob;
  }
  async function domToDataUrl(node, options) {
    const context = await orCreateContext(node, options);
    const { log, quality, type, dpi } = context;
    const canvas = await domToCanvas(context);
    log.time("canvas to data url");
    let dataUrl = canvas.toDataURL(type, quality);
    if (["image/png", "image/jpeg"].includes(type) && dpi && SUPPORT_ATOB && SUPPORT_BTOA) {
      const [format, body] = dataUrl.split(",");
      let headerLength = 0;
      let overwritepHYs = false;
      if (type === "image/png") {
        const b64Index = detectPhysChunkFromDataUrl(body);
        if (b64Index >= 0) {
          headerLength = Math.ceil((b64Index + 28) / 3) * 4;
          overwritepHYs = true;
        } else {
          headerLength = 33 / 3 * 4;
        }
      } else if (type === "image/jpeg") {
        headerLength = 18 / 3 * 4;
      }
      const stringHeader = body.substring(0, headerLength);
      const restOfData = body.substring(headerLength);
      const headerBytes = window.atob(stringHeader);
      const uint8Array = new Uint8Array(headerBytes.length);
      for (let i = 0; i < uint8Array.length; i++) {
        uint8Array[i] = headerBytes.charCodeAt(i);
      }
      const finalArray = type === "image/png" ? changePngDpi(uint8Array, dpi, overwritepHYs) : changeJpegDpi(uint8Array, dpi);
      const base64Header = window.btoa(String.fromCharCode(...finalArray));
      dataUrl = [format, ",", base64Header, restOfData].join("");
    }
    log.timeEnd("canvas to data url");
    return dataUrl;
  }
  async function domToSvg(node, options) {
    const context = await orCreateContext(node, options);
    const { width, height, ownerDocument } = context;
    const dataUrl = await domToDataUrl(context);
    const svg = createSvg(width, height, ownerDocument);
    const svgImage = svg.ownerDocument.createElementNS(svg.namespaceURI, "image");
    svgImage.setAttributeNS(null, "href", dataUrl);
    svgImage.setAttributeNS(null, "height", "100%");
    svgImage.setAttributeNS(null, "width", "100%");
    svg.appendChild(svgImage);
    return svgToDataUrl(svg, context.isEnable("removeControlCharacter"));
  }
  async function domToImage(node, options) {
    const context = await orCreateContext(node, options);
    const { ownerDocument, width, height, scale, type } = context;
    const url = type === "image/svg+xml" ? await domToSvg(context) : await domToDataUrl(context);
    const image = createImage(url, ownerDocument);
    image.width = Math.floor(width * scale);
    image.height = Math.floor(height * scale);
    image.style.width = `${width}px`;
    image.style.height = `${height}px`;
    return image;
  }
  async function domToJpeg(node, options) {
    return domToDataUrl(
      await orCreateContext(node, { ...options, type: "image/jpeg" })
    );
  }
  async function domToPixel(node, options) {
    const context = await orCreateContext(node, options);
    const canvas = await domToCanvas(context);
    return canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
  }
  async function domToPng(node, options) {
    return domToDataUrl(
      await orCreateContext(node, { ...options, type: "image/png" })
    );
  }
  async function domToWebp(node, options) {
    return domToDataUrl(
      await orCreateContext(node, { ...options, type: "image/webp" })
    );
  }
  var _P, _H, _Y, _S, pngDataTable, b64PhysSignature1, b64PhysSignature2, b64PhysSignature3, PREFIX, IN_BROWSER, SUPPORT_WEB_WORKER, SUPPORT_ATOB, SUPPORT_BTOA, USER_AGENT, IN_CHROME, IN_SAFARI, IN_FIREFOX, isContext, isCssFontFaceRule, isCSSImportRule, isLayerBlockRule, isElementNode, isSVGElementNode, isSVGImageElementNode, isSVGUseElementNode, isHTMLElementNode, isCommentNode, isTextNode, isImageElement, isVideoElement, isCanvasElement, isTextareaElement, isInputElement, isStyleElement, isScriptElement, isSelectElement, isSlotElement, isIFrameElement, consoleWarn, isDataUrl, XMLNS, blobToDataUrl, blobToArrayBuffer, uuid, uid, ignoredStyles, includedAttributes, pseudoClasses, scrollbarPseudoClasses, excludeParentNodes, NORMAL_ATTRIBUTE_RE, URL_RE, properties, COMMENTS_RE, KEYFRAMES_RE, URL_WITH_FORMAT_RE, FONT_SRC_RE, SVG_EXTERNAL_RESOURCE_REGEX;
  var init_modern_screenshot = __esm({
    "packages/hub-sdk/src/third_party/modern-screenshot.js"() {
      "use strict";
      _P = "p".charCodeAt(0);
      _H = "H".charCodeAt(0);
      _Y = "Y".charCodeAt(0);
      _S = "s".charCodeAt(0);
      b64PhysSignature1 = "AAlwSFlz";
      b64PhysSignature2 = "AAAJcEhZ";
      b64PhysSignature3 = "AAAACXBI";
      PREFIX = "[modern-screenshot]";
      IN_BROWSER = typeof window !== "undefined";
      SUPPORT_WEB_WORKER = IN_BROWSER && "Worker" in window;
      SUPPORT_ATOB = IN_BROWSER && "atob" in window;
      SUPPORT_BTOA = IN_BROWSER && "btoa" in window;
      USER_AGENT = IN_BROWSER ? window.navigator?.userAgent : "";
      IN_CHROME = USER_AGENT.includes("Chrome");
      IN_SAFARI = USER_AGENT.includes("AppleWebKit") && !IN_CHROME;
      IN_FIREFOX = USER_AGENT.includes("Firefox");
      isContext = (value) => value && "__CONTEXT__" in value;
      isCssFontFaceRule = (rule) => rule.constructor.name === "CSSFontFaceRule";
      isCSSImportRule = (rule) => rule.constructor.name === "CSSImportRule";
      isLayerBlockRule = (rule) => rule.constructor.name === "CSSLayerBlockRule";
      isElementNode = (node) => node.nodeType === 1;
      isSVGElementNode = (node) => typeof node.className === "object";
      isSVGImageElementNode = (node) => node.tagName === "image";
      isSVGUseElementNode = (node) => node.tagName === "use";
      isHTMLElementNode = (node) => isElementNode(node) && typeof node.style !== "undefined" && !isSVGElementNode(node);
      isCommentNode = (node) => node.nodeType === 8;
      isTextNode = (node) => node.nodeType === 3;
      isImageElement = (node) => node.tagName === "IMG";
      isVideoElement = (node) => node.tagName === "VIDEO";
      isCanvasElement = (node) => node.tagName === "CANVAS";
      isTextareaElement = (node) => node.tagName === "TEXTAREA";
      isInputElement = (node) => node.tagName === "INPUT";
      isStyleElement = (node) => node.tagName === "STYLE";
      isScriptElement = (node) => node.tagName === "SCRIPT";
      isSelectElement = (node) => node.tagName === "SELECT";
      isSlotElement = (node) => node.tagName === "SLOT";
      isIFrameElement = (node) => node.tagName === "IFRAME";
      consoleWarn = (...args) => console.warn(PREFIX, ...args);
      isDataUrl = (url) => url.startsWith("data:");
      XMLNS = "http://www.w3.org/2000/svg";
      blobToDataUrl = (blob) => readBlob(blob, "dataUrl");
      blobToArrayBuffer = (blob) => readBlob(blob, "arrayBuffer");
      uuid = /* @__PURE__ */ (function uuid2() {
        let counter = 0;
        const random = () => `0000${(Math.random() * 36 ** 4 << 0).toString(36)}`.slice(-4);
        return () => {
          counter += 1;
          return `u${random()}${counter}`;
        };
      })();
      uid = 0;
      ignoredStyles = [
        "width",
        "height",
        "-webkit-text-fill-color"
      ];
      includedAttributes = [
        "stroke",
        "fill"
      ];
      pseudoClasses = [
        "::before",
        "::after"
        // '::placeholder', TODO
      ];
      scrollbarPseudoClasses = [
        "::-webkit-scrollbar",
        "::-webkit-scrollbar-button",
        // '::-webkit-scrollbar:horizontal', TODO
        "::-webkit-scrollbar-thumb",
        "::-webkit-scrollbar-track",
        "::-webkit-scrollbar-track-piece",
        // '::-webkit-scrollbar:vertical', TODO
        "::-webkit-scrollbar-corner",
        "::-webkit-resizer"
      ];
      excludeParentNodes = /* @__PURE__ */ new Set([
        "symbol"
        // test/fixtures/svg.symbol.html
      ]);
      NORMAL_ATTRIBUTE_RE = /^[\w-:]+$/;
      URL_RE = /url\((['"]?)([^'"]+?)\1\)/g;
      properties = [
        "background-image",
        "border-image-source",
        "-webkit-border-image",
        "-webkit-mask-image",
        "list-style-image"
      ];
      COMMENTS_RE = /(\/\*[\s\S]*?\*\/)/g;
      KEYFRAMES_RE = /((@.*?keyframes [\s\S]*?){([\s\S]*?}\s*?)})/gi;
      URL_WITH_FORMAT_RE = /url\([^)]+\)\s*format\((["']?)([^"']+)\1\)/g;
      FONT_SRC_RE = /src:\s*(?:url\([^)]+\)\s*format\([^)]+\)[,;]\s*)+/g;
      SVG_EXTERNAL_RESOURCE_REGEX = /\bx?link:?href\s*=\s*["'](?!data:)[^"']+["']/i;
    }
  });

  // packages/hub-sdk/src/index.ts
  var index_exports = {};
  __export(index_exports, {
    BOARD_IDS: () => BOARD_IDS,
    BoardId: () => BoardId,
    CHAT_COLORS: () => CHAT_COLORS,
    CHAT_EFFECTS: () => CHAT_EFFECTS,
    CHAT_RATE: () => CHAT_RATE,
    CHAT_RAW_MAX_BYTES: () => CHAT_RAW_MAX_BYTES,
    CHAT_RULE_FIXTURES: () => CHAT_RULE_FIXTURES,
    CHAT_TEXT_MAX: () => CHAT_TEXT_MAX,
    DEVICE_ID_KEY: () => DEVICE_ID_KEY,
    EMPTY_SAVE: () => EMPTY_SAVE,
    FEEDBACK_CATEGORIES: () => FEEDBACK_CATEGORIES,
    FEEDBACK_IMAGE_MAX: () => FEEDBACK_IMAGE_MAX,
    FEEDBACK_META_MAX: () => FEEDBACK_META_MAX,
    FEEDBACK_NOTE_MAX: () => FEEDBACK_NOTE_MAX,
    FOUR_LIGHTS_RELIC_IDS: () => FOUR_LIGHTS_RELIC_IDS,
    GAME_IDS: () => GAME_IDS,
    HUB_OUTBOX_DB: () => HUB_OUTBOX_DB,
    HubEvent: () => HubEvent,
    HubSdkError: () => HubSdkError,
    LOCAL_NAKAMA: () => LOCAL_NAKAMA,
    MOCK_TICKET_EARN_CAP: () => MOCK_TICKET_EARN_CAP,
    MOCK_TICKET_KEY: () => MOCK_TICKET_KEY,
    MOCK_TICKET_TTL_SECONDS: () => MOCK_TICKET_TTL_SECONDS,
    NOBU_TRIAL_CEIL_MS: () => NOBU_TRIAL_CEIL_MS,
    NOBU_TRIAL_FLOOR_MS: () => NOBU_TRIAL_FLOOR_MS,
    RELIC_BY_GAME: () => RELIC_BY_GAME,
    RELIC_IDS: () => RELIC_IDS,
    SAVE_MAX_BYTES: () => SAVE_MAX_BYTES,
    TICKETS_PER_VERSE: () => TICKETS_PER_VERSE,
    VERSE_DAILY_CAP: () => VERSE_DAILY_CAP,
    canonicalGameId: () => canonicalGameId,
    chatRuleOutcome: () => chatRuleOutcome,
    createHubSdk: () => createHubSdk,
    createMockRealtimeServer: () => createMockRealtimeServer,
    createNakamaClient: () => createNakamaClient,
    createRealtime: () => createRealtime,
    encodeSave: () => encodeSave,
    errorCodeFromMessage: () => errorCodeFromMessage,
    feedbackTransportFromSdk: () => feedbackTransportFromSdk,
    fitFeedbackMeta: () => fitFeedbackMeta,
    getOrCreateDeviceId: () => getOrCreateDeviceId,
    installFeedback: () => installFeedback,
    installHubSdk: () => installHubSdk,
    isBoardId: () => isBoardId,
    isGameId: () => isGameId,
    isRelicId: () => isRelicId,
    memoryKeyValue: () => memoryKeyValue,
    mintMockTicket: () => mintMockTicket,
    mockLabelMatches: () => mockLabelMatches,
    normalizeChatText: () => normalizeChatText,
    readSaveResult: () => readSaveResult,
    readTicketParam: () => readTicketParam,
    realtimeFromSdk: () => realtimeFromSdk,
    relicForEvent: () => relicForEvent,
    stripTicketParam: () => stripTicketParam,
    takeChatToken: () => takeChatToken,
    tokenExpiryMs: () => tokenExpiryMs,
    userIdFromToken: () => userIdFromToken,
    validateChatContent: () => validateChatContent,
    verifyMockTicket: () => verifyMockTicket
  });

  // packages/hub-sdk/src/types.ts
  var GAME_IDS = [
    "hpos10i",
    "nobu",
    "peoples-bitcoin",
    "sproto",
    "sproto-fighter",
    "sproto-arcade",
    "sproto-shooter",
    "sproto-coop-battle"
  ];
  var RELIC_IDS = [
    "hpos10i_core",
    "genesis_shard",
    "cones_tip",
    "tinubu_crown",
    "tidebreaker_belt",
    "breakwater_coin",
    "marina_anchor",
    "dragon_scale"
  ];
  var FOUR_LIGHTS_RELIC_IDS = ["hpos10i_core", "genesis_shard", "cones_tip", "tinubu_crown"];
  var RELIC_BY_GAME = {
    hpos10i: "hpos10i_core",
    "peoples-bitcoin": "genesis_shard",
    nobu: "cones_tip",
    sproto: "tinubu_crown",
    "sproto-fighter": "tidebreaker_belt",
    "sproto-arcade": "breakwater_coin",
    "sproto-coop-battle": "marina_anchor",
    "sproto-shooter": "dragon_scale"
  };
  var BoardId = {
    Hpos10iActTime: "hpos10i_act_time",
    NobuTrialTime: "nobu_trial_time",
    PbTotalXp: "pb_total_xp",
    SprotoWins: "sproto_wins",
    Meta: "meta"
  };
  var BOARD_IDS = [
    BoardId.Hpos10iActTime,
    BoardId.NobuTrialTime,
    BoardId.PbTotalXp,
    BoardId.SprotoWins,
    BoardId.Meta
  ];
  var TICKETS_PER_VERSE = 10;
  var VERSE_DAILY_CAP = 50;
  var MOCK_TICKET_EARN_CAP = 1e3;
  var MOCK_TICKET_TTL_SECONDS = 60;
  var SAVE_MAX_BYTES = 4096;
  var NOBU_TRIAL_FLOOR_MS = {
    "1": 15e3,
    "2": 15e3,
    "3": 12e3,
    "1v2": 25700,
    "2v2": 26e3,
    "3v2": 20600,
    "4": 24e3,
    "6": 3e4,
    "5": 21e3
  };
  var NOBU_TRIAL_CEIL_MS = 18e5;
  function isGameId(value) {
    return GAME_IDS.includes(value);
  }
  function canonicalGameId(value) {
    return isGameId(value) ? value : null;
  }
  function isRelicId(value) {
    return RELIC_IDS.includes(value);
  }
  function isBoardId(value) {
    return BOARD_IDS.includes(value);
  }

  // packages/hub-sdk/src/events.ts
  var HubEvent = {
    Ready: "ready",
    GameBeaten: "game_beaten",
    Hpos10iLevelComplete: "hpos10i.level_complete",
    Hpos10iBossDefeated: "hpos10i.boss_defeated",
    PbQuestComplete: "pb.quest_complete",
    NobuBossDefeated: "nobu.boss_defeated",
    SprotoBossDefeated: "sproto.boss_defeated",
    FighterStoryLevelComplete: "fighter.story_level_complete",
    ArcadeBossDefeated: "arcade.boss_defeated",
    CoopStageClear: "coop.stage_clear",
    ShooterWaveClear: "shooter.wave_clear"
  };
  function record(data) {
    return data;
  }
  function relicForEvent(game, eventId, data) {
    const payload = record(data);
    const own = RELIC_BY_GAME[game];
    if (eventId === HubEvent.Ready || eventId === HubEvent.GameBeaten) return void 0;
    if (eventId === HubEvent.Hpos10iLevelComplete && game === "hpos10i") {
      if (payload.zone === "z1_retro_rush_hills" && payload.act === 1) return own;
      return void 0;
    }
    if (eventId === HubEvent.PbQuestComplete && game === "peoples-bitcoin") {
      if (payload.questId === "quest_tutorial") return own;
      return void 0;
    }
    if (eventId === HubEvent.NobuBossDefeated && game === "nobu") {
      if (payload.boss === "cone") return own;
      return void 0;
    }
    if (eventId === HubEvent.SprotoBossDefeated && game === "sproto") {
      if (payload.boss === "tinubu") return own;
      return void 0;
    }
    if (eventId === HubEvent.FighterStoryLevelComplete && game === "sproto-fighter") {
      if (payload.world === 1) return own;
      return void 0;
    }
    if (eventId === HubEvent.ArcadeBossDefeated && game === "sproto-arcade") {
      if (payload.boss === "bront") return own;
      return void 0;
    }
    if (eventId === HubEvent.CoopStageClear && game === "sproto-coop-battle") {
      if (payload.stage === 1) return own;
      return void 0;
    }
    if (eventId === HubEvent.ShooterWaveClear && game === "sproto-shooter") {
      if (payload.wave === 1) return own;
      return void 0;
    }
    return void 0;
  }

  // packages/hub-sdk/src/errors.ts
  var HubSdkError = class extends Error {
    code;
    status;
    /** Tickets still allowed under the cap that rejected the call. */
    capLeft;
    sessionCapLeft;
    dailyCapLeft;
    constructor(code, message, status, capLeft, sessionCapLeft, dailyCapLeft) {
      super(message);
      this.name = "HubSdkError";
      this.code = code;
      this.status = status;
      this.capLeft = capLeft;
      this.sessionCapLeft = sessionCapLeft ?? (code === "session_ticket_cap" ? capLeft : void 0);
      this.dailyCapLeft = dailyCapLeft ?? (code === "daily_ticket_cap" ? capLeft : void 0);
    }
  };

  // packages/hub-sdk/src/save.ts
  var EMPTY_SAVE = Object.freeze({ data: null, updatedAt: 0 });
  function encodeSave(data) {
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      throw new HubSdkError("bad_save", "A save must be a JSON object");
    }
    let text;
    try {
      text = JSON.stringify(data);
    } catch {
      throw new HubSdkError("bad_save", "A save must be JSON");
    }
    if (new TextEncoder().encode(text).length > SAVE_MAX_BYTES) {
      throw new HubSdkError("save_too_large", `A save is at most ${SAVE_MAX_BYTES} bytes`);
    }
    return text;
  }
  function readSaveResult(body) {
    const raw = body ?? {};
    const data = raw.data && typeof raw.data === "object" && !Array.isArray(raw.data) ? raw.data : null;
    const updatedAt = typeof raw.updatedAt === "number" && Number.isFinite(raw.updatedAt) ? raw.updatedAt : 0;
    return { data, updatedAt: data ? updatedAt : 0 };
  }

  // packages/hub-sdk/src/storage.ts
  var DEVICE_ID_KEY = "hub:deviceId";
  function memoryKeyValue() {
    const map = /* @__PURE__ */ new Map();
    return {
      getItem: (key) => map.has(key) ? map.get(key) : null,
      setItem: (key, value) => {
        map.set(key, value);
      },
      removeItem: (key) => {
        map.delete(key);
      }
    };
  }
  function browserKeyValue(kind) {
    if (typeof window === "undefined") return memoryKeyValue();
    try {
      const store = kind === "local" ? window.localStorage : window.sessionStorage;
      const probe = "hub:storage-probe";
      store.setItem(probe, "1");
      store.removeItem(probe);
      return store;
    } catch {
      return memoryKeyValue();
    }
  }
  function getOrCreateDeviceId(storage = browserKeyValue("local")) {
    const existing = storage.getItem(DEVICE_ID_KEY);
    if (existing) return existing;
    const id = crypto.randomUUID();
    storage.setItem(DEVICE_ID_KEY, id);
    return id;
  }
  function readNumber(storage, key) {
    const raw = storage.getItem(key);
    if (!raw) return 0;
    const value = Number(raw);
    return Number.isFinite(value) ? value : 0;
  }
  function writeNumber(storage, key, value) {
    storage.setItem(key, String(value));
  }

  // packages/hub-sdk/src/ticket.ts
  var MOCK_TICKET_KEY = "metaverse-hub-m0-mock-ticket-key";
  var ISSUER = "hub-mock";
  function bytesToBase64Url(bytes) {
    let binary = "";
    for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i] ?? 0);
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  }
  function base64UrlToBytes(value) {
    const pad = value.length % 4 === 0 ? "" : "=".repeat(4 - value.length % 4);
    const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/") + pad);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }
  async function hmac(payload) {
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(MOCK_TICKET_KEY),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
    const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
    return bytesToBase64Url(new Uint8Array(sig));
  }
  async function mintMockTicket(options) {
    const now = options.now ?? Date.now();
    const claims = {
      jti: options.jti ?? crypto.randomUUID(),
      game: options.game,
      ranked: options.ranked ?? false,
      iat: Math.floor(now / 1e3),
      exp: Math.floor(now / 1e3) + (options.ttlSeconds ?? MOCK_TICKET_TTL_SECONDS),
      iss: ISSUER,
      playerId: options.playerId
    };
    const payload = bytesToBase64Url(new TextEncoder().encode(JSON.stringify(claims)));
    const sig = await hmac(payload);
    return `${payload}.${sig}`;
  }
  async function verifyMockTicket(token) {
    const parts = token.split(".");
    if (parts.length !== 2) return null;
    const payload = parts[0];
    const sig = parts[1];
    if (!payload || !sig) return null;
    const expected = await hmac(payload);
    if (expected !== sig) return null;
    try {
      const json = new TextDecoder().decode(base64UrlToBytes(payload));
      const claims = JSON.parse(json);
      if (claims.iss !== ISSUER) return null;
      if (typeof claims.jti !== "string" || typeof claims.playerId !== "string") return null;
      if (typeof claims.game !== "string" || !isGameId(claims.game)) return null;
      if (typeof claims.exp !== "number" || typeof claims.iat !== "number") return null;
      if (typeof claims.ranked !== "boolean") return null;
      return claims;
    } catch {
      return null;
    }
  }
  function readTicketParam(hash) {
    const raw = hash.startsWith("#") ? hash.slice(1) : hash;
    if (!raw) return null;
    return new URLSearchParams(raw).get("t");
  }
  function stripTicketParam(hash) {
    const raw = hash.startsWith("#") ? hash.slice(1) : hash;
    const params = new URLSearchParams(raw);
    params.delete("t");
    const next = params.toString();
    return next ? `#${next}` : "";
  }

  // packages/hub-sdk/src/env.ts
  function defaultEnv() {
    if (typeof window === "undefined") {
      throw new HubSdkError("no_window", "createHubSdk() needs a browser, or pass an env for tests");
    }
    return {
      hubUrl: "/hub/",
      local: browserKeyValue("local"),
      session: browserKeyValue("session"),
      now: () => Date.now(),
      readHash: () => window.location.hash,
      writeHash: (hash) => {
        const next = `${window.location.pathname}${window.location.search}${hash}`;
        window.history.replaceState(null, "", next);
      },
      assign: (url) => {
        window.location.assign(url);
      },
      releasePointer: () => {
        if (document.pointerLockElement) document.exitPointerLock();
      },
      clearBeforeUnload: () => {
        window.onbeforeunload = null;
      }
    };
  }
  function resolveHubEnv(env) {
    const browser = typeof window !== "undefined" ? defaultEnv() : null;
    return {
      hubUrl: env.hubUrl ?? browser?.hubUrl ?? "/hub/",
      local: env.local ?? browser?.local ?? memoryKeyValue(),
      session: env.session ?? browser?.session ?? memoryKeyValue(),
      now: env.now ?? browser?.now ?? (() => Date.now()),
      readHash: env.readHash ?? browser?.readHash ?? (() => ""),
      writeHash: env.writeHash ?? browser?.writeHash ?? (() => void 0),
      assign: env.assign ?? browser?.assign ?? (() => void 0),
      releasePointer: env.releasePointer ?? browser?.releasePointer ?? (() => void 0),
      clearBeforeUnload: env.clearBeforeUnload ?? browser?.clearBeforeUnload ?? (() => void 0)
    };
  }

  // packages/hub-sdk/src/pbShop.ts
  var PB_SHOP = {
    "shop_staffwright:item_coom": { shopId: "shop_staffwright", itemId: "item_coom", packSize: 100, price: 7, sellPrice: 2 },
    "shop_staffwright:item_hopium_soda": { shopId: "shop_staffwright", itemId: "item_hopium_soda", packSize: 1, price: 4, sellPrice: 0 },
    "shop_staffwright:item_moonward_hat": { shopId: "shop_staffwright", itemId: "item_moonward_hat", packSize: 1, price: 65, sellPrice: 7 },
    "shop_staffwright:item_moonward_robe": { shopId: "shop_staffwright", itemId: "item_moonward_robe", packSize: 1, price: 88, sellPrice: 13 },
    "shop_staffwright:item_tp_soundbite": { shopId: "shop_staffwright", itemId: "item_tp_soundbite", packSize: 1, price: 9, sellPrice: 0 },
    "shop_staffwright:staff_apprentice": { shopId: "shop_staffwright", itemId: "staff_apprentice", packSize: 1, price: 25, sellPrice: 1 },
    "shop_staffwright:staff_hopium": { shopId: "shop_staffwright", itemId: "staff_hopium", packSize: 1, price: 78, sellPrice: 11 },
    "shop_staffwright:staff_moonward": { shopId: "shop_staffwright", itemId: "staff_moonward", packSize: 1, price: 155, sellPrice: 50 },
    "shop_terminal:contract_grunt": { shopId: "shop_terminal", itemId: "contract_grunt", packSize: 1, price: 78, sellPrice: 10 },
    "shop_terminal:contract_heavy": { shopId: "shop_terminal", itemId: "contract_heavy", packSize: 1, price: 205, sellPrice: 74 },
    "shop_terminal:contract_medic": { shopId: "shop_terminal", itemId: "contract_medic", packSize: 1, price: 49, sellPrice: 4 },
    "shop_terminal:contract_recruit": { shopId: "shop_terminal", itemId: "contract_recruit", packSize: 1, price: 25, sellPrice: 11 },
    "shop_terminal:contract_sniper": { shopId: "shop_terminal", itemId: "contract_sniper", packSize: 1, price: 123, sellPrice: 26 },
    "shop_terminal:gun_ballot_blaster": { shopId: "shop_terminal", itemId: "gun_ballot_blaster", packSize: 1, price: 155, sellPrice: 69 },
    "shop_terminal:gun_campaign_pistol": { shopId: "shop_terminal", itemId: "gun_campaign_pistol", packSize: 1, price: 2, sellPrice: 1 },
    "shop_terminal:gun_confetti_shotgun": { shopId: "shop_terminal", itemId: "gun_confetti_shotgun", packSize: 1, price: 65, sellPrice: 29 },
    "shop_terminal:gun_diamond_minigun": { shopId: "shop_terminal", itemId: "gun_diamond_minigun", packSize: 1, price: 471, sellPrice: 150 },
    "shop_terminal:gun_flippening_railgun": { shopId: "shop_terminal", itemId: "gun_flippening_railgun", packSize: 1, price: 1236, sellPrice: 150 },
    "shop_terminal:gun_golden_veto": { shopId: "shop_terminal", itemId: "gun_golden_veto", packSize: 1, price: 792, sellPrice: 150 },
    "shop_terminal:gun_gremlin_blaster": { shopId: "shop_terminal", itemId: "gun_gremlin_blaster", packSize: 1, price: 295, sellPrice: 132 },
    "shop_terminal:gun_hash_cannon": { shopId: "shop_terminal", itemId: "gun_hash_cannon", packSize: 1, price: 155, sellPrice: 69 },
    "shop_terminal:gun_press_pass_smg": { shopId: "shop_terminal", itemId: "gun_press_pass_smg", packSize: 1, price: 115, sellPrice: 51 },
    "shop_terminal:gun_treasury_rifle": { shopId: "shop_terminal", itemId: "gun_treasury_rifle", packSize: 1, price: 182, sellPrice: 81 },
    "shop_terminal:item_aviators": { shopId: "shop_terminal", itemId: "item_aviators", packSize: 1, price: 78, sellPrice: 35 },
    "shop_terminal:item_black_book": { shopId: "shop_terminal", itemId: "item_black_book", packSize: 1, price: 155, sellPrice: 69 },
    "shop_terminal:item_briefcase_bludgeon": { shopId: "shop_terminal", itemId: "item_briefcase_bludgeon", packSize: 1, price: 155, sellPrice: 69 },
    "shop_terminal:item_business_cards": { shopId: "shop_terminal", itemId: "item_business_cards", packSize: 1, price: 25, sellPrice: 11 },
    "shop_terminal:item_campaign_hat": { shopId: "shop_terminal", itemId: "item_campaign_hat", packSize: 1, price: 25, sellPrice: 11 },
    "shop_terminal:item_campaign_jacket": { shopId: "shop_terminal", itemId: "item_campaign_jacket", packSize: 1, price: 49, sellPrice: 22 },
    "shop_terminal:item_campaign_loafers": { shopId: "shop_terminal", itemId: "item_campaign_loafers", packSize: 1, price: 39, sellPrice: 17 },
    "shop_terminal:item_campaign_slacks": { shopId: "shop_terminal", itemId: "item_campaign_slacks", packSize: 1, price: 39, sellPrice: 17 },
    "shop_terminal:item_charm_tea": { shopId: "shop_terminal", itemId: "item_charm_tea", packSize: 1, price: 39, sellPrice: 2 },
    "shop_terminal:item_circuit_board": { shopId: "shop_terminal", itemId: "item_circuit_board", packSize: 1, price: 65, sellPrice: 6 },
    "shop_terminal:item_combat_boots": { shopId: "shop_terminal", itemId: "item_combat_boots", packSize: 1, price: 107, sellPrice: 48 },
    "shop_terminal:item_concrete_bag": { shopId: "shop_terminal", itemId: "item_concrete_bag", packSize: 1, price: 25, sellPrice: 1 },
    "shop_terminal:item_diamond_boots": { shopId: "shop_terminal", itemId: "item_diamond_boots", packSize: 1, price: 324, sellPrice: 145 },
    "shop_terminal:item_diamond_gauntlets": { shopId: "shop_terminal", itemId: "item_diamond_gauntlets", packSize: 1, price: 324, sellPrice: 145 },
    "shop_terminal:item_diamond_greaves": { shopId: "shop_terminal", itemId: "item_diamond_greaves", packSize: 1, price: 324, sellPrice: 145 },
    "shop_terminal:item_diamond_helm": { shopId: "shop_terminal", itemId: "item_diamond_helm", packSize: 1, price: 279, sellPrice: 125 },
    "shop_terminal:item_diamond_plate": { shopId: "shop_terminal", itemId: "item_diamond_plate", packSize: 1, price: 387, sellPrice: 150 },
    "shop_terminal:item_donor_list": { shopId: "shop_terminal", itemId: "item_donor_list", packSize: 1, price: 25, sellPrice: 11 },
    "shop_terminal:item_filibuster_mace": { shopId: "shop_terminal", itemId: "item_filibuster_mace", packSize: 1, price: 387, sellPrice: 150 },
    "shop_terminal:item_flak_helmet": { shopId: "shop_terminal", itemId: "item_flak_helmet", packSize: 1, price: 78, sellPrice: 10 },
    "shop_terminal:item_flak_pants": { shopId: "shop_terminal", itemId: "item_flak_pants", packSize: 1, price: 88, sellPrice: 39 },
    "shop_terminal:item_flak_vest": { shopId: "shop_terminal", itemId: "item_flak_vest", packSize: 1, price: 107, sellPrice: 20 },
    "shop_terminal:item_focus_soda": { shopId: "shop_terminal", itemId: "item_focus_soda", packSize: 1, price: 25, sellPrice: 0 },
    "shop_terminal:item_gala_tailcoat": { shopId: "shop_terminal", itemId: "item_gala_tailcoat", packSize: 1, price: 155, sellPrice: 69 },
    "shop_terminal:item_gala_top_hat": { shopId: "shop_terminal", itemId: "item_gala_top_hat", packSize: 1, price: 123, sellPrice: 55 },
    "shop_terminal:item_gala_trousers": { shopId: "shop_terminal", itemId: "item_gala_trousers", packSize: 1, price: 123, sellPrice: 55 },
    "shop_terminal:item_gavel_of_order": { shopId: "shop_terminal", itemId: "item_gavel_of_order", packSize: 1, price: 574, sellPrice: 150 },
    "shop_terminal:item_gavel_pendant": { shopId: "shop_terminal", itemId: "item_gavel_pendant", packSize: 1, price: 123, sellPrice: 55 },
    "shop_terminal:item_gold_cards": { shopId: "shop_terminal", itemId: "item_gold_cards", packSize: 1, price: 78, sellPrice: 9 },
    "shop_terminal:item_grip_gloves": { shopId: "shop_terminal", itemId: "item_grip_gloves", packSize: 1, price: 49, sellPrice: 22 },
    "shop_terminal:item_hard_hat": { shopId: "shop_terminal", itemId: "item_hard_hat", packSize: 1, price: 123, sellPrice: 55 },
    "shop_terminal:item_hi_vis_vest": { shopId: "shop_terminal", itemId: "item_hi_vis_vest", packSize: 1, price: 155, sellPrice: 69 },
    "shop_terminal:item_hopium_soda": { shopId: "shop_terminal", itemId: "item_hopium_soda", packSize: 1, price: 4, sellPrice: 0 },
    "shop_terminal:item_iron_gavel": { shopId: "shop_terminal", itemId: "item_iron_gavel", packSize: 1, price: 88, sellPrice: 39 },
    "shop_terminal:item_kevlar_fedora": { shopId: "shop_terminal", itemId: "item_kevlar_fedora", packSize: 1, price: 155, sellPrice: 42 },
    "shop_terminal:item_kevlar_suit": { shopId: "shop_terminal", itemId: "item_kevlar_suit", packSize: 1, price: 226, sellPrice: 90 },
    "shop_terminal:item_kevlar_trousers": { shopId: "shop_terminal", itemId: "item_kevlar_trousers", packSize: 1, price: 182, sellPrice: 58 },
    "shop_terminal:item_miners_espresso": { shopId: "shop_terminal", itemId: "item_miners_espresso", packSize: 1, price: 39, sellPrice: 2 },
    "shop_terminal:item_networking_mints": { shopId: "shop_terminal", itemId: "item_networking_mints", packSize: 1, price: 39, sellPrice: 2 },
    "shop_terminal:item_oak_gavel": { shopId: "shop_terminal", itemId: "item_oak_gavel", packSize: 1, price: 25, sellPrice: 11 },
    "shop_terminal:item_patent_shoes": { shopId: "shop_terminal", itemId: "item_patent_shoes", packSize: 1, price: 123, sellPrice: 55 },
    "shop_terminal:item_pick_quantum": { shopId: "shop_terminal", itemId: "item_pick_quantum", packSize: 1, price: 155, sellPrice: 37 },
    "shop_terminal:item_pick_rusty": { shopId: "shop_terminal", itemId: "item_pick_rusty", packSize: 1, price: 25, sellPrice: 11 },
    "shop_terminal:item_pick_steel": { shopId: "shop_terminal", itemId: "item_pick_steel", packSize: 1, price: 78, sellPrice: 35 },
    "shop_terminal:item_platinum_cards": { shopId: "shop_terminal", itemId: "item_platinum_cards", packSize: 1, price: 155, sellPrice: 37 },
    "shop_terminal:item_power_fedora": { shopId: "shop_terminal", itemId: "item_power_fedora", packSize: 1, price: 123, sellPrice: 55 },
    "shop_terminal:item_power_loafers": { shopId: "shop_terminal", itemId: "item_power_loafers", packSize: 1, price: 123, sellPrice: 55 },
    "shop_terminal:item_power_suit": { shopId: "shop_terminal", itemId: "item_power_suit", packSize: 1, price: 155, sellPrice: 37 },
    "shop_terminal:item_power_trousers": { shopId: "shop_terminal", itemId: "item_power_trousers", packSize: 1, price: 123, sellPrice: 55 },
    "shop_terminal:item_press_blazer": { shopId: "shop_terminal", itemId: "item_press_blazer", packSize: 1, price: 155, sellPrice: 69 },
    "shop_terminal:item_press_headset": { shopId: "shop_terminal", itemId: "item_press_headset", packSize: 1, price: 123, sellPrice: 23 },
    "shop_terminal:item_press_lanyard": { shopId: "shop_terminal", itemId: "item_press_lanyard", packSize: 1, price: 78, sellPrice: 35 },
    "shop_terminal:item_press_slacks": { shopId: "shop_terminal", itemId: "item_press_slacks", packSize: 1, price: 123, sellPrice: 55 },
    "shop_terminal:item_press_sneakers": { shopId: "shop_terminal", itemId: "item_press_sneakers", packSize: 1, price: 123, sellPrice: 55 },
    "shop_terminal:item_protein_shake": { shopId: "shop_terminal", itemId: "item_protein_shake", packSize: 1, price: 25, sellPrice: 0 },
    "shop_terminal:item_rolodex": { shopId: "shop_terminal", itemId: "item_rolodex", packSize: 1, price: 78, sellPrice: 35 },
    "shop_terminal:item_rounds": { shopId: "shop_terminal", itemId: "item_rounds", packSize: 100, price: 3, sellPrice: 1 },
    "shop_terminal:item_smooth_lozenge": { shopId: "shop_terminal", itemId: "item_smooth_lozenge", packSize: 1, price: 39, sellPrice: 2 },
    "shop_terminal:item_steel_beam": { shopId: "shop_terminal", itemId: "item_steel_beam", packSize: 1, price: 39, sellPrice: 2 },
    "shop_terminal:item_steel_toe_boots": { shopId: "shop_terminal", itemId: "item_steel_toe_boots", packSize: 1, price: 123, sellPrice: 55 },
    "shop_terminal:item_thick_skin_tonic": { shopId: "shop_terminal", itemId: "item_thick_skin_tonic", packSize: 1, price: 25, sellPrice: 0 },
    "shop_terminal:item_ticker_amulet": { shopId: "shop_terminal", itemId: "item_ticker_amulet", packSize: 1, price: 387, sellPrice: 150 },
    "shop_terminal:item_ticket_bunker": { shopId: "shop_terminal", itemId: "item_ticket_bunker", packSize: 1, price: 25, sellPrice: 11 },
    "shop_terminal:item_ticket_treasury": { shopId: "shop_terminal", itemId: "item_ticket_treasury", packSize: 1, price: 25, sellPrice: 11 },
    "shop_terminal:item_ticket_trenches": { shopId: "shop_terminal", itemId: "item_ticket_trenches", packSize: 1, price: 25, sellPrice: 11 },
    "shop_terminal:item_toolkit_basic": { shopId: "shop_terminal", itemId: "item_toolkit_basic", packSize: 1, price: 39, sellPrice: 17 },
    "shop_terminal:item_toolkit_elite": { shopId: "shop_terminal", itemId: "item_toolkit_elite", packSize: 1, price: 245, sellPrice: 110 },
    "shop_terminal:item_toolkit_master": { shopId: "shop_terminal", itemId: "item_toolkit_master", packSize: 1, price: 490, sellPrice: 150 },
    "shop_terminal:item_toolkit_pro": { shopId: "shop_terminal", itemId: "item_toolkit_pro", packSize: 1, price: 123, sellPrice: 55 },
    "shop_terminal:item_tp_mic_drop": { shopId: "shop_terminal", itemId: "item_tp_mic_drop", packSize: 1, price: 25, sellPrice: 2 },
    "shop_terminal:item_tp_soundbite": { shopId: "shop_terminal", itemId: "item_tp_soundbite", packSize: 1, price: 9, sellPrice: 0 },
    "shop_terminal:item_tp_zinger": { shopId: "shop_terminal", itemId: "item_tp_zinger", packSize: 1, price: 15, sellPrice: 0 },
    "shop_terminal:item_trigger_gloves": { shopId: "shop_terminal", itemId: "item_trigger_gloves", packSize: 1, price: 155, sellPrice: 69 },
    "shop_terminal:item_veto_hammer": { shopId: "shop_terminal", itemId: "item_veto_hammer", packSize: 1, price: 205, sellPrice: 92 },
    "shop_terminal:item_victory_smoothie": { shopId: "shop_terminal", itemId: "item_victory_smoothie", packSize: 1, price: 65, sellPrice: 6 },
    "shop_terminal:item_work_trousers": { shopId: "shop_terminal", itemId: "item_work_trousers", packSize: 1, price: 123, sellPrice: 55 }
  };
  function pbShopRow(shopId, itemId) {
    return PB_SHOP[shopId + ":" + itemId];
  }

  // packages/hub-sdk/src/nakama.ts
  var LOCAL_NAKAMA = {
    serverUrl: "http://127.0.0.1:7350",
    serverKey: ""
  };
  function sessionVarsFromToken(token) {
    const part = token.split(".")[1];
    if (!part) return {};
    try {
      const json = JSON.parse(new TextDecoder().decode(base64UrlToBytes(part)));
      if (!json.vrs || typeof json.vrs !== "object" || Array.isArray(json.vrs)) return {};
      const out = {};
      for (const [key, value] of Object.entries(json.vrs)) {
        if (typeof value === "string") out[key] = value;
      }
      return out;
    } catch {
      return {};
    }
  }
  function tokenExpiryMs(token) {
    const part = token.split(".")[1];
    if (!part) return 0;
    try {
      const json = JSON.parse(new TextDecoder().decode(base64UrlToBytes(part)));
      return typeof json.exp === "number" && Number.isFinite(json.exp) ? json.exp * 1e3 : 0;
    } catch {
      return 0;
    }
  }
  function userIdFromToken(token) {
    const part = token.split(".")[1];
    if (!part) throw new HubSdkError("bad_token", "Session token is missing a payload");
    try {
      const json = JSON.parse(new TextDecoder().decode(base64UrlToBytes(part)));
      if (!json.uid) throw new HubSdkError("bad_token", "Session token has no user id");
      return json.uid;
    } catch (error) {
      if (error instanceof HubSdkError) throw error;
      throw new HubSdkError("bad_token", "Session token payload is not valid");
    }
  }
  function createNakamaClient(options) {
    const serverUrl = options.serverUrl.replace(/\/$/, "");
    const serverKey = options.serverKey ?? LOCAL_NAKAMA.serverKey;
    const fetchImpl = options.fetchImpl ?? fetch;
    async function postAuth(path, body) {
      const response = await fetchImpl(`${serverUrl}${path}`, {
        method: "POST",
        headers: {
          Authorization: `Basic ${btoa(`${serverKey}:`)}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(body)
      });
      const text = await response.text();
      if (!response.ok) throw new HubSdkError("auth_failed", text || `HTTP ${response.status}`, response.status);
      const parsed = JSON.parse(text);
      if (!parsed.token) throw new HubSdkError("auth_failed", "Auth did not return a token");
      return {
        token: parsed.token,
        refreshToken: parsed.refreshToken || parsed.refresh_token || "",
        userId: userIdFromToken(parsed.token)
      };
    }
    return {
      async authenticateDevice(deviceId, vars) {
        const auth = await postAuth(
          "/v2/account/authenticate/device?create=true",
          vars ? { id: deviceId, vars } : { id: deviceId }
        );
        return { token: auth.token, userId: auth.userId };
      },
      async authenticateCustom(id, create = false, vars) {
        const params = new URLSearchParams({ create: create ? "true" : "false" });
        const body = vars ? { id, vars } : { id };
        const auth = await postAuth(`/v2/account/authenticate/custom?${params}`, body);
        if (!auth.refreshToken) throw new HubSdkError("auth_failed", "Auth did not return a refresh token");
        return auth;
      },
      async sessionRefresh(refreshToken) {
        const auth = await postAuth("/v2/account/session/refresh", { token: refreshToken });
        return { token: auth.token, refreshToken: auth.refreshToken || refreshToken };
      },
      async rpc(id, body, opts) {
        const params = new URLSearchParams({ unwrap: "true" });
        const headers = { "Content-Type": "application/json" };
        if (!opts?.token) throw new HubSdkError("unauthorized", "Missing session");
        headers.Authorization = `Bearer ${opts.token}`;
        const response = await fetchImpl(`${serverUrl}/v2/rpc/${encodeURIComponent(id)}?${params}`, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          keepalive: opts?.keepalive
        });
        const text = await response.text();
        if (!response.ok) throw new HubSdkError("rpc_failed", text || `HTTP ${response.status}`, response.status);
        const parsed = text ? JSON.parse(text) : {};
        if (parsed.error) {
          const num = (value) => typeof value === "number" ? value : void 0;
          const sessionCapLeft = num(parsed.sessionCapLeft);
          const dailyCapLeft = num(parsed.dailyCapLeft);
          const capLeft = num(parsed.capLeft) ?? sessionCapLeft ?? dailyCapLeft;
          throw new HubSdkError(parsed.error, parsed.message || parsed.error, void 0, capLeft, sessionCapLeft, dailyCapLeft);
        }
        return parsed;
      }
    };
  }

  // packages/hub-sdk/src/live.ts
  var HUB_OUTBOX_DB = "hub-outbox";
  var OUTBOX_STORE = "writes";
  var memoryWrites = /* @__PURE__ */ new Map();
  function flatEffects(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      if (typeof item === "number" || typeof item === "boolean" || typeof item === "string") out[key] = item;
    }
    return out;
  }
  function asRelics(value) {
    if (!Array.isArray(value)) return [];
    return value.filter((item) => typeof item === "string" && isRelicId(item));
  }
  function clockMs(value) {
    return typeof value === "number" && Number.isFinite(value) ? value : 0;
  }
  function cloneBody(body) {
    return JSON.parse(JSON.stringify(body));
  }
  function useIndexedDb() {
    return typeof indexedDB !== "undefined";
  }
  function openOutbox() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(HUB_OUTBOX_DB, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(OUTBOX_STORE)) db.createObjectStore(OUTBOX_STORE, { keyPath: "key" });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("indexedDB open failed"));
    });
  }
  function requestDone(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("indexedDB request failed"));
    });
  }
  function transactionDone(tx) {
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("indexedDB transaction failed"));
      tx.onabort = () => reject(tx.error ?? new Error("indexedDB transaction aborted"));
    });
  }
  async function withStore(mode, run) {
    const db = await openOutbox();
    try {
      const tx = db.transaction(OUTBOX_STORE, mode);
      const done = transactionDone(tx);
      const result = await run(tx.objectStore(OUTBOX_STORE));
      await done;
      return result;
    } finally {
      db.close();
    }
  }
  async function readWrite(key) {
    if (!useIndexedDb()) return memoryWrites.get(key) ?? null;
    return withStore("readonly", (store) => requestDone(store.get(key))).then((row) => row ?? null);
  }
  async function listWrites() {
    if (!useIndexedDb()) return [...memoryWrites.values()];
    return withStore("readonly", (store) => requestDone(store.getAll()));
  }
  async function putWrite(record2) {
    if (!useIndexedDb()) {
      memoryWrites.set(record2.key, record2);
      return;
    }
    await withStore("readwrite", (store) => {
      store.put(record2);
    });
  }
  async function remember(record2) {
    const existing = await readWrite(record2.key);
    if (existing) return existing;
    const stored = { ...record2, body: cloneBody(record2.body) };
    await putWrite(stored);
    return stored;
  }
  function tokenUser(token) {
    try {
      return userIdFromToken(token);
    } catch {
      return null;
    }
  }
  function deadSession(error) {
    if (!(error instanceof HubSdkError)) return false;
    if (error.code === "session_closed" || error.code === "unauthorized" || error.code === "not_game_session") return true;
    return error.code === "rpc_failed" && error.status === 401;
  }
  function expiredToken(error) {
    if (!(error instanceof HubSdkError)) return false;
    return error.code === "unauthorized" || error.code === "rpc_failed" && error.status === 401;
  }
  function refreshRefused(error) {
    if (!(error instanceof HubSdkError)) return false;
    if (error.status === 408 || error.status === 429) return false;
    if (error.status !== void 0) return error.status >= 400 && error.status < 500;
    return error.code === "auth_failed" || error.code === "bad_token" || error.code === "unauthorized";
  }
  var RETRY_CODES = /* @__PURE__ */ new Set(["rate_limited", "missing_ticket_key", "missing_recovery_pepper"]);
  function finalRefusal(error) {
    if (!(error instanceof HubSdkError)) return false;
    if (error.status !== void 0 || error.code === "rpc_failed") return false;
    return !deadSession(error) && !RETRY_CODES.has(error.code);
  }
  async function forget(key) {
    if (!useIndexedDb()) {
      memoryWrites.delete(key);
      return;
    }
    await withStore("readwrite", (store) => {
      store.delete(key);
    });
  }
  function createLiveHubSdk(env, client) {
    const resolved = resolveHubEnv(env);
    let active = null;
    function sessionKey(game) {
      return `hub:${game}:session`;
    }
    function readCached(game) {
      const raw = resolved.session.getItem(sessionKey(game));
      if (!raw) return null;
      try {
        const parsed = JSON.parse(raw);
        if (parsed.game !== game || !parsed.token || !parsed.playerId || !parsed.sid) return null;
        if (typeof parsed.ranked !== "boolean") return null;
        return {
          game,
          playerId: parsed.playerId,
          ranked: parsed.ranked,
          sid: parsed.sid,
          token: parsed.token,
          refreshToken: typeof parsed.refreshToken === "string" ? parsed.refreshToken : void 0,
          effects: flatEffects(parsed.effects),
          relics: asRelics(parsed.relics),
          ticketsCapLeft: typeof parsed.ticketsCapLeft === "number" ? parsed.ticketsCapLeft : 0
        };
      } catch {
        resolved.session.removeItem(sessionKey(game));
        return null;
      }
    }
    function writeCached(session) {
      for (const game of GAME_IDS) resolved.session.removeItem(sessionKey(game));
      resolved.session.setItem(sessionKey(session.game), JSON.stringify(session));
      active = session;
    }
    function sessionInfo(session) {
      return {
        token: session.token,
        playerId: session.playerId,
        game: session.game,
        ranked: session.ranked,
        expiresAt: tokenExpiryMs(session.token)
      };
    }
    let shownItems;
    let shownGates;
    function readInventory(profile) {
      shownItems = void 0;
      shownGates = void 0;
      if (Array.isArray(profile.items)) {
        const items = [];
        for (const id of profile.items) {
          if (typeof id === "string" && id && !id.includes("://") && !id.includes("/")) items.push(id);
        }
        shownItems = items;
      }
      if (!Array.isArray(profile.gates)) return;
      const gates = [];
      for (const row of profile.gates) {
        if (!row || typeof row !== "object" || Array.isArray(row)) continue;
        const gate = row;
        if (typeof gate.gateId !== "string" || !gate.gateId) continue;
        const target = typeof gate.target === "string" ? gate.target : null;
        gates.push({
          gateId: gate.gateId,
          unlocked: gate.unlocked === true,
          actionType: typeof gate.actionType === "string" ? gate.actionType : "",
          target: target && !target.includes("://") && !target.includes("/") ? target : null,
          lockedHintPool: typeof gate.lockedHintPool === "string" && gate.lockedHintPool ? gate.lockedHintPool : null
        });
      }
      shownGates = gates;
    }
    function withInventory(result) {
      if (shownItems) result.items = shownItems;
      if (shownGates) result.gates = shownGates;
      return result;
    }
    function profileOf(session, serverTime) {
      return {
        playerId: session.playerId,
        ranked: session.ranked,
        relics: [...session.relics],
        effects: { ...session.effects },
        ticketsCapLeft: session.ticketsCapLeft,
        serverTime
      };
    }
    function standalone(serverTime) {
      active = null;
      return {
        playerId: getOrCreateDeviceId(resolved.local),
        ranked: false,
        relics: [],
        effects: {},
        ticketsCapLeft: 0,
        serverTime
      };
    }
    function noteGrant(session, response) {
      if (!response || typeof response !== "object") return;
      const granted = response.granted;
      if (typeof granted !== "string" || !isRelicId(granted) || session.relics.includes(granted)) return;
      session.relics.push(granted);
      writeCached(session);
    }
    async function transmit(row) {
      let response;
      try {
        response = await client.rpc(row.rpc, { ...row.body, key: row.key }, { token: row.token });
      } catch (error) {
        if (finalRefusal(error)) await forget(row.key).catch(() => void 0);
        throw error;
      }
      await forget(row.key);
      if (active && row.gameId === active.game && row.rpc === "session.event") noteGrant(active, response);
      return response;
    }
    async function rebind(row) {
      if (!active || row.gameId !== active.game || row.token === active.token) return row;
      const owner = tokenUser(row.token);
      if (!owner || owner !== tokenUser(active.token)) return row;
      const next = { ...row, token: active.token };
      await putWrite(next);
      return next;
    }
    async function sendOnce(session, rpc, key, body) {
      const row = await rebind(await remember({ rpc, body, key, token: session.token, gameId: session.game }));
      return transmit(row);
    }
    function dropActive() {
      if (active) resolved.session.removeItem(sessionKey(active.game));
      active = null;
      shownItems = void 0;
      shownGates = void 0;
    }
    let refreshing = null;
    function refreshShared(refreshToken) {
      if (refreshing && refreshing.refreshToken === refreshToken) return refreshing.promise;
      if (!client.sessionRefresh) return Promise.reject(new HubSdkError("auth_failed", "Session refresh is unavailable"));
      const promise = client.sessionRefresh(refreshToken).finally(() => {
        if (refreshing && refreshing.promise === promise) refreshing = null;
      });
      refreshing = { refreshToken, promise };
      return promise;
    }
    function newerSession(game, staleToken) {
      if (active && active.game === game && active.token !== staleToken) return active;
      const cached = readCached(game);
      return cached && cached.token !== staleToken ? cached : null;
    }
    function warnRow(what, error) {
      if (error instanceof HubSdkError) return;
      console.warn(`hub-sdk: ${what}; left queued`, error);
    }
    async function drain(game) {
      let rows;
      try {
        rows = await listWrites();
      } catch (error) {
        console.warn("hub-sdk: could not read the outbox; queued writes wait for the next init", error);
        return;
      }
      let deadToken = null;
      for (const queued of rows) {
        const own = typeof queued.gameId === "string" && canonicalGameId(queued.gameId) === game;
        if (!own) {
          const expiresAt = tokenExpiryMs(queued.token);
          if (expiresAt && expiresAt <= resolved.now()) continue;
        }
        let row = queued;
        try {
          if (own) row = await rebind(queued);
          if (deadToken !== null && row.token === deadToken) continue;
          await transmit(row);
        } catch (error) {
          if (own && active && row.token === active.token && deadSession(error)) {
            deadToken = active.token;
            dropActive();
            continue;
          }
          warnRow(`outbox row ${queued.key} failed`, error);
        }
      }
    }
    async function rememberAuth(game, auth) {
      const vars = sessionVarsFromToken(auth.token);
      let relics = [];
      let effects = {};
      let ticketsCapLeft = 0;
      let playerId = auth.userId;
      let ranked = vars.ranked === "1";
      let serverTime = 0;
      try {
        const profile = await client.rpc("profile.get", {}, { token: auth.token });
        relics = asRelics(profile.relics);
        effects = flatEffects(profile.effects);
        readInventory(profile);
        if (typeof profile.ticketsCapLeft === "number") ticketsCapLeft = profile.ticketsCapLeft;
        if (profile.playerId) playerId = profile.playerId;
        if (profile.ranked === true) ranked = true;
        serverTime = clockMs(profile.serverTime);
      } catch {
      }
      if (!vars.sid) return serverTime;
      writeCached({
        game,
        playerId,
        ranked,
        sid: vars.sid,
        token: auth.token,
        refreshToken: auth.refreshToken || void 0,
        effects,
        relics,
        ticketsCapLeft
      });
      return serverTime;
    }
    async function redeemCustom(game, ticket) {
      const authenticateCustom = client.authenticateCustom;
      if (!authenticateCustom) throw new HubSdkError("auth_failed", "Custom authentication is unavailable");
      const auth = await authenticateCustom(`t:${ticket}`, false, { game });
      const serverTime = await rememberAuth(game, auth);
      return { token: auth.token, refreshToken: auth.refreshToken, serverTime };
    }
    return {
      async redeemTicket({ game: gameId }) {
        const game = canonicalGameId(gameId);
        if (!game) throw new HubSdkError("bad_game", `Unknown game "${gameId}"`);
        const ticket = readTicketParam(resolved.readHash());
        resolved.writeHash(stripTicketParam(resolved.readHash()));
        if (!ticket) throw new HubSdkError("ticket_invalid", "Missing ticket");
        return redeemCustom(game, ticket);
      },
      async init(gameId) {
        const game = canonicalGameId(gameId);
        if (!game) throw new HubSdkError("bad_game", `Unknown game "${gameId}"`);
        const token = readTicketParam(resolved.readHash());
        let serverTime = 0;
        shownItems = void 0;
        shownGates = void 0;
        if (token) {
          resolved.writeHash(stripTicketParam(resolved.readHash()));
          const redeemed = await redeemCustom(game, token);
          serverTime = redeemed.serverTime;
          if (!active) throw new HubSdkError("ticket_invalid", "Redeem did not return a session");
        } else {
          const cached = readCached(game);
          if (!cached) {
            active = null;
          } else {
            const loadProfile = (sessionToken) => client.rpc("profile.get", {}, { token: sessionToken });
            let profile = null;
            let dead = false;
            let current = cached;
            const retryProfile = async () => {
              try {
                profile = await loadProfile(current.token);
              } catch (retryError) {
                dead = deadSession(retryError);
              }
            };
            try {
              profile = await loadProfile(current.token);
            } catch (error) {
              if (expiredToken(error) && current.refreshToken && client.sessionRefresh) {
                const staleToken = current.token;
                try {
                  const fresh = await refreshShared(current.refreshToken);
                  current.token = fresh.token;
                  current.refreshToken = fresh.refreshToken || current.refreshToken;
                  writeCached(current);
                  await retryProfile();
                } catch (refreshError) {
                  const newer = refreshRefused(refreshError) ? newerSession(game, staleToken) : null;
                  if (newer) {
                    current = newer;
                    await retryProfile();
                  } else {
                    dead = refreshRefused(refreshError);
                  }
                }
              } else {
                dead = deadSession(error);
              }
            }
            if (dead) {
              resolved.session.removeItem(sessionKey(game));
              active = null;
            } else if (profile) {
              const loaded = profile;
              current.relics = asRelics(loaded.relics);
              readInventory(loaded);
              if (loaded.playerId) current.playerId = loaded.playerId;
              if (typeof loaded.ticketsCapLeft === "number") current.ticketsCapLeft = loaded.ticketsCapLeft;
              serverTime = clockMs(loaded.serverTime);
              writeCached(current);
            } else {
              active = current;
            }
          }
        }
        await drain(game);
        return withInventory(active ? profileOf(active, serverTime) : standalone(serverTime));
      },
      async reportEvent(eventId, data, key) {
        if (!key) throw new HubSdkError("bad_key", "Idempotency key is required");
        if (!data || typeof data !== "object" || Array.isArray(data)) {
          throw new HubSdkError("bad_event", "Event data must be an object");
        }
        if (!active) return {};
        const result = await sendOnce(active, "session.event", key, { eventId, data });
        const answer = result && typeof result === "object" ? result : {};
        const out = {};
        if (typeof answer.granted === "string" && isRelicId(answer.granted)) out.granted = answer.granted;
        if (typeof answer.tickets === "number" && Number.isSafeInteger(answer.tickets) && answer.tickets >= 0) out.tickets = answer.tickets;
        return out;
      },
      async submitScore(boardId, value, meta) {
        if (!isBoardId(boardId)) throw new HubSdkError("bad_board", `Unknown board "${boardId}"`);
        if (!Number.isFinite(value) || value < 0) throw new HubSdkError("bad_score", "Score must be a non-negative number");
        if (!active) return;
        const godMode = meta?.godMode === true;
        return client.rpc("score.submit", { boardId, value, meta: meta ?? {}, godMode }, { token: active.token });
      },
      getSession() {
        return active ? sessionInfo(active) : null;
      },
      async refreshSession() {
        if (!active) return null;
        const session = active;
        const expiresAt = tokenExpiryMs(session.token);
        if (!expiresAt || expiresAt - resolved.now() > 3e5) return sessionInfo(session);
        if (!client.sessionRefresh || !session.refreshToken) return sessionInfo(session);
        const staleToken = session.token;
        let fresh;
        try {
          fresh = await refreshShared(session.refreshToken);
        } catch (error) {
          const newer = active ? newerSession(active.game, staleToken) : null;
          if (newer) return sessionInfo(newer);
          throw error;
        }
        if (active !== session) return active ? sessionInfo(active) : null;
        if (session.token !== staleToken) return sessionInfo(session);
        session.token = fresh.token;
        session.refreshToken = fresh.refreshToken;
        writeCached(session);
        return sessionInfo(session);
      },
      async getLeaderboard(boardId, opts) {
        if (!isBoardId(boardId)) throw new HubSdkError("bad_board", `Unknown board "${boardId}"`);
        const variant = opts?.variant ?? "";
        if (!active) return { boardId, variant, order: boardId === "hpos10i_act_time" || boardId === "nobu_trial_time" ? "asc" : "desc", rows: [], me: null };
        const body = { boardId };
        if (opts?.variant !== void 0) body.variant = opts.variant;
        if (opts?.limit !== void 0) body.limit = opts.limit;
        return client.rpc("leaderboard.top", body, { token: active.token });
      },
      async loadSave() {
        if (!active) return { ...EMPTY_SAVE };
        return readSaveResult(await client.rpc("save.get", {}, { token: active.token }));
      },
      async writeSave(data) {
        encodeSave(data);
        if (!active) return { ...EMPTY_SAVE };
        return readSaveResult(await client.rpc("save.put", { data }, { token: active.token }));
      },
      async feedbackAccess() {
        if (!active) return { ok: false, reason: "standalone" };
        try {
          const result = await client.rpc("feedback.can", {}, { token: active.token });
          return { ok: true, username: result.username };
        } catch (error) {
          if (error instanceof HubSdkError && error.code !== "rpc_failed") return { ok: false, reason: error.code };
          return { ok: false, reason: "offline" };
        }
      },
      async submitFeedback(input) {
        if (!active) throw new HubSdkError("standalone", "Feedback needs a hub session");
        const result = await client.rpc("feedback.submit", input, { token: active.token });
        return { id: result.id };
      },
      async earnTickets(amount, reason, key) {
        if (!key) throw new HubSdkError("bad_key", "Idempotency key is required");
        if (!Number.isFinite(amount) || amount <= 0) throw new HubSdkError("bad_amount", "Ticket amount must be positive");
        if (!reason) throw new HubSdkError("bad_reason", "A reason is required");
        if (!active) return { balance: 0, capped: false };
        return sendOnce(active, "tickets.earn", key, { amount: Math.floor(amount), reason });
      },
      async exchange(tickets, key) {
        if (!key) throw new HubSdkError("bad_key", "Idempotency key is required");
        if (!Number.isFinite(tickets) || tickets <= 0) {
          throw new HubSdkError("bad_amount", "Exchange amount must be positive");
        }
        if (!active) return { verse: 0, ticketsLeft: 0, balance: 0, receiptId: "noop", verseCapLeft: 0 };
        return sendOnce(active, "tickets.exchange", key, { tickets: Math.floor(tickets) });
      },
      async spendTickets(shopId, itemId, packs, key) {
        if (!key) throw new HubSdkError("bad_key", "Idempotency key is required");
        if (!shopId || !itemId) throw new HubSdkError("unknown_item", "Unknown item");
        if (!Number.isFinite(packs) || packs <= 0 || Math.floor(packs) !== packs) {
          throw new HubSdkError("bad_amount", "Quantity must be a positive integer");
        }
        const packsOut = Math.floor(packs);
        if (!active) return { shop_id: shopId, item_id: itemId, packs: packsOut, units: packsOut, spent: 0, balance: 0 };
        return sendOnce(active, "tickets.spend", key, {
          game: active.game,
          shop_id: shopId,
          item_id: itemId,
          packs: packsOut
        });
      },
      async sellItem(shopId, itemId, packs, key) {
        if (!key) throw new HubSdkError("bad_key", "Idempotency key is required");
        if (!shopId || !itemId) throw new HubSdkError("unknown_item", "Unknown item");
        if (!Number.isFinite(packs) || packs <= 0 || Math.floor(packs) !== packs) {
          throw new HubSdkError("bad_amount", "Quantity must be a positive integer");
        }
        const packsOut = Math.floor(packs);
        if (!active) return { shop_id: shopId, item_id: itemId, packs: packsOut, units: packsOut, credited: 0, balance: 0 };
        return sendOnce(active, "tickets.sell", key, {
          game: active.game,
          shop_id: shopId,
          item_id: itemId,
          packs: packsOut
        });
      },
      async getTicketBalance() {
        if (!active) return { balance: 0, sessionCapLeft: 0, dailyCapLeft: 0, serverTime: 0 };
        const body = await client.rpc("tickets.balance", { game: active.game }, { token: active.token });
        return {
          balance: typeof body.balance === "number" ? body.balance : 0,
          sessionCapLeft: typeof body.sessionCapLeft === "number" ? body.sessionCapLeft : 0,
          dailyCapLeft: typeof body.dailyCapLeft === "number" ? body.dailyCapLeft : 0,
          serverTime: clockMs(body.serverTime)
        };
      },
      exit(reason) {
        if (!active) return;
        const game = active.game;
        const token = active.token;
        resolved.session.removeItem(sessionKey(game));
        active = null;
        resolved.clearBeforeUnload();
        resolved.releasePointer();
        void client.rpc("session.close", { reason: reason ?? "" }, { token, keepalive: true }).catch(() => void 0);
        const base = resolved.hubUrl.replace(/\/$/, "");
        resolved.assign(`${base}/#from=${game}`);
      }
    };
  }

  // packages/hub-sdk/src/createHubSdk.ts
  var BOARD_MODE = {
    hpos10i_act_time: "asc-best",
    nobu_trial_time: "asc-best",
    pb_total_xp: "desc-set",
    sproto_wins: "desc-incr",
    meta: "desc-set"
  };
  function isNobuVariant(value) {
    return Object.prototype.hasOwnProperty.call(NOBU_TRIAL_FLOOR_MS, value);
  }
  function dayKey(now) {
    return new Date(now).toISOString().slice(0, 10);
  }
  function stable(value) {
    if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
    if (Array.isArray(value)) return `[${value.map((item) => stable(item)).join(",")}]`;
    const obj = value;
    const keys = Object.keys(obj).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stable(obj[key])}`).join(",")}}`;
  }
  async function sha256(text) {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
    const bytes = new Uint8Array(digest);
    let binary = "";
    for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i] ?? 0);
    return btoa(binary);
  }
  function createHubSdk(env = {}) {
    if (!env.useMock && (env.client || env.serverUrl != null)) {
      const client = env.client ?? createNakamaClient({
        serverUrl: env.serverUrl ?? "",
        serverKey: env.serverKey ?? LOCAL_NAKAMA.serverKey
      });
      return createLiveHubSdk(env, client);
    }
    return createMockHubSdk(env);
  }
  function createMockHubSdk(env) {
    const resolved = resolveHubEnv(env);
    let active = null;
    function sessionKey(game) {
      return `hub:${game}:session`;
    }
    function spentKey() {
      return "hub:spent-jti";
    }
    function spentSet() {
      const raw = resolved.session.getItem(spentKey());
      if (!raw) return /* @__PURE__ */ new Set();
      try {
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return /* @__PURE__ */ new Set();
        return new Set(parsed.filter((item) => typeof item === "string"));
      } catch {
        return /* @__PURE__ */ new Set();
      }
    }
    function markSpent(jti) {
      const next = [...spentSet(), jti].slice(-64);
      resolved.session.setItem(spentKey(), JSON.stringify(next));
    }
    function readRelics() {
      const raw = resolved.local.getItem("hub:relics");
      if (!raw) return [];
      try {
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [];
        return parsed.filter((item) => typeof item === "string" && isRelicId(item));
      } catch {
        return [];
      }
    }
    function writeRelics(relics) {
      resolved.local.setItem("hub:relics", JSON.stringify(relics));
    }
    function ticketsKey(game) {
      return `hub:tickets:${game}`;
    }
    function bucketNow() {
      return env.serverNow ? env.serverNow() : resolved.now();
    }
    function earnKey(game) {
      return `hub:earn:${game}:${dayKey(bucketNow())}`;
    }
    function verseDayKey(game) {
      return `hub:verseDay:${game}:${dayKey(bucketNow())}`;
    }
    function capLeft(game) {
      return Math.max(0, MOCK_TICKET_EARN_CAP - readNumber(resolved.local, earnKey(game)));
    }
    function sessionCreditKey(sid) {
      return `hub:sessionCredit:${sid}`;
    }
    function creditRooms(session) {
      const sessionEarned = readNumber(resolved.session, sessionCreditKey(session.sid));
      return {
        sessionRoom: Math.max(0, 200 - sessionEarned),
        dailyRoom: capLeft(session.game)
      };
    }
    function rejectCap(code, left) {
      throw new HubSdkError(code, code, void 0, left);
    }
    function applyCredit(session, amount, whole) {
      const rooms = creditRooms(session);
      if (whole && amount > rooms.sessionRoom) rejectCap("session_ticket_cap", rooms.sessionRoom);
      if (whole && amount > rooms.dailyRoom) rejectCap("daily_ticket_cap", rooms.dailyRoom);
      const applied = whole ? amount : Math.min(amount, rooms.dailyRoom);
      if (applied > 0) {
        writeNumber(resolved.local, earnKey(session.game), readNumber(resolved.local, earnKey(session.game)) + applied);
        writeNumber(
          resolved.session,
          sessionCreditKey(session.sid),
          readNumber(resolved.session, sessionCreditKey(session.sid)) + applied
        );
      }
      const balance = readNumber(resolved.local, ticketsKey(session.game)) + applied;
      writeNumber(resolved.local, ticketsKey(session.game), balance);
      return { applied, balance };
    }
    function profile(session) {
      return {
        playerId: session.playerId,
        ranked: session.ranked,
        relics: readRelics(),
        effects: { ...session.effects },
        ticketsCapLeft: capLeft(session.game),
        serverTime: bucketNow()
      };
    }
    function standaloneProfile() {
      return {
        playerId: getOrCreateDeviceId(resolved.local),
        ranked: false,
        relics: [],
        effects: {},
        ticketsCapLeft: 0,
        serverTime: bucketNow()
      };
    }
    function openSession(claims) {
      for (const game of GAME_IDS) resolved.session.removeItem(sessionKey(game));
      const session = {
        game: claims.game,
        playerId: claims.playerId,
        ranked: claims.ranked,
        sid: crypto.randomUUID(),
        ticketJti: claims.jti,
        effects: {}
      };
      resolved.session.setItem(sessionKey(claims.game), JSON.stringify(session));
      active = session;
      return session;
    }
    function mockSessionInfo() {
      if (!active) return null;
      return {
        token: `mock.${active.playerId}`,
        playerId: active.playerId,
        game: active.game,
        ranked: active.ranked,
        expiresAt: resolved.now() + 72e5
      };
    }
    async function withIdem(playerId, key, rpc, body, run) {
      if (!key) throw new HubSdkError("bad_key", "Idempotency key is required");
      const hash = await sha256(`${rpc}:${body}`);
      const storageKey = `hub:idem:${playerId}:${key}`;
      const existing = resolved.local.getItem(storageKey);
      if (existing) {
        const rec = JSON.parse(existing);
        if (rec.rpc !== rpc || rec.hash !== hash) {
          throw new HubSdkError("idempotency_mismatch", "Idempotency key was reused with a different request");
        }
        return rec.response;
      }
      const response = run();
      resolved.local.setItem(storageKey, JSON.stringify({ rpc, hash, response }));
      return response;
    }
    return {
      async redeemTicket({ game: gameId }) {
        const game = canonicalGameId(gameId);
        if (!game) throw new HubSdkError("bad_game", `Unknown game "${gameId}"`);
        const token = readTicketParam(resolved.readHash());
        resolved.writeHash(stripTicketParam(resolved.readHash()));
        if (!token) throw new HubSdkError("ticket_invalid", "Missing ticket");
        const claims = await verifyMockTicket(token);
        if (!claims) throw new HubSdkError("ticket_invalid", "Ticket signature or payload is not valid");
        if (claims.exp * 1e3 <= resolved.now()) throw new HubSdkError("ticket_expired", "Ticket expired");
        if (claims.game !== game) throw new HubSdkError("ticket_game", "Ticket is for a different game");
        if (spentSet().has(claims.jti)) throw new HubSdkError("ticket_used", "Ticket was already redeemed");
        markSpent(claims.jti);
        const session = openSession(claims);
        return { token: `mock.${session.playerId}`, refreshToken: `mock-refresh.${session.playerId}` };
      },
      async init(gameId) {
        const game = canonicalGameId(gameId);
        if (!game) throw new HubSdkError("bad_game", `Unknown game "${gameId}"`);
        const token = readTicketParam(resolved.readHash());
        if (token) {
          const claims = await verifyMockTicket(token);
          if (!claims) throw new HubSdkError("ticket_invalid", "Ticket signature or payload is not valid");
          if (claims.exp * 1e3 <= resolved.now()) throw new HubSdkError("ticket_expired", "Ticket expired");
          if (claims.game !== game) throw new HubSdkError("ticket_game", "Ticket is for a different game");
          if (spentSet().has(claims.jti)) throw new HubSdkError("ticket_used", "Ticket was already redeemed");
          markSpent(claims.jti);
          resolved.writeHash(stripTicketParam(resolved.readHash()));
          return profile(openSession(claims));
        }
        const saved = resolved.session.getItem(sessionKey(game));
        if (saved) {
          try {
            const session = JSON.parse(saved);
            if (session.game === game && session.playerId) {
              active = session;
              return profile(session);
            }
          } catch {
            resolved.session.removeItem(sessionKey(game));
          }
        }
        active = null;
        return standaloneProfile();
      },
      async reportEvent(eventId, data, key) {
        if (!key) throw new HubSdkError("bad_key", "Idempotency key is required");
        if (!data || typeof data !== "object") throw new HubSdkError("bad_event", "Event data must be an object");
        if (!active) return {};
        const session = active;
        return withIdem(session.playerId, key, "session.event", stable({ eventId, data }), () => {
          const relic = relicForEvent(session.game, eventId, data);
          if (!relic) return {};
          const owned = readRelics();
          if (owned.includes(relic)) return {};
          writeRelics([...owned, relic]);
          return { granted: relic };
        });
      },
      async submitScore(boardId, value, meta) {
        if (!isBoardId(boardId)) throw new HubSdkError("bad_board", `Unknown board "${boardId}"`);
        if (!Number.isFinite(value) || value < 0) throw new HubSdkError("bad_score", "Score must be a non-negative number");
        if (!active) return;
        const metaObj = meta && typeof meta === "object" ? meta : {};
        if (boardId === "meta" || boardId === "sproto_wins") return { accepted: false, reason: "server_board" };
        if (!active.ranked && (active.game === "hpos10i" || active.game === "sproto")) return { accepted: false, reason: "unranked" };
        if (metaObj.godMode === true) return { accepted: false, reason: "god_mode" };
        let variant = "";
        if (boardId === "nobu_trial_time") {
          variant = String(metaObj.level ?? "");
          if (!isNobuVariant(variant)) throw new HubSdkError("bad_variant", "Unknown level");
          const floor = NOBU_TRIAL_FLOOR_MS[variant];
          if (!Number.isInteger(value)) throw new HubSdkError("bad_score", "Time must be integer milliseconds");
          if (value < floor || value > NOBU_TRIAL_CEIL_MS) throw new HubSdkError("implausible_score", "Time is out of bounds");
        }
        const storageKey = `hub:score:${active.playerId}:${boardId}${variant ? `:${variant}` : ""}`;
        const previous = readNumber(resolved.local, storageKey);
        const hasPrevious = resolved.local.getItem(storageKey) !== null;
        const mode = BOARD_MODE[boardId];
        const whole = Math.round(value);
        let next = whole;
        if (mode === "asc-best") next = hasPrevious ? Math.min(previous, whole) : whole;
        if (mode === "desc-incr") next = previous + whole;
        const posted = !hasPrevious || next !== previous;
        writeNumber(resolved.local, storageKey, next);
        if (posted) resolved.local.setItem(`${storageKey}:meta`, stable(metaObj));
        return { accepted: true, posted, value: next, order: mode === "asc-best" ? "asc" : "desc" };
      },
      getSession() {
        return mockSessionInfo();
      },
      async refreshSession() {
        return mockSessionInfo();
      },
      async getLeaderboard(boardId, opts) {
        if (!isBoardId(boardId)) throw new HubSdkError("bad_board", `Unknown board "${boardId}"`);
        const variant = opts?.variant ?? "";
        const order = BOARD_MODE[boardId] === "asc-best" ? "asc" : "desc";
        if (!active) return { boardId, variant, order, rows: [], me: null };
        if (boardId === "nobu_trial_time" && !isNobuVariant(variant)) throw new HubSdkError("bad_variant", "Unknown level");
        const raw = resolved.local.getItem(`hub:score:${active.playerId}:${boardId}${variant ? `:${variant}` : ""}`);
        if (raw === null) return { boardId, variant, order, rows: [], me: null };
        const row = { userId: active.playerId, name: active.playerId, value: Number(raw), rank: 1 };
        return { boardId, variant, order, rows: [row], me: row };
      },
      async loadSave() {
        if (!active) return { ...EMPTY_SAVE };
        const raw = resolved.local.getItem(`hub:save:${active.playerId}:${active.game}`);
        if (raw === null) return { ...EMPTY_SAVE };
        try {
          const stored = JSON.parse(raw);
          return { data: stored.data, updatedAt: stored.updatedAt };
        } catch {
          return { ...EMPTY_SAVE };
        }
      },
      async writeSave(data) {
        const text = encodeSave(data);
        if (!active) return { ...EMPTY_SAVE };
        const stored = { data: JSON.parse(text), updatedAt: bucketNow() };
        resolved.local.setItem(`hub:save:${active.playerId}:${active.game}`, JSON.stringify(stored));
        return stored;
      },
      async feedbackAccess() {
        return active ? { ok: true, username: active.playerId } : { ok: false, reason: "standalone" };
      },
      async submitFeedback(input) {
        if (!active) throw new HubSdkError("standalone", "Feedback needs a hub session");
        if (!input.categories.length && !input.note.trim()) throw new HubSdkError("empty", "Pick an option or write a note");
        const key = `hub:feedback:${active.game}`;
        const list = JSON.parse(resolved.local.getItem(key) ?? "[]");
        const id = `MOCK-${String(list.length + 1).padStart(4, "0")}`;
        list.push({ id, username: active.playerId, ...input, image: input.image ? "(image)" : "" });
        resolved.local.setItem(key, JSON.stringify(list.slice(-50)));
        return { id };
      },
      async earnTickets(amount, reason, key) {
        if (!key) throw new HubSdkError("bad_key", "Idempotency key is required");
        if (!Number.isFinite(amount) || amount <= 0) throw new HubSdkError("bad_amount", "Ticket amount must be positive");
        if (!reason) throw new HubSdkError("bad_reason", "A reason is required");
        if (!active) return { balance: 0, capped: false };
        const session = active;
        const whole = Math.floor(amount);
        return withIdem(session.playerId, key, "tickets.earn", stable({ amount: whole, reason }), () => {
          const credited = applyCredit(session, whole, false);
          return { balance: credited.balance, capped: credited.applied < whole };
        });
      },
      async exchange(tickets, key) {
        if (!key) throw new HubSdkError("bad_key", "Idempotency key is required");
        if (!Number.isFinite(tickets) || tickets <= 0) {
          throw new HubSdkError("bad_amount", "Exchange amount must be positive");
        }
        if (!active) return { verse: 0, ticketsLeft: 0, balance: 0, receiptId: "noop", verseCapLeft: 0 };
        const session = active;
        const requested = Math.floor(tickets);
        return withIdem(session.playerId, key, "tickets.exchange", stable({ tickets: requested }), () => {
          let verseOut = Math.floor(requested / TICKETS_PER_VERSE);
          if (verseOut <= 0) {
            throw new HubSdkError("below_rate", `Need at least ${TICKETS_PER_VERSE} Tickets to mint 1 Verse`);
          }
          const today = readNumber(resolved.local, verseDayKey(session.game));
          const room = VERSE_DAILY_CAP - today;
          if (room <= 0) throw new HubSdkError("verse_cap", "Daily Verse cap reached for this game");
          verseOut = Math.min(verseOut, room);
          const debit = verseOut * TICKETS_PER_VERSE;
          const balance = readNumber(resolved.local, ticketsKey(session.game));
          if (balance < debit) throw new HubSdkError("insufficient_tickets", "Not enough Tickets");
          const ticketsLeft = balance - debit;
          const verse = readNumber(resolved.local, "hub:verse") + verseOut;
          writeNumber(resolved.local, ticketsKey(session.game), ticketsLeft);
          writeNumber(resolved.local, "hub:verse", verse);
          writeNumber(resolved.local, verseDayKey(session.game), today + verseOut);
          return { verse, ticketsLeft, balance: ticketsLeft, receiptId: crypto.randomUUID(), verseCapLeft: VERSE_DAILY_CAP - (today + verseOut) };
        });
      },
      async spendTickets(shopId, itemId, packs, key) {
        if (!key) throw new HubSdkError("bad_key", "Idempotency key is required");
        if (!shopId || !itemId) throw new HubSdkError("unknown_item", "Unknown item");
        if (!Number.isFinite(packs) || packs <= 0 || Math.floor(packs) !== packs) {
          throw new HubSdkError("bad_amount", "Quantity must be a positive integer");
        }
        const whole = Math.floor(packs);
        if (!active) return { shop_id: shopId, item_id: itemId, packs: whole, units: whole, spent: 0, balance: 0 };
        const session = active;
        return withIdem(session.playerId, key, "tickets.spend", stable({ shopId, itemId, packs: whole }), () => {
          const row = session.game === "peoples-bitcoin" ? pbShopRow(shopId, itemId) : void 0;
          if (!row) throw new HubSdkError("unknown_item", "Unknown item");
          const spent = row.price * whole;
          const balance = readNumber(resolved.local, ticketsKey(session.game));
          if (balance < spent) throw new HubSdkError("insufficient_tickets", "Not enough Tickets");
          const next = balance - spent;
          writeNumber(resolved.local, ticketsKey(session.game), next);
          return { shop_id: shopId, item_id: itemId, packs: whole, units: row.packSize * whole, spent, balance: next };
        });
      },
      async sellItem(shopId, itemId, packs, key) {
        if (!key) throw new HubSdkError("bad_key", "Idempotency key is required");
        if (!shopId || !itemId) throw new HubSdkError("unknown_item", "Unknown item");
        if (!Number.isFinite(packs) || packs <= 0 || Math.floor(packs) !== packs) {
          throw new HubSdkError("bad_amount", "Quantity must be a positive integer");
        }
        const whole = Math.floor(packs);
        if (!active) return { shop_id: shopId, item_id: itemId, packs: whole, units: whole, credited: 0, balance: 0 };
        const session = active;
        return withIdem(session.playerId, key, "tickets.sell", stable({ shopId, itemId, packs: whole }), () => {
          const row = session.game === "peoples-bitcoin" ? pbShopRow(shopId, itemId) : void 0;
          if (!row) throw new HubSdkError("unknown_item", "Unknown item");
          const credited = row.sellPrice * whole;
          if (credited <= 0) throw new HubSdkError("zero_value", "This item cannot be sold");
          const next = applyCredit(session, credited, true);
          return { shop_id: shopId, item_id: itemId, packs: whole, units: row.packSize * whole, credited, balance: next.balance };
        });
      },
      async getTicketBalance() {
        const serverTime = bucketNow();
        if (!active) return { balance: 0, sessionCapLeft: 0, dailyCapLeft: 0, serverTime };
        const rooms = creditRooms(active);
        return {
          balance: readNumber(resolved.local, ticketsKey(active.game)),
          sessionCapLeft: rooms.sessionRoom,
          dailyCapLeft: rooms.dailyRoom,
          serverTime
        };
      },
      exit(_reason) {
        if (!active) return;
        const game = active.game;
        resolved.session.removeItem(sessionKey(game));
        active = null;
        resolved.clearBeforeUnload();
        resolved.releasePointer();
        const base = resolved.hubUrl.replace(/\/$/, "");
        resolved.assign(`${base}/#from=${game}`);
      }
    };
  }
  function installHubSdk(sdk = createHubSdk()) {
    if (typeof window !== "undefined") window.hubSdk = sdk;
    return sdk;
  }

  // packages/hub-sdk/src/realtime/friends.ts
  function createFriendsStub() {
    const nope = () => Promise.reject(new HubSdkError("not_implemented", "Friends are not available yet"));
    return { list: nope, add: nope, remove: nope, block: nope };
  }

  // packages/hub-sdk/src/realtime/protocol.ts
  var utf8Encoder = new TextEncoder();
  var utf8Decoder = new TextDecoder();
  function utf8Encode(text) {
    return utf8Encoder.encode(text);
  }
  function utf8Decode(bytes) {
    return utf8Decoder.decode(bytes);
  }
  function bytesToBase64(bytes) {
    let binary = "";
    const chunk = 32768;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
  }
  function base64ToBytes(text) {
    const binary = atob(text);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
    return out;
  }
  function encodePayload(data) {
    if (data === void 0) return new Uint8Array(0);
    if (data instanceof Uint8Array) return data;
    if (typeof data === "string") return utf8Encode(data);
    return utf8Encode(JSON.stringify(data));
  }
  function presenceFromWire(p) {
    return { userId: p?.user_id ?? "", sessionId: p?.session_id ?? "", username: p?.username ?? "" };
  }
  function presenceToWire(p) {
    return { user_id: p.userId, session_id: p.sessionId, username: p.username };
  }
  function matchmakerUserFromWire(u) {
    return {
      presence: presenceFromWire(u?.presence),
      stringProperties: { ...u?.string_properties ?? {} },
      numericProperties: { ...u?.numeric_properties ?? {} }
    };
  }
  function labelFromWire(label) {
    if (label === null || label === void 0) return null;
    if (typeof label === "string") return label;
    return typeof label.value === "string" ? label.value : null;
  }
  function opCodeFromWire(op) {
    const n = typeof op === "number" ? op : Number(op ?? 0);
    return Number.isFinite(n) ? n : 0;
  }
  function timeFromWire(value) {
    if (typeof value === "number") return value;
    if (!value) return 0;
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? ms : 0;
  }
  function channelJoinBody(target, persistence, hidden) {
    if ("room" in target) return { target: target.room, type: 1, persistence, hidden };
    if ("direct" in target) return { target: target.direct, type: 2, persistence, hidden };
    return { target: target.group, type: 3, persistence, hidden };
  }
  function chatContentFromWire(raw) {
    if (!raw) return { text: "" };
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const obj = parsed;
        return { ...obj, text: typeof obj.text === "string" ? obj.text : "" };
      }
      return { text: typeof parsed === "string" ? parsed : String(parsed) };
    } catch {
      return { text: raw };
    }
  }
  function chatMessageFromWire(m) {
    return {
      channelId: m.channel_id ?? "",
      messageId: m.message_id ?? "",
      senderId: m.sender_id ?? "",
      username: m.username ?? "",
      content: chatContentFromWire(m.content),
      createdAt: timeFromWire(m.create_time),
      persistent: m.persistent === true
    };
  }
  function errorCodeFromMessage(message, fallback) {
    if (!message) return fallback;
    const stripped = message.replace(/^\s*(?:Error:\s*)?/, "");
    const match = /^[a-z0-9_:.-]+/.exec(stripped);
    return match ? match[0] : fallback;
  }
  var RT_ERROR = {
    RUNTIME_EXCEPTION: 0,
    UNRECOGNIZED_PAYLOAD: 1,
    MISSING_PAYLOAD: 2,
    BAD_INPUT: 3,
    MATCH_NOT_FOUND: 4,
    MATCH_JOIN_REJECTED: 5,
    RUNTIME_FUNCTION_NOT_FOUND: 6,
    RUNTIME_FUNCTION_EXCEPTION: 7
  };
  function errorFromEnvelope(error, kind = "other") {
    const message = error.message ?? "";
    if (error.code === RT_ERROR.MATCH_NOT_FOUND) return new HubSdkError("match_not_found", message || "Match not found");
    if (error.code === RT_ERROR.MATCH_JOIN_REJECTED || kind === "match_join" && error.code !== RT_ERROR.RUNTIME_EXCEPTION) {
      const reason = errorCodeFromMessage(message, "rejected");
      return new HubSdkError(`match_rejected:${reason}`, message || "Match join rejected");
    }
    return new HubSdkError(errorCodeFromMessage(message, "rt_error"), message || "Realtime error");
  }

  // packages/hub-sdk/src/realtime/client.ts
  var Emitter = class {
    list = /* @__PURE__ */ new Set();
    on(cb) {
      this.list.add(cb);
      return () => {
        this.list.delete(cb);
      };
    }
    get size() {
      return this.list.size;
    }
    emit(...args) {
      for (const cb of [...this.list]) {
        try {
          cb(...args);
        } catch (error) {
          console.error("[hub-sdk realtime] listener failed", error);
        }
      }
    }
    clear() {
      this.list.clear();
    }
  };
  var OPEN = 1;
  function samePresence(a, b) {
    return a.userId === b.userId && a.sessionId === b.sessionId;
  }
  function matchData(matchId, opCode, data, sender, reliable) {
    let text = null;
    return {
      matchId,
      opCode,
      data,
      sender,
      reliable,
      text() {
        if (text === null) text = utf8Decode(data);
        return text;
      },
      json() {
        return JSON.parse(this.text());
      }
    };
  }
  function presenceFromToken(token) {
    try {
      const part = token.split(".")[1] ?? "";
      const json = JSON.parse(utf8Decode(base64ToBytes(part.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(part.length / 4) * 4, "="))));
      return { userId: json.uid ?? "", sessionId: "", username: json.usn ?? "" };
    } catch {
      return { userId: "", sessionId: "", username: "" };
    }
  }
  function matchmakerBody(req) {
    const body = {
      query: req.query,
      min_count: req.minCount,
      max_count: req.maxCount,
      string_properties: req.stringProperties ?? {},
      numeric_properties: req.numericProperties ?? {}
    };
    if (req.countMultiple) body.count_multiple = req.countMultiple;
    return body;
  }
  function createRealtime(options) {
    const timers = options.timers ?? { setTimeout: globalThis.setTimeout.bind(globalThis), clearTimeout: globalThis.clearTimeout.bind(globalThis) };
    const requestTimeoutMs = options.requestTimeoutMs ?? 1e4;
    const reconnectCfg = options.reconnect === false ? null : {
      maxAttempts: options.reconnect?.maxAttempts ?? Infinity,
      baseDelayMs: options.reconnect?.baseDelayMs ?? 500,
      maxDelayMs: options.reconnect?.maxDelayMs ?? 15e3
    };
    let state = "idle";
    let self = null;
    let socket = null;
    let cid = 0;
    let attempt = 0;
    let wanted = false;
    let reconnectTimer = null;
    let connecting = null;
    let lastToken = "";
    let generation = 0;
    let abortConnect = null;
    function isCurrent(gen) {
      return gen === generation && wanted;
    }
    function superseded() {
      return new HubSdkError("rt_closed", "Realtime connection was closed");
    }
    const pending = /* @__PURE__ */ new Map();
    const orphans = /* @__PURE__ */ new Map();
    let joinsInFlight = 0;
    async function joinRequest(body) {
      joinsInFlight += 1;
      try {
        return await request({ match_join: body }, "match_join");
      } finally {
        joinsInFlight -= 1;
      }
    }
    function takeOrphans(matchId) {
      const held = orphans.get(matchId) ?? [];
      orphans.delete(matchId);
      if (joinsInFlight === 0) orphans.clear();
      return held;
    }
    const matches = /* @__PURE__ */ new Map();
    const channels = /* @__PURE__ */ new Map();
    const matchmaker = /* @__PURE__ */ new Map();
    const stateEvents = new Emitter();
    const matchedEvents = new Emitter();
    const notificationEvents = new Emitter();
    const errorEvents = new Emitter();
    function setState(next, info = {}) {
      if (state === next) return;
      state = next;
      stateEvents.emit(next, { attempt, ...info });
    }
    function httpBase() {
      if (options.serverUrl) return options.serverUrl.replace(/\/$/, "");
      if (typeof location !== "undefined") return location.origin;
      throw new HubSdkError("no_server", "serverUrl is required outside a browser");
    }
    function wsUrl(token) {
      const base = httpBase().replace(/^http/, "ws");
      return `${base}/ws?lang=en&status=${options.appearOnline === true}&token=${encodeURIComponent(token)}`;
    }
    function rawSend(env) {
      if (!socket || socket.readyState !== OPEN) throw new HubSdkError("rt_closed", "Realtime socket is not open");
      socket.send(JSON.stringify(env));
    }
    function request(env, kind = "other") {
      if (!socket || socket.readyState !== OPEN || state !== "open") {
        return Promise.reject(new HubSdkError(state === "reconnecting" ? "rt_disconnected" : "rt_closed", "Realtime socket is not open"));
      }
      cid += 1;
      const id = String(cid);
      return new Promise((resolve, reject) => {
        const timer = timers.setTimeout(() => {
          pending.delete(id);
          reject(new HubSdkError("rt_timeout", "Realtime request timed out"));
        }, requestTimeoutMs);
        pending.set(id, { resolve, reject, timer, kind });
        try {
          rawSend({ cid: id, ...env });
        } catch (error) {
          timers.clearTimeout(timer);
          pending.delete(id);
          reject(error instanceof HubSdkError ? error : new HubSdkError("rt_closed", String(error)));
        }
      });
    }
    function rejectPending(code) {
      for (const [id, p] of pending) {
        timers.clearTimeout(p.timer);
        pending.delete(id);
        p.reject(new HubSdkError(code, "Realtime socket closed"));
      }
    }
    function closeMatch(entry, reason) {
      if (entry.closed) return;
      entry.closed = true;
      matches.delete(entry.matchId);
      entry.close.emit(reason);
      entry.message.clear();
      entry.presence.clear();
      entry.rejoin.clear();
      entry.close.clear();
    }
    function onEnvelope(env) {
      if (env.cid) {
        const p = pending.get(env.cid);
        if (p) {
          pending.delete(env.cid);
          timers.clearTimeout(p.timer);
          if (env.error) p.reject(errorFromEnvelope(env.error, p.kind));
          else p.resolve(env);
        }
        return;
      }
      if (env.error) {
        errorEvents.emit(errorFromEnvelope(env.error));
        return;
      }
      if (env.match_data) {
        const d = env.match_data;
        const entry = matches.get(d.match_id ?? "");
        const sender = d.presence && d.presence.user_id ? presenceFromWire(d.presence) : null;
        const bytes = d.data ? base64ToBytes(d.data) : new Uint8Array(0);
        if (!entry) {
          if (joinsInFlight > 0 && d.match_id) {
            const held = orphans.get(d.match_id) ?? [];
            if (held.length < 64) held.push(matchData(d.match_id, opCodeFromWire(d.op_code), bytes, sender, d.reliable !== false));
            orphans.set(d.match_id, held);
          }
          return;
        }
        const msg = matchData(entry.matchId, opCodeFromWire(d.op_code), bytes, sender, d.reliable !== false);
        if (entry.message.size === 0) {
          if (entry.early.length < 256) entry.early.push(msg);
        } else {
          entry.message.emit(msg);
        }
        return;
      }
      if (env.match_presence_event) {
        const e = env.match_presence_event;
        const entry = matches.get(e.match_id ?? "");
        if (!entry) return;
        const joins = (e.joins ?? []).map(presenceFromWire).filter((p) => !samePresence(p, entry.self));
        const leavesAll = (e.leaves ?? []).map(presenceFromWire);
        if (leavesAll.some((p) => samePresence(p, entry.self))) {
          closeMatch(entry, "kicked");
          return;
        }
        for (const p of joins) if (!entry.presences.some((q) => samePresence(p, q))) entry.presences.push(p);
        entry.presences = entry.presences.filter((q) => !leavesAll.some((p) => samePresence(p, q)));
        entry.presence.emit({ joins, leaves: leavesAll });
        return;
      }
      if (env.match_ended) {
        const entry = matches.get(env.match_ended.match_id ?? "");
        if (entry) closeMatch(entry, "ended");
        return;
      }
      if (env.matchmaker_matched) {
        const m = env.matchmaker_matched;
        let ticket = m.ticket ?? "";
        for (const entry of matchmaker.values()) {
          if (entry.current === ticket) {
            ticket = entry.original;
            matchmaker.delete(entry.original);
            break;
          }
        }
        matchedEvents.emit({
          ticket,
          matchId: m.match_id || null,
          token: m.token || null,
          self: matchmakerUserFromWire(m.self),
          users: (m.users ?? []).map(matchmakerUserFromWire)
        });
        return;
      }
      if (env.channel_message) {
        const msg = chatMessageFromWire(env.channel_message);
        const entry = channels.get(msg.channelId);
        if (entry) entry.message.emit(msg);
        return;
      }
      if (env.channel_presence_event) {
        const e = env.channel_presence_event;
        const entry = channels.get(e.channel_id ?? "");
        if (!entry) return;
        const joins = (e.joins ?? []).map(presenceFromWire);
        const leaves = (e.leaves ?? []).map(presenceFromWire);
        for (const p of joins) if (!entry.presences.some((q) => samePresence(p, q))) entry.presences.push(p);
        entry.presences = entry.presences.filter((q) => !leaves.some((p) => samePresence(p, q)));
        entry.presence.emit({ joins, leaves });
        return;
      }
      if (env.notifications) {
        for (const n of env.notifications.notifications ?? []) {
          let content = n.content;
          try {
            content = n.content ? JSON.parse(n.content) : null;
          } catch {
          }
          notificationEvents.emit({
            id: n.id ?? "",
            subject: n.subject ?? "",
            code: typeof n.code === "number" ? n.code : Number(n.code ?? 0),
            content,
            senderId: n.sender_id ?? "",
            persistent: n.persistent === true,
            createdAt: timeFromWire(n.create_time)
          });
        }
      }
    }
    async function openSocket(gen) {
      const token = await options.getToken();
      if (!isCurrent(gen)) throw superseded();
      lastToken = token;
      const Impl = options.WebSocketImpl ?? globalThis.WebSocket;
      if (!Impl) throw new HubSdkError("rt_unavailable", "WebSocket is not available");
      const ws = new Impl(wsUrl(token));
      socket = ws;
      await new Promise((resolve, reject) => {
        let opened = false;
        ws.onopen = () => {
          opened = true;
          resolve();
        };
        ws.onerror = () => {
          if (!opened) reject(new HubSdkError("rt_connect_failed", "Realtime socket failed to open"));
        };
        ws.onclose = (event) => {
          if (!opened) {
            reject(new HubSdkError("rt_connect_failed", `Realtime socket closed (${event.code})`));
            return;
          }
          handleClose(ws, event.code, event.reason);
        };
        ws.onmessage = (event) => {
          if (socket !== ws) return;
          let env;
          try {
            env = JSON.parse(typeof event.data === "string" ? event.data : String(event.data));
          } catch {
            return;
          }
          onEnvelope(env);
        };
      });
      if (!isCurrent(gen) || socket !== ws) {
        if (socket === ws) socket = null;
        try {
          ws.close(1e3, "client disconnect");
        } catch {
        }
        throw superseded();
      }
      self = presenceFromToken(token);
    }
    async function restore(gen) {
      for (const entry of [...matches.values()]) {
        try {
          const env = await joinRequest({ match_id: entry.matchId, metadata: entry.metadata ?? {} });
          if (!isCurrent(gen)) throw superseded();
          const m = env.match ?? {};
          const held = takeOrphans(entry.matchId);
          if (entry.message.size === 0) entry.early.push(...held);
          else for (const msg of held) entry.message.emit(msg);
          entry.self = presenceFromWire(m.self);
          if (entry.self.sessionId) self = entry.self;
          entry.label = labelFromWire(m.label);
          entry.presences = (m.presences ?? []).map(presenceFromWire).filter((p) => !samePresence(p, entry.self));
          entry.rejoin.emit();
        } catch (error) {
          if (error instanceof HubSdkError && (error.code === "rt_disconnected" || error.code === "rt_closed")) throw error;
          closeMatch(entry, "rejoin_failed");
        }
      }
      for (const entry of [...channels.values()]) {
        try {
          const env = await request({ channel_join: channelJoinBody(entry.target, entry.persistence, entry.hidden) });
          if (!isCurrent(gen)) throw superseded();
          entry.presences = (env.channel?.presences ?? []).map(presenceFromWire);
          if (env.channel?.self?.session_id) self = presenceFromWire(env.channel.self);
        } catch (error) {
          if (error instanceof HubSdkError && (error.code === "rt_disconnected" || error.code === "rt_closed")) throw error;
          errorEvents.emit(error instanceof HubSdkError ? error : new HubSdkError("rt_error", String(error)));
        }
      }
      for (const entry of [...matchmaker.values()]) {
        try {
          const env = await request({ matchmaker_add: matchmakerBody(entry.request) });
          if (!isCurrent(gen)) throw superseded();
          entry.current = env.matchmaker_ticket?.ticket ?? entry.current;
        } catch (error) {
          if (error instanceof HubSdkError && (error.code === "rt_disconnected" || error.code === "rt_closed")) throw error;
          matchmaker.delete(entry.original);
          errorEvents.emit(error instanceof HubSdkError ? error : new HubSdkError("rt_error", String(error)));
        }
      }
    }
    async function establish(isReconnect, gen) {
      if (!isCurrent(gen)) throw superseded();
      await openSocket(gen);
      if (!isCurrent(gen)) throw superseded();
      attempt = 0;
      setState("open");
      if (isReconnect) await restore(gen);
    }
    function scheduleReconnect(code, reason) {
      if (!reconnectCfg || !wanted || attempt >= reconnectCfg.maxAttempts) {
        wanted = false;
        setState("closed", { code, reason });
        for (const entry of [...matches.values()]) closeMatch(entry, "rejoin_failed");
        return;
      }
      setState("reconnecting", { code, reason });
      const delay = Math.min(reconnectCfg.maxDelayMs, reconnectCfg.baseDelayMs * 2 ** attempt) * Math.random();
      attempt += 1;
      reconnectTimer = timers.setTimeout(() => {
        reconnectTimer = null;
        if (!wanted) return;
        const gen = generation;
        establish(true, gen).catch((error) => {
          if (!isCurrent(gen)) return;
          if (reconnectTimer || socket && socket.readyState === OPEN) return;
          socket = null;
          scheduleReconnect(void 0, error instanceof Error ? error.message : String(error));
        });
      }, delay);
    }
    function handleClose(ws, code, reason) {
      if (socket !== ws) return;
      socket = null;
      rejectPending("rt_disconnected");
      if (!wanted) {
        setState("closed", { code, reason });
        return;
      }
      scheduleReconnect(code, reason);
    }
    function matchHandle(entry) {
      return {
        get matchId() {
          return entry.matchId;
        },
        get label() {
          return entry.label;
        },
        get self() {
          return entry.self;
        },
        get presences() {
          return entry.presences;
        },
        send(opCode, data, opts) {
          if (entry.closed || !socket || socket.readyState !== OPEN || state !== "open") return;
          const body = {
            match_id: entry.matchId,
            op_code: String(opCode),
            data: bytesToBase64(encodePayload(data))
          };
          if (opts?.to) body.presences = opts.to.map(presenceToWire);
          if (opts?.reliable === false) body.reliable = false;
          else body.reliable = true;
          socket.send(JSON.stringify({ match_data_send: body }));
        },
        onMessage(cb) {
          const off = entry.message.on(cb);
          if (entry.early.length) {
            const early = entry.early.splice(0);
            for (const msg of early) entry.message.emit(msg);
          }
          return off;
        },
        onPresence: (cb) => entry.presence.on(cb),
        onRejoin: (cb) => entry.rejoin.on(cb),
        onClose: (cb) => entry.close.on(cb),
        async leave() {
          if (entry.closed) return;
          try {
            if (state === "open") await request({ match_leave: { match_id: entry.matchId } });
          } catch {
          } finally {
            closeMatch(entry, "left");
          }
        }
      };
    }
    function channelHandle(entry) {
      return {
        get id() {
          return entry.id;
        },
        get target() {
          return entry.target;
        },
        get presences() {
          return entry.presences;
        },
        async send(content) {
          const body = typeof content === "string" ? { text: content } : content;
          const env = await request({ channel_message_send: { channel_id: entry.id, content: JSON.stringify(body) } });
          return { messageId: env.channel_message_ack?.message_id ?? "" };
        },
        async history(opts) {
          const params = new URLSearchParams({ limit: String(Math.max(1, Math.min(100, opts?.limit ?? 30))), forward: "false" });
          if (opts?.cursor) params.set("cursor", opts.cursor);
          const body = await rest(
            `/v2/channel/${encodeURIComponent(entry.id)}?${params}`
          );
          return {
            messages: (body.messages ?? []).map(chatMessageFromWire),
            cursor: body.next_cursor ? body.next_cursor : null
          };
        },
        onMessage: (cb) => entry.message.on(cb),
        onPresence: (cb) => entry.presence.on(cb),
        async leave() {
          if (entry.closed) return;
          entry.closed = true;
          channels.delete(entry.id);
          try {
            if (state === "open") await request({ channel_leave: { channel_id: entry.id } });
          } catch {
          }
          entry.message.clear();
          entry.presence.clear();
        }
      };
    }
    async function rest(path) {
      const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
      const token = lastToken || await options.getToken();
      const response = await fetchImpl(`${httpBase()}${path}`, { headers: { Authorization: `Bearer ${token}` } });
      const text = await response.text();
      if (!response.ok) throw new HubSdkError("rest_failed", text || `HTTP ${response.status}`, response.status);
      return text ? JSON.parse(text) : {};
    }
    async function ensureOpen() {
      if (state === "open") return;
      if (state === "idle" || state === "closed") await api.connect();
      else if (connecting) await connecting;
      if (state !== "open") throw new HubSdkError("rt_disconnected", "Realtime socket is not open");
    }
    const api = {
      get state() {
        return state;
      },
      get self() {
        return self;
      },
      connect() {
        if (state === "open") return Promise.resolve();
        if (connecting) return connecting;
        if (state === "reconnecting") {
          return new Promise((resolve, reject) => {
            const off = stateEvents.on((next) => {
              if (next === "open") {
                off();
                resolve();
              } else if (next === "closed") {
                off();
                reject(new HubSdkError("rt_closed", "Realtime socket closed"));
              }
            });
          });
        }
        wanted = true;
        attempt = 0;
        generation += 1;
        const gen = generation;
        let abort;
        const aborted = new Promise((_, reject) => {
          abort = () => reject(superseded());
        });
        abortConnect = abort;
        const attemptPromise = Promise.race([
          // Starts after 'connecting' is announced and `connecting` is set, so a state
          // listener that calls connect() joins this attempt instead of replacing it.
          Promise.resolve().then(() => establish(false, gen)),
          aborted
        ]).catch((error) => {
          if (!isCurrent(gen)) throw superseded();
          socket = null;
          wanted = false;
          setState("closed", { reason: error instanceof Error ? error.message : String(error) });
          throw error instanceof HubSdkError ? error : new HubSdkError("rt_connect_failed", String(error));
        }).finally(() => {
          if (connecting === attemptPromise) connecting = null;
          if (abortConnect === abort) abortConnect = null;
        });
        connecting = attemptPromise;
        setState("connecting");
        return attemptPromise;
      },
      disconnect() {
        wanted = false;
        generation += 1;
        connecting = null;
        if (abortConnect) {
          const abort = abortConnect;
          abortConnect = null;
          abort();
        }
        if (reconnectTimer) {
          timers.clearTimeout(reconnectTimer);
          reconnectTimer = null;
        }
        const ws = socket;
        socket = null;
        rejectPending("rt_closed");
        for (const entry of [...matches.values()]) closeMatch(entry, "left");
        for (const entry of [...channels.values()]) {
          entry.closed = true;
          entry.message.clear();
          entry.presence.clear();
        }
        channels.clear();
        matchmaker.clear();
        if (ws) {
          try {
            ws.close(1e3, "client disconnect");
          } catch {
          }
        }
        setState("closed", { code: 1e3, reason: "client disconnect" });
      },
      onState: (cb) => stateEvents.on(cb),
      async joinMatch(target, metadata) {
        await ensureOpen();
        const body = "matchId" in target ? { match_id: target.matchId } : { token: target.token };
        if (metadata) body.metadata = metadata;
        const env = await joinRequest(body);
        const m = env.match ?? {};
        const matchId = m.match_id ?? ("matchId" in target ? target.matchId : "");
        const existing = matches.get(matchId);
        if (existing) closeMatch(existing, "left");
        const me = presenceFromWire(m.self);
        if (me.sessionId) self = me;
        const entry = {
          matchId,
          label: labelFromWire(m.label),
          self: me,
          presences: (m.presences ?? []).map(presenceFromWire).filter((p) => !samePresence(p, me)),
          metadata,
          message: new Emitter(),
          early: takeOrphans(matchId),
          presence: new Emitter(),
          rejoin: new Emitter(),
          close: new Emitter(),
          closed: false
        };
        matches.set(matchId, entry);
        return matchHandle(entry);
      },
      async listMatches(query) {
        const params = new URLSearchParams({ authoritative: "true", limit: String(query?.limit ?? 100) });
        if (query?.label !== void 0) params.set("label", query.label);
        if (query?.query !== void 0) params.set("query", query.query);
        if (query?.minSize !== void 0) params.set("min_size", String(query.minSize));
        if (query?.maxSize !== void 0) params.set("max_size", String(query.maxSize));
        const body = await rest(
          `/v2/match?${params}`
        );
        return (body.matches ?? []).map((m) => ({
          matchId: m.match_id ?? "",
          size: typeof m.size === "number" ? m.size : Number(m.size ?? 0),
          label: labelFromWire(m.label),
          authoritative: m.authoritative !== false
        }));
      },
      async joinMatchByQuery(query) {
        const list = await api.listMatches(query);
        const max = query.maxSize;
        const open = list.filter((m) => max === void 0 || m.size < max);
        if (!open.length) return null;
        open.sort((a, b) => query.pick === "fullest" ? b.size - a.size : a.size - b.size);
        return api.joinMatch({ matchId: open[0].matchId });
      },
      async joinViaRpc(rpcId, body, metadata) {
        const placed = await api.rpc(rpcId, body ?? {});
        const matchId = placed.matchId ?? placed.match_id;
        if (!matchId) throw new HubSdkError("match_not_found", `${rpcId} returned no matchId`);
        return api.joinMatch({ matchId }, metadata);
      },
      async addMatchmaker(req) {
        await ensureOpen();
        const env = await request({ matchmaker_add: matchmakerBody(req) });
        const ticket = env.matchmaker_ticket?.ticket ?? "";
        matchmaker.set(ticket, { original: ticket, current: ticket, request: { ...req } });
        return { ticket };
      },
      async removeMatchmaker(ticket) {
        const entry = matchmaker.get(ticket);
        matchmaker.delete(ticket);
        if (state !== "open") return;
        await request({ matchmaker_remove: { ticket: entry?.current ?? ticket } });
      },
      onMatchmakerMatched: (cb) => matchedEvents.on(cb),
      async joinChat(target, opts) {
        await ensureOpen();
        const persistence = opts?.persistence ?? true;
        const hidden = opts?.hidden ?? false;
        const env = await request({ channel_join: channelJoinBody(target, persistence, hidden) });
        const c = env.channel ?? {};
        const id = c.id ?? "";
        if (c.self?.session_id) self = presenceFromWire(c.self);
        const existing = channels.get(id);
        if (existing) return channelHandle(existing);
        const entry = {
          id,
          target,
          persistence,
          hidden,
          presences: (c.presences ?? []).map(presenceFromWire),
          message: new Emitter(),
          presence: new Emitter(),
          closed: false
        };
        channels.set(id, entry);
        return channelHandle(entry);
      },
      async rpc(id, body) {
        await ensureOpen();
        const env = await request({ rpc: { id, payload: JSON.stringify(body ?? {}) } });
        const raw = env.rpc?.payload ?? "";
        const parsed = raw ? JSON.parse(raw) : {};
        if (parsed && typeof parsed === "object" && typeof parsed.error === "string") {
          throw new HubSdkError(parsed.error, parsed.message || parsed.error);
        }
        return parsed;
      },
      onNotification: (cb) => notificationEvents.on(cb),
      onError: (cb) => errorEvents.on(cb),
      friends: createFriendsStub()
    };
    return api;
  }
  function realtimeFromSdk(sdk, options) {
    if (!sdk.getSession || !sdk.getSession()) return null;
    return createRealtime({
      ...options,
      getToken: async () => {
        const s = sdk.getSession?.();
        if (!s) throw new HubSdkError("no_session", "No hub session");
        if (s.expiresAt && s.expiresAt - Date.now() < 3e5 && sdk.refreshSession) {
          const fresh = await sdk.refreshSession();
          if (!fresh) throw new HubSdkError("no_session", "No hub session");
          return fresh.token;
        }
        return s.token;
      }
    });
  }

  // packages/hub-sdk/src/realtime/chatRules.ts
  var CHAT_TEXT_MAX = 120;
  var CHAT_RAW_MAX_BYTES = 512;
  var CHAT_COLORS = ["yellow", "red", "green", "cyan", "purple", "white", "flash1", "flash2", "flash3", "glow1", "glow2", "glow3"];
  var CHAT_EFFECTS = ["wave", "wave2", "shake", "scroll", "slide"];
  var CHAT_RATE = { burst: 5, refillMs: 1500, guestRefillMs: 3e3, duplicateWindowMs: 3e4 };
  var STRIP = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁠-⁤⁦-⁯﻿]/g;
  function normalizeChatText(text) {
    let out = text;
    try {
      out = out.normalize("NFC");
    } catch {
    }
    return out.replace(/[\t\n\r\f\v]/g, " ").replace(STRIP, "").replace(/\s+/g, " ").trim();
  }
  function byteLength(text) {
    let n = 0;
    for (let i = 0; i < text.length; i += 1) {
      const c = text.charCodeAt(i);
      if (c < 128) n += 1;
      else if (c < 2048) n += 2;
      else if (c >= 55296 && c <= 56319) {
        n += 4;
        i += 1;
      } else n += 3;
    }
    return n;
  }
  function validateChatContent(raw) {
    if (typeof raw !== "string" || byteLength(raw) > CHAT_RAW_MAX_BYTES) return { ok: false, code: "chat_too_long" };
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { ok: false, code: "chat_bad_json" };
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { ok: false, code: "chat_bad_json" };
    const body = parsed;
    if (typeof body.text !== "string") return { ok: false, code: "chat_bad_json" };
    const text = normalizeChatText(body.text);
    if (!text) return { ok: false, code: "chat_empty" };
    if (text.length > CHAT_TEXT_MAX) return { ok: false, code: "chat_too_long" };
    const content = { text };
    if (typeof body.color === "string" && CHAT_COLORS.includes(body.color)) content.color = body.color;
    if (typeof body.effect === "string" && CHAT_EFFECTS.includes(body.effect)) content.effect = body.effect;
    return { ok: true, content };
  }
  var CHAT_RULE_FIXTURES = [
    { raw: '{"text":"hello"}', expect: "ok:hello" },
    { raw: '{"text":"  hi   there \\n you "}', expect: "ok:hi there you" },
    { raw: '{"text":"a\\u200bb\\u0007c"}', expect: "ok:abc" },
    { raw: '{"text":"   "}', expect: "chat_empty" },
    { raw: '{"text":""}', expect: "chat_empty" },
    { raw: `{"text":"${"x".repeat(121)}"}`, expect: "chat_too_long" },
    { raw: `{"text":"${"x".repeat(120)}"}`, expect: `ok:${"x".repeat(120)}` },
    { raw: `{"text":"${"x".repeat(600)}"}`, expect: "chat_too_long" },
    { raw: "not json", expect: "chat_bad_json" },
    { raw: '"just a string"', expect: "chat_bad_json" },
    { raw: "[1,2]", expect: "chat_bad_json" },
    { raw: '{"text":5}', expect: "chat_bad_json" },
    { raw: '{"text":"e\\u0301"}', expect: "ok:é" },
    { raw: '{"text":"hey","color":"red","effect":"wave","extra":1}', expect: "ok:hey|red|wave" },
    { raw: '{"text":"hey","color":"blink","effect":"spin"}', expect: "ok:hey" }
  ];
  function chatRuleOutcome(result) {
    if (!result.ok) return result.code;
    const parts = [result.content.text];
    if (result.content.color) parts.push(result.content.color);
    if (result.content.effect) parts.push(result.content.effect);
    return `ok:${parts.join("|")}`;
  }
  function takeChatToken(state, now, refillMs, burst = CHAT_RATE.burst) {
    let tokens = burst;
    let last = now;
    if (state) {
      const [t, l] = state.split(":");
      const pt = Number(t);
      const pl = Number(l);
      if (Number.isFinite(pt) && Number.isFinite(pl)) {
        tokens = Math.min(burst, pt + Math.max(0, now - pl) / refillMs);
        last = now;
      }
    }
    if (tokens < 1) return { allowed: false, state: `${tokens}:${last}` };
    return { allowed: true, state: `${tokens - 1}:${last}` };
  }

  // packages/hub-sdk/src/realtime/mock.ts
  function wire(p) {
    return presenceToWire(p);
  }
  function mockLabelMatches(label, query) {
    if (!query.trim()) return true;
    let parsed = {};
    try {
      parsed = label ? JSON.parse(label) : {};
    } catch {
      return false;
    }
    for (const term of query.trim().split(/\s+/)) {
      const m = /^([+-]?)label\.([A-Za-z0-9_]+):(.*)$/.exec(term);
      if (!m) continue;
      const [, sign, key, rawValue] = m;
      if (sign !== "+" && sign !== "-") continue;
      const actual = parsed[key];
      let ok;
      const value = rawValue;
      if (value.startsWith("<") || value.startsWith(">")) {
        const n = Number(value.slice(value.startsWith("<=") || value.startsWith(">=") ? 2 : 1));
        const a = Number(actual);
        if (value.startsWith("<=")) ok = a <= n;
        else if (value.startsWith(">=")) ok = a >= n;
        else if (value.startsWith("<")) ok = a < n;
        else ok = a > n;
      } else if (value === "T" || value === "F") {
        ok = actual === (value === "T");
      } else {
        ok = String(actual) === value;
      }
      if (sign === "+" && !ok) return false;
      if (sign === "-" && ok) return false;
    }
    return true;
  }
  function createMockRealtimeServer(options) {
    const now = options?.now ?? (() => Date.now());
    let pending = 0;
    let seq = 0;
    const conns = /* @__PURE__ */ new Set();
    const handlers = /* @__PURE__ */ new Map();
    const matches = /* @__PURE__ */ new Map();
    const relayTokens = /* @__PURE__ */ new Map();
    const rpcs = /* @__PURE__ */ new Map();
    const roomPatterns = [];
    const channels = /* @__PURE__ */ new Map();
    const buckets = /* @__PURE__ */ new Map();
    const lastText = /* @__PURE__ */ new Map();
    const tickets = [];
    let matchedFn = null;
    const usernames = /* @__PURE__ */ new Map();
    function schedule(fn) {
      pending += 1;
      queueMicrotask(() => {
        try {
          fn();
        } finally {
          pending -= 1;
        }
      });
    }
    function push(conn, env) {
      const text = JSON.stringify(env);
      pending += 1;
      setTimeout(() => {
        try {
          if (conn.open && conn.ws.readyState === 1) conn.ws.onmessage?.({ data: text });
        } finally {
          pending -= 1;
        }
      }, 0);
    }
    function errorReply(conn, cid, code, message) {
      push(conn, { cid, error: { code, message } });
    }
    function dispatcherFor(match) {
      return {
        broadcast(opCode, data, to, sender) {
          const bytes = encodePayload(data);
          const targets = to ? [...match.members.values()].filter((c) => to.some((p) => p.sessionId === c.presence.sessionId)) : [...match.members.values()];
          const body = { match_id: match.id, op_code: String(opCode), data: bytesToBase64(bytes), reliable: true };
          if (sender) body.presence = wire(sender);
          for (const c of targets) push(c, { match_data: body });
        },
        kick(presences) {
          for (const p of presences) {
            const c = match.members.get(p.sessionId);
            if (!c) continue;
            push(c, { match_presence_event: { match_id: match.id, leaves: [wire(c.presence)] } });
            removeFromMatch(match, c);
          }
        },
        setLabel(label) {
          match.label = label;
        },
        end() {
          if (match.ended) return;
          match.ended = true;
          for (const c of match.members.values()) {
            push(c, { match_ended: { match_id: match.id } });
            c.matches.delete(match.id);
          }
          match.members.clear();
          matches.delete(match.id);
        }
      };
    }
    function removeFromMatch(match, conn) {
      if (!match.members.delete(conn.presence.sessionId)) return;
      conn.matches.delete(match.id);
      for (const other of match.members.values()) {
        push(other, { match_presence_event: { match_id: match.id, leaves: [wire(conn.presence)] } });
      }
      if (match.handler?.leave) match.handler.leave(match.state, [conn.presence], dispatcherFor(match));
    }
    function newMatch(name, params) {
      seq += 1;
      const id = `mock-${seq}.mock`;
      const handler = name ? handlers.get(name) ?? null : null;
      if (name && !handler) throw new HubSdkError("match_not_found", `No mock match handler "${name}"`);
      const init = handler ? handler.init(params) : { state: null, label: void 0 };
      const match = {
        id,
        name,
        handler,
        state: init.state,
        label: init.label ?? null,
        members: /* @__PURE__ */ new Map(),
        queue: [],
        tick: 0,
        ended: false
      };
      matches.set(id, match);
      return match;
    }
    function joinMatch(conn, cid, body) {
      let matchId = typeof body.match_id === "string" ? body.match_id : "";
      if (!matchId && typeof body.token === "string") matchId = relayTokens.get(body.token) ?? "";
      const match = matches.get(matchId);
      if (!match || match.ended) {
        errorReply(conn, cid, 4, "Match not found");
        return;
      }
      const metadata = body.metadata && typeof body.metadata === "object" ? body.metadata : {};
      if (match.handler?.joinAttempt) {
        const verdict = match.handler.joinAttempt(match.state, conn.presence, metadata);
        if (!verdict.accept) {
          errorReply(conn, cid, 5, verdict.reason ?? "rejected");
          return;
        }
      }
      const others = [...match.members.values()].map((c) => wire(c.presence));
      match.members.set(conn.presence.sessionId, conn);
      conn.matches.add(match.id);
      push(conn, {
        cid,
        match: {
          match_id: match.id,
          authoritative: !!match.handler,
          label: match.label ?? void 0,
          size: match.members.size,
          presences: others,
          self: wire(conn.presence)
        }
      });
      for (const other of match.members.values()) {
        if (other === conn) continue;
        push(other, { match_presence_event: { match_id: match.id, joins: [wire(conn.presence)] } });
      }
      if (match.handler?.join) match.handler.join(match.state, [conn.presence], dispatcherFor(match));
    }
    function dataSend(conn, body) {
      const match = matches.get(String(body.match_id ?? ""));
      if (!match || !match.members.has(conn.presence.sessionId)) return;
      const opCode = Number(body.op_code ?? 0);
      const bytes = typeof body.data === "string" ? base64ToBytes(body.data) : new Uint8Array(0);
      if (match.handler) {
        match.queue.push({ sender: conn.presence, opCode, data: bytes });
        return;
      }
      const to = Array.isArray(body.presences) ? body.presences : null;
      for (const other of match.members.values()) {
        if (other === conn) continue;
        if (to && !to.some((p) => p.session_id === other.presence.sessionId)) continue;
        push(other, {
          match_data: { match_id: match.id, presence: wire(conn.presence), op_code: String(opCode), data: body.data ?? "", reliable: body.reliable !== false }
        });
      }
    }
    function tryMatchmake() {
      const groups = /* @__PURE__ */ new Map();
      for (const t of tickets) {
        const game = t.request.stringProperties?.game ?? "";
        const list = groups.get(game) ?? [];
        list.push(t);
        groups.set(game, list);
      }
      for (const list of groups.values()) {
        const need = list[0].request.minCount;
        const picked = [];
        for (const t of list) {
          if (picked.some((p) => p.conn.presence.userId === t.conn.presence.userId)) continue;
          picked.push(t);
          if (picked.length >= need) break;
        }
        if (picked.length < need) continue;
        for (const p of picked) tickets.splice(tickets.indexOf(p), 1);
        const entries = picked.map((p) => ({ ticket: p.ticket, presence: p.conn.presence, request: p.request }));
        const chosen = matchedFn ? matchedFn(entries) : null;
        let matchId = null;
        let token = null;
        if (typeof chosen === "string" && chosen) {
          matchId = chosen;
        } else {
          const relay = newMatch(null, {});
          seq += 1;
          token = `mock-token-${seq}`;
          relayTokens.set(token, relay.id);
        }
        const users = picked.map((p) => ({
          presence: wire(p.conn.presence),
          string_properties: p.request.stringProperties ?? {},
          numeric_properties: p.request.numericProperties ?? {}
        }));
        picked.forEach((p, i) => {
          const body = { ticket: p.ticket, users, self: users[i] };
          if (matchId) body.match_id = matchId;
          if (token) body.token = token;
          push(p.conn, { matchmaker_matched: body });
        });
      }
    }
    function channelIdFor(conn, target, type) {
      if (type === 2) {
        const [a, b] = [conn.presence.userId, target].sort();
        return `4.${a}.${b}.`;
      }
      if (type === 3) return `3.${target}..`;
      return `2...${target}`;
    }
    function joinChannel(conn, cid, body) {
      const target = String(body.target ?? "");
      const type = Number(body.type ?? 1);
      if (type === 1 && roomPatterns.length && !roomPatterns.some((p) => p.test(target))) {
        errorReply(conn, cid, 0, "Error: room_not_allowed at mockChannelJoin (mock)");
        return;
      }
      const id = channelIdFor(conn, target, type);
      const channel = channels.get(id) ?? { id, members: /* @__PURE__ */ new Map(), history: [] };
      channels.set(id, channel);
      const others = [...channel.members.values()].filter((c) => c !== conn).map((c) => wire(c.presence));
      channel.members.set(conn.presence.sessionId, conn);
      conn.channels.add(id);
      push(conn, { cid, channel: { id, presences: others, self: wire(conn.presence) } });
      for (const other of channel.members.values()) {
        if (other !== conn) push(other, { channel_presence_event: { channel_id: id, joins: [wire(conn.presence)] } });
      }
    }
    function leaveChannel(conn, id) {
      const channel = channels.get(id);
      conn.channels.delete(id);
      if (!channel || !channel.members.delete(conn.presence.sessionId)) return;
      for (const other of channel.members.values()) {
        push(other, { channel_presence_event: { channel_id: id, leaves: [wire(conn.presence)] } });
      }
    }
    function sendChat(conn, cid, body) {
      const channel = channels.get(String(body.channel_id ?? ""));
      if (!channel || !channel.members.has(conn.presence.sessionId)) {
        errorReply(conn, cid, 3, "Error: channel_not_joined at mock");
        return;
      }
      const checked = validateChatContent(String(body.content ?? ""));
      if (!checked.ok) {
        errorReply(conn, cid, 0, `Error: ${checked.code} at mockChannelMessageSend (mock)`);
        return;
      }
      const at = now();
      const userId = conn.presence.userId;
      const bucket = takeChatToken(buckets.get(userId) ?? null, at, CHAT_RATE.refillMs);
      if (!bucket.allowed) {
        buckets.set(userId, bucket.state);
        errorReply(conn, cid, 0, "Error: chat_rate_limited at mockChannelMessageSend (mock)");
        return;
      }
      const last = lastText.get(userId);
      if (last && last.text === checked.content.text && at - last.at < CHAT_RATE.duplicateWindowMs) {
        errorReply(conn, cid, 0, "Error: chat_duplicate at mockChannelMessageSend (mock)");
        return;
      }
      buckets.set(userId, bucket.state);
      lastText.set(userId, { text: checked.content.text, at });
      seq += 1;
      const message = {
        channel_id: channel.id,
        message_id: `msg-${seq}`,
        sender_id: userId,
        username: conn.presence.username,
        content: JSON.stringify(checked.content),
        create_time: new Date(at).toISOString(),
        persistent: true
      };
      channel.history.push(message);
      push(conn, { cid, channel_message_ack: { channel_id: channel.id, message_id: message.message_id } });
      for (const member of channel.members.values()) push(member, { channel_message: message });
    }
    function callRpc(conn, cid, body) {
      const id = String(body.id ?? "");
      const fn = rpcs.get(id);
      if (!fn) {
        errorReply(conn, cid, 6, `RPC function not found: ${id}`);
        return;
      }
      let input = {};
      try {
        input = typeof body.payload === "string" && body.payload ? JSON.parse(body.payload) : {};
      } catch {
        errorReply(conn, cid, 3, "Error: bad_json at mockRpc (mock)");
        return;
      }
      try {
        const result = fn({ userId: conn.presence.userId }, input);
        push(conn, { cid, rpc: { id, payload: typeof result === "string" ? result : JSON.stringify(result ?? {}) } });
      } catch (error) {
        const message = error instanceof HubSdkError ? error.code : error instanceof Error ? error.message : String(error);
        errorReply(conn, cid, 7, `Error: ${message} at mockRpc (mock)`);
      }
    }
    function onClientMessage(conn, raw) {
      let env;
      try {
        env = JSON.parse(raw);
      } catch {
        return;
      }
      const cid = env.cid;
      const get = (key) => env[key] && typeof env[key] === "object" ? env[key] : null;
      let body;
      if (body = get("match_join")) return joinMatch(conn, cid, body);
      if (body = get("match_leave")) {
        const match = matches.get(String(body.match_id ?? ""));
        if (match) removeFromMatch(match, conn);
        push(conn, { cid });
        return;
      }
      if (body = get("match_data_send")) return dataSend(conn, body);
      if (body = get("matchmaker_add")) {
        seq += 1;
        const ticket = `mock-ticket-${seq}`;
        const request = {
          query: String(body.query ?? ""),
          minCount: Number(body.min_count ?? 2),
          maxCount: Number(body.max_count ?? 2),
          stringProperties: body.string_properties ?? {},
          numericProperties: body.numeric_properties ?? {}
        };
        if (body.count_multiple) request.countMultiple = Number(body.count_multiple);
        tickets.push({ ticket, conn, request });
        push(conn, { cid, matchmaker_ticket: { ticket } });
        tryMatchmake();
        return;
      }
      if (body = get("matchmaker_remove")) {
        const i = tickets.findIndex((t) => t.ticket === body.ticket && t.conn === conn);
        if (i >= 0) tickets.splice(i, 1);
        push(conn, { cid });
        return;
      }
      if (body = get("channel_join")) return joinChannel(conn, cid, body);
      if (body = get("channel_leave")) {
        leaveChannel(conn, String(body.channel_id ?? ""));
        push(conn, { cid });
        return;
      }
      if (body = get("channel_message_send")) return sendChat(conn, cid, body);
      if (get("channel_message_update") || get("channel_message_remove")) {
        errorReply(conn, cid, 0, "Error: chat_readonly at mock");
        return;
      }
      if (body = get("rpc")) return callRpc(conn, cid, body);
      if (get("ping")) {
        push(conn, { cid, pong: {} });
        return;
      }
      if (cid) errorReply(conn, cid, 1, "Unrecognized payload");
    }
    function cleanup(conn) {
      conn.open = false;
      conns.delete(conn);
      for (const id of [...conn.matches]) {
        const match = matches.get(id);
        if (match) removeFromMatch(match, conn);
      }
      for (const id of [...conn.channels]) leaveChannel(conn, id);
      for (let i = tickets.length - 1; i >= 0; i -= 1) if (tickets[i].conn === conn) tickets.splice(i, 1);
    }
    class FakeSocket {
      readyState = 0;
      onopen = null;
      onclose = null;
      onmessage = null;
      onerror = null;
      conn = null;
      constructor(url) {
        const token = new URL(url).searchParams.get("token") ?? "";
        const userId = token.startsWith("mock:") ? token.slice(5) : "";
        schedule(() => {
          if (!userId || this.readyState !== 0) {
            this.readyState = 3;
            this.onerror?.({});
            this.onclose?.({ code: 4001, reason: "unauthorized" });
            return;
          }
          seq += 1;
          this.conn = {
            ws: this,
            presence: { userId, sessionId: `sess-${seq}`, username: usernames.get(userId) ?? userId },
            matches: /* @__PURE__ */ new Set(),
            channels: /* @__PURE__ */ new Set(),
            open: true
          };
          conns.add(this.conn);
          this.readyState = 1;
          this.onopen?.({});
        });
      }
      send(data) {
        if (this.readyState !== 1 || !this.conn) throw new Error("InvalidStateError");
        const conn = this.conn;
        schedule(() => {
          if (conn.open) onClientMessage(conn, data);
        });
      }
      close(code = 1e3, reason = "") {
        if (this.readyState === 3) return;
        this.readyState = 3;
        if (this.conn) cleanup(this.conn);
        schedule(() => this.onclose?.({ code, reason }));
      }
      /** Server-side drop. */
      drop() {
        if (this.readyState === 3) return;
        this.readyState = 3;
        if (this.conn) cleanup(this.conn);
        schedule(() => this.onclose?.({ code: 1006, reason: "mock drop" }));
      }
    }
    async function mockFetch(input) {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      if (url.pathname === "/v2/match") {
        const min = url.searchParams.get("min_size");
        const max = url.searchParams.get("max_size");
        const query = url.searchParams.get("query") ?? "";
        const label = url.searchParams.get("label");
        const limit = Number(url.searchParams.get("limit") ?? 100);
        const list = [...matches.values()].filter((m) => m.handler && !m.ended).filter((m) => (min === null || m.members.size >= Number(min)) && (max === null || m.members.size <= Number(max))).filter((m) => (label === null || m.label === label) && mockLabelMatches(m.label, query)).slice(0, limit).map((m) => ({ match_id: m.id, authoritative: true, label: m.label ?? void 0, size: m.members.size }));
        return new Response(JSON.stringify({ matches: list }), { status: 200 });
      }
      if (url.pathname.startsWith("/v2/channel/")) {
        const id = decodeURIComponent(url.pathname.slice("/v2/channel/".length));
        const channel = channels.get(id);
        const limit = Number(url.searchParams.get("limit") ?? 30);
        const offset = Number(url.searchParams.get("cursor") ?? 0) || 0;
        const newestFirst = [...channel?.history ?? []].reverse();
        const page = newestFirst.slice(offset, offset + limit);
        const next = offset + limit < newestFirst.length ? String(offset + limit) : "";
        return new Response(JSON.stringify({ messages: page, next_cursor: next }), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    }
    return {
      connect(user) {
        usernames.set(user.userId, user.username ?? user.userId);
        const client = createRealtime({
          serverUrl: "http://mock.realtime",
          getToken: () => `mock:${user.userId}`,
          WebSocketImpl: FakeSocket,
          fetchImpl: mockFetch,
          reconnect: { baseDelayMs: 0, maxDelayMs: 0 },
          requestTimeoutMs: 5e3
        });
        return client;
      },
      registerMatch(name, handler) {
        handlers.set(name, handler);
      },
      createMatch(name, params) {
        return newMatch(name ?? null, params ?? {}).id;
      },
      onMatchmakerMatched(fn) {
        matchedFn = fn;
      },
      registerRpc(id, fn) {
        rpcs.set(id, fn);
      },
      allowRooms(pattern) {
        roomPatterns.push(pattern);
      },
      tick(count = 1) {
        for (let i = 0; i < count; i += 1) {
          for (const match of [...matches.values()]) {
            if (!match.handler || match.ended) continue;
            match.tick += 1;
            const batch = match.queue.splice(0);
            match.handler.loop?.(match.state, batch, dispatcherFor(match), match.tick);
          }
        }
      },
      async flush() {
        let idle = 0;
        for (let i = 0; i < 200 && idle < 3; i += 1) {
          await new Promise((resolve) => setTimeout(resolve, 0));
          idle = pending === 0 ? idle + 1 : 0;
        }
      },
      drop(userId) {
        for (const conn of [...conns]) {
          if (conn.presence.userId === userId) conn.ws.drop();
        }
      },
      matchesByLabel(query) {
        return [...matches.values()].filter((m) => !m.ended && (!query || query(m.label))).map((m) => ({ matchId: m.id, size: m.members.size, label: m.label, authoritative: !!m.handler }));
      }
    };
  }

  // packages/hub-sdk/src/pageShot.ts
  var MEDIA_WAIT_MS = 1e3;
  var UNDER = "data-hub-feedback-under";
  var library = null;
  function loadPageShot() {
    library ??= Promise.resolve().then(() => (init_modern_screenshot(), modern_screenshot_exports)).catch((error) => {
      library = null;
      throw error;
    });
    return library;
  }
  function holdFrames() {
    const w = window;
    const request = w.requestAnimationFrame;
    const cancel = w.cancelAnimationFrame;
    const queued = /* @__PURE__ */ new Map();
    let next = 0;
    w.requestAnimationFrame = (callback) => {
      next -= 1;
      queued.set(next, callback);
      return next;
    };
    w.cancelAnimationFrame = (handle) => {
      if (!queued.delete(handle)) cancel.call(w, handle);
    };
    let released = false;
    return () => {
      if (released) return;
      released = true;
      w.requestAnimationFrame = request;
      w.cancelAnimationFrame = cancel;
      for (const callback of queued.values()) request.call(w, callback);
    };
  }
  function capturePage(root, skip, maxWidth, holdMs) {
    const frozen = [];
    for (const canvas of Array.from(root.querySelectorAll("canvas"))) {
      if (skip.includes(canvas) || !canvas.width || !canvas.height) continue;
      try {
        const copy = document.createElement("canvas");
        copy.width = canvas.width;
        copy.height = canvas.height;
        const g = copy.getContext("2d");
        if (!g) continue;
        g.drawImage(canvas, 0, 0);
        canvas.toDataURL = (...args) => copy.toDataURL(...args);
        frozen.push(canvas);
      } catch {
      }
    }
    const under = [];
    for (const node of skip) {
      if (!(node instanceof HTMLCanvasElement)) continue;
      for (let parent = node.parentElement; parent && root.contains(parent); parent = parent.parentElement) {
        if (!parent.hasAttribute(UNDER)) {
          parent.setAttribute(UNDER, "");
          under.push(parent);
        }
      }
    }
    const release = holdFrames();
    const deadline = window.setTimeout(release, holdMs);
    const done = () => {
      window.clearTimeout(deadline);
      release();
      for (const parent of under) parent.removeAttribute(UNDER);
      for (const canvas of frozen) delete canvas.toDataURL;
    };
    const width = Math.max(1, window.innerWidth);
    const height = Math.max(1, window.innerHeight);
    return loadPageShot().then(
      ({ domToCanvas: domToCanvas2 }) => domToCanvas2(root, {
        width,
        height,
        scale: Math.min(1, maxWidth / width),
        backgroundColor: null,
        // The root's own background is behind the canvases on the page, not over them.
        style: { background: "transparent" },
        timeout: Math.min(MEDIA_WAIT_MS, holdMs),
        onCloneEachNode: (cloned) => {
          if (cloned instanceof HTMLElement && cloned.hasAttribute(UNDER)) cloned.style.setProperty("background", "none", "important");
        },
        filter: (node) => !(node instanceof Element) || !skip.includes(node) && visible(node)
      })
    ).catch(() => null).finally(done);
  }
  function visible(node) {
    if (typeof node.checkVisibility === "function") return node.checkVisibility();
    return getComputedStyle(node).display !== "none";
  }
  function pageBackground() {
    for (const node of [document.body, document.documentElement]) {
      if (!node) continue;
      const color = getComputedStyle(node).backgroundColor;
      if (color && color !== "transparent" && !/rgba\(.*,\s*0\)$/.test(color)) return color;
    }
    return "#000";
  }

  // packages/hub-sdk/src/feedback.ts
  var FEEDBACK_CATEGORIES = [
    { id: "broke", label: "Something broke" },
    { id: "unclear", label: "Unclear what to do" },
    { id: "too_hard", label: "Too hard" },
    { id: "too_easy", label: "Too easy" },
    { id: "controls", label: "Controls feel off" },
    { id: "performance", label: "Performance issue" },
    { id: "other", label: "Other" }
  ];
  var FEEDBACK_NOTE_MAX = 2e3;
  var FEEDBACK_IMAGE_MAX = 19e4;
  var FEEDBACK_META_MAX = 15e3;
  var QUEUE_KEY = "hub:feedback:queue";
  var QUEUE_MAX = 4;
  var BREADCRUMB_MAX = 24;
  var ERROR_MAX = 10;
  var DEFAULT_THEME = {
    font: 'system-ui, -apple-system, "Segoe UI", sans-serif',
    titleFont: "inherit",
    background: "rgba(5, 8, 16, 0.62)",
    panel: "#141a26",
    text: "#eef2f8",
    muted: "#9aa6b8",
    accent: "#4fd1e8",
    accentText: "#06131a",
    border: "rgba(255, 255, 255, 0.16)",
    radius: "10px",
    css: ""
  };
  function feedbackTransportFromSdk(sdk) {
    return {
      async access() {
        if (!sdk.feedbackAccess) return { ok: false, reason: "standalone" };
        return sdk.feedbackAccess();
      },
      async submit(input) {
        if (!sdk.submitFeedback) throw new HubSdkError("standalone", "Feedback needs a hub session");
        return sdk.submitFeedback(input);
      }
    };
  }
  function clip(value, max) {
    const text = typeof value === "string" ? value : value instanceof Error ? `${value.name}: ${value.message}` : String(value);
    return text.length > max ? `${text.slice(0, max)}…` : text;
  }
  function describeError(value) {
    if (value && typeof value === "object") {
      const e = value;
      const out = { message: clip(e.message ?? value, 300) };
      if (typeof e.stack === "string") out.stack = clip(e.stack, 600);
      if (typeof e.at === "number") out.at = e.at;
      else if (typeof e.time === "number") out.at = e.time;
      return out;
    }
    return { message: clip(value, 300) };
  }
  function fitFeedbackMeta(meta, max = FEEDBACK_META_MAX) {
    const out = { ...meta };
    const size = () => JSON.stringify(out).length;
    const trimList = (key, keep) => {
      const list = out[key];
      if (Array.isArray(list) && list.length > keep) out[key] = list.slice(list.length - keep);
    };
    if (size() > max) trimList("breadcrumbs", 8);
    if (size() > max) trimList("errors", 3);
    if (size() > max) {
      const errors = out.errors;
      if (Array.isArray(errors)) out.errors = errors.map((e) => ({ message: clip(e.message ?? "", 160) }));
    }
    if (size() > max) delete out.extra;
    if (size() > max) delete out.breadcrumbs;
    if (size() > max) delete out.player;
    if (size() > max) delete out.errors;
    return out;
  }
  function retryable(error) {
    if (error instanceof HubSdkError) return error.code === "rpc_failed" && (error.status === void 0 || error.status >= 500);
    return error instanceof TypeError;
  }
  function css(theme) {
    return `
:host { all: initial; }
.root { position: fixed; inset: 0; z-index: 2147483000; font: 14px/1.4 ${theme.font}; color: ${theme.text}; pointer-events: none; }
.root * { box-sizing: border-box; }
.backdrop { position: absolute; inset: 0; background: ${theme.background}; display: flex; align-items: center; justify-content: center; padding: 12px; pointer-events: auto; }
.panel { width: min(460px, 100%); max-height: 100%; overflow: auto; background: ${theme.panel}; border: 1px solid ${theme.border}; border-radius: ${theme.radius}; padding: 14px 16px 12px; box-shadow: 0 18px 60px rgba(0, 0, 0, 0.55); outline: none; }
.head { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; margin-bottom: 10px; }
.title { font-family: ${theme.titleFont}; font-size: 16px; font-weight: 700; letter-spacing: 0.02em; }
.sub { color: ${theme.muted}; font-size: 11px; }
.chips { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 10px; }
button { font: inherit; color: inherit; cursor: pointer; }
.chip { background: transparent; border: 1px solid ${theme.border}; border-radius: ${theme.radius}; padding: 6px 9px; display: inline-flex; gap: 6px; align-items: center; }
.chip kbd { font: inherit; font-size: 10px; color: ${theme.muted}; }
.chip[aria-pressed="true"] { background: ${theme.accent}; border-color: ${theme.accent}; color: ${theme.accentText}; }
.chip[aria-pressed="true"] kbd { color: ${theme.accentText}; }
.chip:focus-visible, .btn:focus-visible, textarea:focus-visible { outline: 2px solid ${theme.accent}; outline-offset: 1px; }
textarea { width: 100%; min-height: 58px; resize: vertical; font: inherit; color: ${theme.text}; background: rgba(0, 0, 0, 0.28); border: 1px solid ${theme.border}; border-radius: ${theme.radius}; padding: 7px 9px; }
textarea::placeholder { color: ${theme.muted}; }
.shot { margin-top: 10px; position: relative; border: 1px solid ${theme.border}; border-radius: ${theme.radius}; overflow: hidden; background: #000; }
.shot canvas { display: block; max-width: 100%; max-height: 32vh; width: auto; height: auto; margin: 0 auto; touch-action: none; }
.shot.draw canvas { cursor: crosshair; }
.shotbar { display: flex; gap: 6px; align-items: center; justify-content: space-between; margin-top: 6px; color: ${theme.muted}; font-size: 11px; }
.shotbar .tools { display: flex; gap: 6px; }
.mini { background: transparent; border: 1px solid ${theme.border}; border-radius: ${theme.radius}; padding: 3px 8px; font-size: 11px; }
.mini[aria-pressed="true"] { border-color: ${theme.accent}; color: ${theme.accent}; }
.foot { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-top: 12px; }
.hint { color: ${theme.muted}; font-size: 11px; }
.actions { display: flex; gap: 8px; }
.btn { border: 1px solid ${theme.border}; background: transparent; border-radius: ${theme.radius}; padding: 7px 14px; }
.btn.primary { background: ${theme.accent}; border-color: ${theme.accent}; color: ${theme.accentText}; font-weight: 700; }
.btn[disabled] { opacity: 0.5; cursor: default; }
.msg { color: ${theme.muted}; margin: 4px 0 2px; min-height: 18px; font-size: 12px; }
.msg.bad { color: #ff9a8a; }
.toast { position: absolute; left: 50%; bottom: 22px; transform: translateX(-50%); background: ${theme.panel}; border: 1px solid ${theme.border}; border-radius: ${theme.radius}; padding: 8px 12px; display: flex; gap: 10px; align-items: center; font-size: 12px; pointer-events: auto; box-shadow: 0 8px 30px rgba(0, 0, 0, 0.5); max-width: calc(100% - 24px); }
.toast button { border: 1px solid ${theme.accent}; color: ${theme.accent}; background: transparent; border-radius: ${theme.radius}; padding: 3px 9px; font-size: 12px; }
@media (prefers-reduced-motion: no-preference) { .panel { animation: fb-in 90ms ease-out; } @keyframes fb-in { from { opacity: 0; transform: translateY(6px); } } }
${theme.css}`;
  }
  function captureCanvases(list, maxWidth, page = false) {
    const vw = Math.max(1, window.innerWidth);
    const vh = Math.max(1, window.innerHeight);
    const visible2 = list.map((canvas) => ({ canvas, rect: canvas.getBoundingClientRect() })).filter(({ canvas, rect }) => canvas.width > 0 && canvas.height > 0 && rect.width > 1 && rect.height > 1 && rect.right > 0 && rect.bottom > 0 && rect.left < vw && rect.top < vh);
    if (!visible2.length && !page) return null;
    let left = 0;
    let top = 0;
    let width = vw;
    let height = vh;
    if (visible2.length === 1 && !page) {
      const r = visible2[0].rect;
      left = r.left;
      top = r.top;
      width = r.width;
      height = r.height;
    }
    const scale = Math.min(1, maxWidth / width);
    const out = document.createElement("canvas");
    out.width = Math.max(1, Math.round(width * scale));
    out.height = Math.max(1, Math.round(height * scale));
    const g = out.getContext("2d");
    if (!g) return null;
    g.fillStyle = page ? pageBackground() : "#000";
    g.fillRect(0, 0, out.width, out.height);
    let drawn = 0;
    for (const { canvas, rect } of visible2) {
      try {
        g.imageSmoothingEnabled = getComputedStyle(canvas).imageRendering !== "pixelated";
        g.drawImage(canvas, (rect.left - left) * scale, (rect.top - top) * scale, rect.width * scale, rect.height * scale);
        drawn += 1;
      } catch {
      }
    }
    return drawn || page ? { shot: out, drawn } : null;
  }
  function drawOverlay(shot, overlay) {
    if (!overlay || overlay.width < 1 || overlay.height < 1) return false;
    try {
      shot.getContext("2d")?.drawImage(overlay, 0, 0, shot.width, shot.height);
      return true;
    } catch {
      return false;
    }
  }
  var OVERLAY_WAIT_MS = 3e3;
  function encode(canvas, max) {
    let source = canvas;
    for (let attempt = 0; attempt < 4; attempt++) {
      for (const quality of [0.72, 0.55, 0.4]) {
        let url = "";
        try {
          url = source.toDataURL("image/jpeg", quality);
        } catch {
          return "";
        }
        if (url.length <= max && url.startsWith("data:image/jpeg")) return url;
      }
      const smaller = document.createElement("canvas");
      smaller.width = Math.max(1, Math.round(source.width * 0.7));
      smaller.height = Math.max(1, Math.round(source.height * 0.7));
      const g = smaller.getContext("2d");
      if (!g) return "";
      g.drawImage(source, 0, 0, smaller.width, smaller.height);
      source = smaller;
    }
    return "";
  }
  var NOOP = { open() {
  }, close() {
  }, isOpen: () => false, breadcrumb() {
  }, dispose() {
  } };
  function installFeedback(options) {
    if (typeof window === "undefined" || typeof document === "undefined") return NOOP;
    const theme = { ...DEFAULT_THEME, ...options.theme ?? {} };
    const key = options.key ?? "KeyN";
    const gap = options.doubleTapMs ?? 400;
    let storage = null;
    try {
      storage = options.storage === void 0 ? window.localStorage : options.storage;
    } catch {
      storage = null;
    }
    const breadcrumbs = [];
    const errors = [];
    let access = null;
    let accessPending = null;
    let lastTap = -Infinity;
    let disposed = false;
    let host = null;
    let root = null;
    let panelOpen = false;
    let capturing = false;
    let closePanel = null;
    let panelKey = null;
    let toastTimer = 0;
    let lastCrashPrompt = -Infinity;
    const frames = new Float32Array(120);
    let frameAt = 0;
    let frameCount = 0;
    let lastFrame = 0;
    let raf = 0;
    const tick = (now) => {
      if (lastFrame) {
        frames[frameAt] = now - lastFrame;
        frameAt = (frameAt + 1) % frames.length;
        if (frameCount < frames.length) frameCount += 1;
      }
      lastFrame = now;
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    function frameStats() {
      if (frameCount < 10) return null;
      let sum = 0;
      let worst = 0;
      for (let i = 0; i < frameCount; i++) {
        const dt = frames[i];
        sum += dt;
        if (dt > worst) worst = dt;
      }
      const mean = sum / frameCount;
      return { fps: Math.round(1e3 / mean), frameMs: Math.round(mean * 10) / 10, worstFrameMs: Math.round(worst) };
    }
    function checkAccess(force = false) {
      if (access && !force) return Promise.resolve(access);
      if (accessPending) return accessPending;
      accessPending = options.transport.access().catch((error) => ({ ok: false, reason: error instanceof HubSdkError ? error.code : "offline" })).then((result) => {
        accessPending = null;
        access = result.ok || result.reason !== "offline" ? result : null;
        if (result.ok) void flushQueue();
        return result;
      });
      return accessPending;
    }
    function readQueue() {
      if (!storage) return [];
      try {
        const raw = storage.getItem(QUEUE_KEY);
        const list = raw ? JSON.parse(raw) : [];
        return Array.isArray(list) ? list : [];
      } catch {
        return [];
      }
    }
    function writeQueue(list) {
      if (!storage) return;
      try {
        if (list.length) storage.setItem(QUEUE_KEY, JSON.stringify(list.slice(-QUEUE_MAX)));
        else storage.removeItem(QUEUE_KEY);
      } catch {
        try {
          storage.setItem(QUEUE_KEY, JSON.stringify(list.slice(-QUEUE_MAX).map((item) => ({ ...item, image: "" }))));
        } catch {
        }
      }
    }
    let flushing = false;
    async function flushQueue() {
      if (flushing) return;
      flushing = true;
      try {
        let list = readQueue();
        while (list.length) {
          const next = list[0];
          try {
            await options.transport.submit(next);
          } catch (error) {
            if (retryable(error)) return;
          }
          list = readQueue().slice(1);
          writeQueue(list);
        }
      } finally {
        flushing = false;
      }
    }
    function mount() {
      const parent = document.fullscreenElement ?? document.body;
      if (host && root && host.parentNode === parent) return root;
      if (host) host.remove();
      host = document.createElement("div");
      host.setAttribute("data-hub-feedback", "");
      const shadow = host.attachShadow({ mode: "open" });
      const style = document.createElement("style");
      style.textContent = css(theme);
      root = document.createElement("div");
      root.className = "root";
      shadow.append(style, root);
      parent.append(host);
      return root;
    }
    function el(tag, className, text) {
      const node = document.createElement(tag);
      if (className) node.className = className;
      if (text !== void 0) node.textContent = text;
      return node;
    }
    function toast(message, action, ms = 3200) {
      const parent = mount();
      parent.querySelector(".toast")?.remove();
      window.clearTimeout(toastTimer);
      const node = el("div", "toast");
      node.setAttribute("role", "status");
      node.append(el("span", void 0, message));
      if (action) {
        const button = el("button", void 0, action.label);
        button.type = "button";
        button.addEventListener("click", () => {
          node.remove();
          action.run();
        });
        node.append(button);
      }
      parent.append(node);
      toastTimer = window.setTimeout(() => node.remove(), ms);
    }
    function refusal(reason) {
      if (reason === "standalone") return "Feedback works when you play from the hub while signed in.";
      if (reason === "sign_in_required") return "Sign in to a hub account to send feedback.";
      if (reason === "offline") return "Cannot reach the hub right now. Try again in a moment.";
      return "Feedback is not available right now.";
    }
    function snapshot(source) {
      const now = /* @__PURE__ */ new Date();
      let context = {};
      try {
        context = options.context?.() ?? {};
      } catch (error) {
        context = { extra: { contextError: clip(error, 200) } };
      }
      const own = (() => {
        try {
          return (options.errors?.() ?? []).slice(-ERROR_MAX).map(describeError);
        } catch {
          return [];
        }
      })();
      const seen = /* @__PURE__ */ new Set();
      const allErrors = [...own, ...errors].filter((e) => {
        const k = String(e.message);
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
      const nav = navigator;
      const memory = performance.memory;
      let pads = 0;
      try {
        pads = (nav.getGamepads?.() ?? []).filter(Boolean).length;
      } catch {
        pads = 0;
      }
      const meta = {
        title: options.title,
        version: options.version ?? "",
        level: context.level ?? "",
        mode: context.mode ?? "",
        position: context.position ?? null,
        gameTime: typeof context.gameTime === "number" && Number.isFinite(context.gameTime) ? Math.round(context.gameTime * 100) / 100 : null,
        player: context.player ?? null,
        extra: context.extra ?? null,
        source,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone ?? "",
        utcOffsetMinutes: -now.getTimezoneOffset(),
        sessionSeconds: Math.round(performance.now() / 1e3),
        perf: frameStats(),
        heapMb: memory ? Math.round(memory.usedJSHeapSize / 1048576) : null,
        page: location.pathname,
        viewport: { w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio || 1 },
        userAgent: clip(nav.userAgent, 220),
        language: nav.language,
        input: { gamepads: pads, touch: nav.maxTouchPoints > 0 },
        fullscreen: !!document.fullscreenElement,
        errors: allErrors.slice(-ERROR_MAX),
        breadcrumbs: breadcrumbs.slice()
      };
      return { meta: fitFeedbackMeta(meta), clientTime: now.toISOString() };
    }
    function send(submission) {
      options.transport.submit(submission).then(
        (result) => toast(`Feedback sent · ${result.id}`),
        (error) => {
          if (retryable(error)) {
            writeQueue([...readQueue(), submission]);
            toast("Feedback saved. It will send when the hub is reachable.");
          } else {
            const code = error instanceof HubSdkError ? error.code : "";
            if (code === "sign_in_required" || code === "standalone") access = { ok: false, reason: code };
            toast(code === "rate_limited" ? "Too many notes in a short time. Try again in a few minutes." : refusal(code));
          }
        }
      );
    }
    function openPanel(source, shot, captured) {
      if (panelOpen || disposed) return;
      panelOpen = true;
      const previousFocus = document.activeElement;
      let token;
      try {
        if (document.pointerLockElement) document.exitPointerLock();
        token = options.pause ? options.pause() : false;
      } catch {
        token = false;
      }
      const running = token === false;
      captured.meta.paused = !running;
      const parent = mount();
      parent.querySelector(".toast")?.remove();
      const backdrop = el("div", "backdrop");
      const panel = el("div", "panel");
      panel.tabIndex = -1;
      panel.setAttribute("role", "dialog");
      panel.setAttribute("aria-modal", "true");
      panel.setAttribute("aria-label", `Feedback for ${options.title}`);
      const head = el("div", "head");
      head.append(el("div", "title", source === "crash" ? "Report a problem" : "Feedback"), el("div", "sub", running ? `${options.title} · game keeps running` : `${options.title} · paused`));
      panel.append(head);
      const selected = /* @__PURE__ */ new Set();
      if (source === "crash") selected.add("broke");
      const chips = el("div", "chips");
      const chipButtons = [];
      FEEDBACK_CATEGORIES.forEach((category, index) => {
        const chip = el("button", "chip");
        chip.type = "button";
        chip.setAttribute("aria-pressed", String(selected.has(category.id)));
        chip.append(el("kbd", void 0, String(index + 1)), el("span", void 0, category.label));
        chip.addEventListener("click", () => toggle(index));
        chipButtons.push(chip);
        chips.append(chip);
      });
      panel.append(chips);
      function toggle(index) {
        const category = FEEDBACK_CATEGORIES[index];
        const chip = chipButtons[index];
        if (!category || !chip) return;
        if (selected.has(category.id)) selected.delete(category.id);
        else selected.add(category.id);
        chip.setAttribute("aria-pressed", String(selected.has(category.id)));
        message.textContent = "";
      }
      const note = el("textarea");
      note.maxLength = FEEDBACK_NOTE_MAX;
      note.placeholder = "Optional note (Tab to type)";
      note.setAttribute("aria-label", "Note");
      panel.append(note);
      const strokes = [];
      let drawing = false;
      let drawMode = false;
      let preview = null;
      const repaint = () => {
        if (!preview || !shot) return;
        const g = preview.getContext("2d");
        if (!g) return;
        g.drawImage(shot, 0, 0);
        g.lineWidth = Math.max(3, preview.width / 220);
        g.lineCap = "round";
        g.lineJoin = "round";
        g.strokeStyle = "#ff3b30";
        for (const stroke of strokes) {
          g.beginPath();
          for (let i = 0; i < stroke.points.length; i += 2) {
            if (i === 0) g.moveTo(stroke.points[i], stroke.points[i + 1]);
            else g.lineTo(stroke.points[i], stroke.points[i + 1]);
          }
          if (stroke.points.length === 2) g.lineTo(stroke.points[0] + 0.1, stroke.points[1]);
          g.stroke();
        }
      };
      if (shot) {
        const wrap = el("div", "shot");
        preview = el("canvas");
        preview.width = shot.width;
        preview.height = shot.height;
        wrap.append(preview);
        const point = (event) => {
          const r = preview.getBoundingClientRect();
          return [(event.clientX - r.left) / r.width * preview.width, (event.clientY - r.top) / r.height * preview.height];
        };
        preview.addEventListener("pointerdown", (event) => {
          if (!drawMode) return;
          drawing = true;
          preview.setPointerCapture(event.pointerId);
          strokes.push({ points: point(event) });
          repaint();
        });
        preview.addEventListener("pointermove", (event) => {
          if (!drawing) return;
          strokes[strokes.length - 1].points.push(...point(event));
          repaint();
        });
        const stop = () => {
          drawing = false;
        };
        preview.addEventListener("pointerup", stop);
        preview.addEventListener("pointercancel", stop);
        const bar = el("div", "shotbar");
        const tools = el("div", "tools");
        const draw = el("button", "mini", "Draw on it");
        draw.type = "button";
        draw.setAttribute("aria-pressed", "false");
        draw.addEventListener("click", () => {
          drawMode = !drawMode;
          draw.setAttribute("aria-pressed", String(drawMode));
          wrap.classList.toggle("draw", drawMode);
        });
        const undo = el("button", "mini", "Undo");
        undo.type = "button";
        undo.addEventListener("click", () => {
          strokes.pop();
          repaint();
        });
        tools.append(draw, undo);
        bar.append(el("span", void 0, "Screenshot from just before this window"), tools);
        panel.append(wrap, bar);
        repaint();
      }
      const message = el("div", "msg");
      message.setAttribute("aria-live", "polite");
      panel.append(message);
      const foot = el("div", "foot");
      const actions = el("div", "actions");
      const cancel = el("button", "btn", "Close");
      cancel.type = "button";
      const submit = el("button", "btn primary", "Send");
      submit.type = "button";
      actions.append(cancel, submit);
      foot.append(el("div", "hint", "1–7 pick · Enter send · Esc close"), actions);
      panel.append(foot);
      backdrop.append(panel);
      parent.append(backdrop);
      panel.focus({ preventScroll: true });
      let allowed = access?.ok === true;
      if (!allowed) {
        submit.disabled = true;
        message.textContent = "Checking your hub sign-in…";
        void checkAccess(true).then((result) => {
          if (!panelOpen) return;
          allowed = result.ok;
          submit.disabled = !result.ok;
          message.textContent = result.ok ? "" : refusal(result.reason);
          message.classList.toggle("bad", !result.ok);
        });
      }
      const close = () => {
        if (!panelOpen) return;
        panelOpen = false;
        closePanel = null;
        panelKey = null;
        backdrop.remove();
        lastFrame = 0;
        try {
          previousFocus?.focus?.({ preventScroll: true });
        } catch {
        }
        try {
          if (!running) options.resume?.(token);
        } finally {
          options.onClose?.();
        }
      };
      closePanel = close;
      const doSubmit = () => {
        if (!allowed || submit.disabled) return;
        const text = note.value.trim();
        if (!selected.size && !text) {
          message.textContent = "Pick an option or write a note.";
          message.classList.add("bad");
          return;
        }
        const image = preview ? encode(preview, FEEDBACK_IMAGE_MAX) : "";
        if (strokes.length) captured.meta.annotated = true;
        const submission = {
          categories: FEEDBACK_CATEGORIES.map((c) => c.id).filter((id) => selected.has(id)),
          note: text.slice(0, FEEDBACK_NOTE_MAX),
          image,
          clientTime: captured.clientTime,
          source,
          meta: captured.meta
        };
        close();
        send(submission);
      };
      cancel.addEventListener("click", close);
      submit.addEventListener("click", doSubmit);
      backdrop.addEventListener("pointerdown", (event) => {
        if (event.target === backdrop) close();
      });
      panelKey = (event) => {
        const typing = event.composedPath()[0] === note;
        if (event.type !== "keydown") return;
        if (event.key === "Escape") {
          event.preventDefault();
          close();
        } else if (event.key === "Enter" && (!typing || event.ctrlKey || event.metaKey)) {
          event.preventDefault();
          doSubmit();
        } else if (!typing && !event.ctrlKey && !event.metaKey && !event.altKey && /^[1-7]$/.test(event.key)) {
          event.preventDefault();
          toggle(Number(event.key) - 1);
        } else if (event.key === "Tab") {
          const focusable = [...chipButtons, note, ...Array.from(panel.querySelectorAll(".mini, .btn"))].filter((n) => !n.disabled);
          const current = focusable.indexOf(event.composedPath()[0]);
          const next = current < 0 ? event.shiftKey ? focusable.length - 1 : chipButtons.length : (current + (event.shiftKey ? -1 : 1) + focusable.length) % focusable.length;
          event.preventDefault();
          focusable[next]?.focus();
        }
      };
      options.onOpen?.();
    }
    function begin(source) {
      if (panelOpen || capturing || disposed) return;
      if (access && !access.ok) {
        toast(refusal(access.reason));
        if (access.reason !== "standalone") void checkAccess(true);
        return;
      }
      capturing = true;
      const captured = snapshot(source);
      let done = false;
      const run = () => {
        if (done) return;
        done = true;
        const page = options.overlay !== false;
        let capture = null;
        let list = [];
        try {
          options.beforeCapture?.();
          list = options.canvases?.() ?? Array.from(document.querySelectorAll("canvas"));
          capture = captureCanvases(list, 960, page);
        } catch {
          capture = null;
        }
        if (!page || !capture) {
          capturing = false;
          openPanel(source, capture?.shot ?? null, captured);
          return;
        }
        const { shot, drawn } = capture;
        try {
          shot.getContext("2d")?.getImageData(0, 0, 1, 1);
        } catch {
        }
        let finished = false;
        const finish = (overlay) => {
          if (finished) return;
          finished = true;
          capturing = false;
          const any = drawOverlay(shot, overlay) || drawn > 0;
          openPanel(source, any ? shot : null, captured);
        };
        const timer = window.setTimeout(() => finish(null), OVERLAY_WAIT_MS);
        const drawHtml = typeof options.overlay === "function" ? options.overlay : () => capturePage(document.body, [...list, ...host ? [host] : []], 960, OVERLAY_WAIT_MS);
        Promise.resolve().then(() => drawHtml()).then(
          (overlay) => {
            window.clearTimeout(timer);
            finish(overlay ?? null);
          },
          () => {
            window.clearTimeout(timer);
            finish(null);
          }
        );
      };
      requestAnimationFrame(run);
      window.setTimeout(run, 250);
    }
    function editable(target) {
      const node = target;
      if (!node || typeof node.tagName !== "string") return false;
      if (node.isContentEditable) return true;
      if (node.tagName === "TEXTAREA" || node.tagName === "SELECT") return true;
      if (node.tagName !== "INPUT") return false;
      const type = node.type;
      return !["button", "checkbox", "radio", "range", "submit", "reset", "color", "file"].includes(type);
    }
    const onKey = (event) => {
      if (panelOpen) {
        event.stopImmediatePropagation();
        panelKey?.(event);
        return;
      }
      if (event.code !== key || event.ctrlKey || event.metaKey || event.altKey) return;
      if (editable(event.composedPath()[0] ?? event.target)) return;
      try {
        if (options.enabled && !options.enabled()) return;
      } catch {
        return;
      }
      event.stopImmediatePropagation();
      event.preventDefault();
      if (event.type !== "keydown" || event.repeat) return;
      const now = performance.now();
      if (now - lastTap <= gap) {
        lastTap = -Infinity;
        begin("manual");
      } else {
        lastTap = now;
      }
    };
    const onError = (event) => {
      const reason = "reason" in event ? event.reason : event.error ?? event.message;
      const entry = describeError(reason);
      entry.at = Math.round(performance.now());
      if ("filename" in event && event.filename) entry.where = `${clip(event.filename.split("/").pop() ?? "", 80)}:${event.lineno}`;
      errors.push(entry);
      if (errors.length > ERROR_MAX) errors.shift();
      if (options.crashPrompt === false || panelOpen || disposed) return;
      const now = performance.now();
      if (now - lastCrashPrompt < 6e4) return;
      lastCrashPrompt = now;
      void checkAccess().then((result) => {
        if (result.ok && !panelOpen && !disposed) toast("Something went wrong.", { label: "Send report", run: () => begin("crash") }, 9e3);
      });
    };
    const onOnline = () => void flushQueue();
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("keyup", onKey, true);
    window.addEventListener("keypress", onKey, true);
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onError);
    window.addEventListener("online", onOnline);
    const warm = window.setTimeout(() => {
      void checkAccess();
      if (options.overlay === void 0) loadPageShot().catch(() => void 0);
    }, 4e3);
    return {
      open(source = "manual") {
        begin(source);
      },
      close() {
        closePanel?.();
      },
      isOpen: () => panelOpen,
      breadcrumb(type, data) {
        breadcrumbs.push({ t: Math.round(performance.now()), type: clip(type, 48), ...data ? { data } : {} });
        if (breadcrumbs.length > BREADCRUMB_MAX) breadcrumbs.shift();
      },
      dispose() {
        if (disposed) return;
        closePanel?.();
        disposed = true;
        cancelAnimationFrame(raf);
        window.clearTimeout(warm);
        window.clearTimeout(toastTimer);
        window.removeEventListener("keydown", onKey, true);
        window.removeEventListener("keyup", onKey, true);
        window.removeEventListener("keypress", onKey, true);
        window.removeEventListener("error", onError);
        window.removeEventListener("unhandledrejection", onError);
        window.removeEventListener("online", onOnline);
        host?.remove();
        host = null;
        root = null;
      }
    };
  }
  return __toCommonJS(index_exports);
})();
/*! modern-screenshot 4.7.0, https://www.npmjs.com/package/modern-screenshot
 * dist/index.mjs, unmodified below this comment. Vendored into @metaverse/hub-sdk for the
 * feedback screenshot (src/feedback.ts). License:
 *
 * The MIT License (MIT)
 *
 * Copyright (c) 2021-present wxm
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE. */
