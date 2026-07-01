figma.showUI(__html__, {
  width: 520,
  height: 920,
  themeColors: true
});

const NODE_NAMES = {
  template: "FCM模版",
  image: "人物",
  song: "歌名",
  artist: "歌手名",
  hires: "Hires标志",
  background: "背景",
  bigCircle: "大圆",
  smallCircle: "小圆"
};

let cachedTemplateNodeId = null;
const COZE_DEFAULT_OUTPUT_KEY = "output";
const SETTINGS_STORAGE_KEY = "fcm-create-helper.settings";

postTemplateStatus();
figma.on("selectionchange", postTemplateStatus);

figma.ui.onmessage = async (msg) => {
  if (!msg || typeof msg !== "object") {
    return;
  }

  if (msg.type === "ui-ready") {
    await postStoredSettings();
    postTemplateStatus();
    return;
  }

  if (msg.type === "request-template-status") {
    postTemplateStatus();
    return;
  }

  if (msg.type === "save-settings") {
    await savePluginSettings(msg.payload || {});
    return;
  }

  if (msg.type === "request-settings") {
    await postStoredSettings();
    return;
  }

  if (msg.type === "generate-batch") {
    await generateBatch(msg.payload || {});
    return;
  }

  if (msg.type === "coze-remove-background") {
    await handleCozeRemoveBackground(msg);
    return;
  }

  if (msg.type === "close-plugin") {
    figma.closePlugin();
  }
};

async function handleCozeRemoveBackground(msg) {
  const requestId = msg.requestId;
  let outputUrl = "";
  try {
    const payload = msg.payload || {};
    const fileName = typeof payload.fileName === "string" ? payload.fileName : "image.png";
    const mimeType = typeof payload.mimeType === "string" && payload.mimeType ? payload.mimeType : "image/png";
    const fileBytes = normalizeBytes(payload.bytes);
    const config = payload.config || {};
    const token = normalizeCozeToken(config.token);

    if (!token) {
      throw new Error("缺少 Coze Token。");
    }

    const fileId = await withStepLabel("上传文件到 Coze", async () => uploadFileToCoze({
      token,
      fileName,
      mimeType,
      bytes: fileBytes
    }));
    const output = await withStepLabel("调用 Coze 工作流", async () => runCozeWorkflowWithFileId({
      token,
      workflowId: config.workflowId,
      inputKey: config.inputKey,
      outputKey: config.outputKey,
      fileId
    }));
    outputUrl = unwrapCozeFileReference(output);

    if (!outputUrl) {
      throw new Error("没有从 Coze 工作流中拿到可用的抠图结果。");
    }

    const downloaded = await withStepLabel("下载 Coze 抠图结果", async () => downloadRemoteImage(outputUrl));
    figma.ui.postMessage({
      type: "coze-remove-background-result",
      requestId,
      ok: true,
      payload: {
        bytes: Array.from(downloaded.bytes),
        mimeType: downloaded.mimeType
      }
    });
  } catch (error) {
    const message = unknownErrorToMessage(error);
    const manualDownloadUrl = extractHostFromUrl(outputUrl) === "s.coze.cn" ? outputUrl : "";
    figma.ui.postMessage({
      type: "coze-remove-background-result",
      requestId,
      ok: false,
      error: message,
      manualDownloadUrl
    });
  }
}

function postTemplateStatus() {
  const template = resolveTemplateNode();
  figma.ui.postMessage({
    type: "template-status",
    templateName: template ? template.name : null
  });
}

async function postStoredSettings() {
  const settings = await loadPluginSettings();
  figma.ui.postMessage({
    type: "settings",
    payload: settings
  });
}

async function loadPluginSettings() {
  const stored = await figma.clientStorage.getAsync(SETTINGS_STORAGE_KEY);
  if (!stored || typeof stored !== "object") {
    return {};
  }
  return stored;
}

async function savePluginSettings(partial) {
  const current = await loadPluginSettings();
  const next = Object.assign({}, current, partial);
  await figma.clientStorage.setAsync(SETTINGS_STORAGE_KEY, next);
}

function resolveTemplateNode() {
  const [selected] = figma.currentPage.selection;
  if (selected && selected.name === NODE_NAMES.template && isTemplateCandidate(selected)) {
    cachedTemplateNodeId = selected.id;
    return selected;
  }

  if (cachedTemplateNodeId) {
    const cachedNode = figma.getNodeById(cachedTemplateNodeId);
    if (cachedNode && cachedNode.parent && isTemplateCandidate(cachedNode) && cachedNode.name === NODE_NAMES.template) {
      return cachedNode;
    }
    cachedTemplateNodeId = null;
  }

  const matches = figma.currentPage.findChildren((node) => {
    return node.name === NODE_NAMES.template && isTemplateCandidate(node);
  });

  const template = matches[0] || null;
  cachedTemplateNodeId = template ? template.id : null;
  return template;
}

function isTemplateCandidate(node) {
  return [
    "FRAME",
    "GROUP",
    "COMPONENT",
    "INSTANCE",
    "SECTION"
  ].includes(node.type);
}

async function generateBatch(payload) {
  const template = resolveTemplateNode();
  if (!template) {
    figma.notify("未找到 FCM 模板。请先选中模板，或确保当前页有一个名为“FCM模版”的节点。", {
      error: true
    });
    return;
  }

  const entries = Array.isArray(payload.entries) ? payload.entries : [];
  if (!entries.length) {
    figma.notify("没有可生成的数据。", { error: true });
    return;
  }

  const columns = clampInteger(payload.columns, 1, 10, 5);
  const gapX = clampInteger(payload.gapX, 0, 400, 48);
  const gapY = clampInteger(payload.gapY, 0, 400, 48);

  const startX = template.x;
  const startY = template.y + template.height + gapY;
  const generated = [];
  const issues = [];

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const clone = template.clone();
    clone.x = startX + (index % columns) * (template.width + gapX);
    clone.y = startY + Math.floor(index / columns) * (template.height + gapY);
    clone.name = `${entry.id || index + 1} ${entry.song} - ${entry.artist}`;

    try {
      const entryIssues = await populateTemplate(clone, entry);
      if (entryIssues.length) {
        for (const issue of entryIssues) {
          issues.push(`${clone.name}: ${issue}`);
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      issues.push(`${clone.name}: ${message}`);
    }

    generated.push(clone);
  }

  figma.currentPage.selection = generated;
  figma.viewport.scrollAndZoomIntoView(generated);

  const successMessage = `已生成 ${generated.length} 张 FCM 草稿`;
  figma.notify(issues.length ? `${successMessage}，但有 ${issues.length} 个提醒。` : successMessage);

  figma.ui.postMessage({
    type: "generate-complete",
    count: generated.length,
    issues
  });
}

async function populateTemplate(root, entry) {
  const issues = [];
  const songNode = findNamedNode(root, NODE_NAMES.song);
  const artistNode = findNamedNode(root, NODE_NAMES.artist);
  const hiresNode = findNamedNode(root, NODE_NAMES.hires);
  const layoutMetrics = getTextLayoutMetrics(songNode, artistNode);

  if (songNode && songNode.type === "TEXT") {
    await setTextValue(songNode, entry.song || "", {
      preserveWidth: true,
      anchorBottomWhenShrink: true
    });
  } else {
    issues.push(`未找到文本层“${NODE_NAMES.song}”`);
  }

  if (artistNode && artistNode.type === "TEXT") {
    await setTextValue(artistNode, entry.artist || "", {
      preserveWidth: true
    });
  } else {
    issues.push(`未找到文本层“${NODE_NAMES.artist}”`);
  }

  repositionTextLayout(songNode, artistNode, hiresNode, layoutMetrics);

  if (entry.imageBytes) {
    const imageNode = findImageTargetNode(root);
    if (imageNode) {
      setImageFill(imageNode, entry.imageBytes);
    } else {
      issues.push(`未找到可替换图片的图层“${NODE_NAMES.image}”`);
    }
  } else {
    issues.push("缺少人物图片数据");
  }

  if (entry.colors) {
    const colorTargets = [
      [NODE_NAMES.background, entry.colors.background],
      [NODE_NAMES.bigCircle, entry.colors.bigCircle],
      [NODE_NAMES.smallCircle, entry.colors.smallCircle]
    ];

    for (const [nodeName, colorSet] of colorTargets) {
      const node = findNamedNode(root, nodeName);
      if (!node || !("fills" in node)) {
        issues.push(`未找到可调色图层“${nodeName}”`);
        continue;
      }
      applyGradientFill(node, colorSet);
    }
  }

  return issues;
}

function getTextLayoutMetrics(songNode, artistNode) {
  if (!songNode || songNode.type !== "TEXT" || !artistNode || artistNode.type !== "TEXT") {
    return null;
  }

  return {
    songToArtistGap: artistNode.y - (songNode.y + songNode.height)
  };
}

function repositionTextLayout(songNode, artistNode, hiresNode, layoutMetrics) {
  if (!songNode || songNode.type !== "TEXT" || !artistNode || artistNode.type !== "TEXT" || !layoutMetrics) {
    return;
  }

  if (hiresNode) {
    const hiresCenterY = hiresNode.y + hiresNode.height / 2;
    artistNode.y = hiresCenterY - artistNode.height / 2;
  }

  songNode.y = artistNode.y - layoutMetrics.songToArtistGap - songNode.height;
}

function findNamedNode(root, targetName) {
  if (root.name === targetName) {
    return root;
  }

  if (!("children" in root)) {
    return null;
  }

  for (const child of root.children) {
    const match = findNamedNode(child, targetName);
    if (match) {
      return match;
    }
  }

  return null;
}

function findImageTargetNode(root) {
  const namedNode = findNamedNode(root, NODE_NAMES.image);
  if (!namedNode) {
    return null;
  }

  if (supportsImageFill(namedNode)) {
    return namedNode;
  }

  return findFillableDescendant(namedNode);
}

function findFillableDescendant(node) {
  if (supportsImageFill(node)) {
    return node;
  }

  if (!("children" in node)) {
    return null;
  }

  for (const child of node.children) {
    const match = findFillableDescendant(child);
    if (match) {
      return match;
    }
  }

  return null;
}

function supportsImageFill(node) {
  return "fills" in node && Array.isArray(node.fills);
}

async function setTextValue(node, value, options = {}) {
  await loadFontsForTextNode(node);
  const originalY = node.y;
  const originalWidth = node.width;
  const originalHeight = node.height;
  const shouldAnchorBottom = Boolean(options.anchorBottomWhenShrink);

  if (options.preserveWidth || shouldAnchorBottom) {
    node.textAutoResize = "HEIGHT";
    node.resizeWithoutConstraints(originalWidth, originalHeight);
  }

  node.characters = value;

  if (shouldAnchorBottom) {
    const heightDelta = originalHeight - node.height;
    if (heightDelta > 0) {
      node.y = originalY + heightDelta;
    } else {
      node.y = originalY;
    }
  }
}

async function loadFontsForTextNode(node) {
  if (node.fontName !== figma.mixed) {
    await figma.loadFontAsync(node.fontName);
    return;
  }

  const seen = new Set();
  for (const font of node.getRangeAllFontNames(0, node.characters.length)) {
    const key = `${font.family}::${font.style}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    await figma.loadFontAsync(font);
  }
}

function setImageFill(node, rawBytes) {
  const bytes = normalizeBytes(rawBytes);
  const image = figma.createImage(bytes);
  const imagePaint = {
    type: "IMAGE",
    imageHash: image.hash,
    scaleMode: "FILL"
  };
  node.fills = [imagePaint];
}

function normalizeBytes(rawBytes) {
  if (rawBytes instanceof Uint8Array) {
    return rawBytes;
  }

  if (rawBytes instanceof ArrayBuffer) {
    return new Uint8Array(rawBytes);
  }

  if (Array.isArray(rawBytes)) {
    return Uint8Array.from(rawBytes);
  }

  if (rawBytes && rawBytes.buffer instanceof ArrayBuffer) {
    return new Uint8Array(rawBytes.buffer);
  }

  throw new Error("无法识别图片字节数据。");
}

function applyGradientFill(node, colorSet) {
  if (!colorSet || !colorSet.start || !colorSet.end) {
    return;
  }

  const existingFills = Array.isArray(node.fills) ? node.fills : [];
  const gradientPaint = existingFills.find((paint) => paint.type === "GRADIENT_LINEAR");
  const newPaint = {
    type: "GRADIENT_LINEAR",
    gradientStops: [
      {
        position: 0,
        color: colorSet.start
      },
      {
        position: 1,
        color: colorSet.end
      }
    ],
    gradientTransform: gradientPaint ? gradientPaint.gradientTransform : [[1, 0, 0], [0, 1, 0]],
    opacity: gradientPaint && typeof gradientPaint.opacity === "number" ? gradientPaint.opacity : 1,
    visible: true,
    blendMode: "NORMAL"
  };

  node.fills = [newPaint];
}

function clampInteger(rawValue, min, max, fallback) {
  const value = Number.parseInt(String(rawValue), 10);
  if (Number.isNaN(value)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, value));
}

function normalizeCozeToken(token) {
  return String(token || "").trim().replace(/^Bearer\s+/i, "");
}

async function withStepLabel(label, task) {
  try {
    return await task();
  } catch (error) {
    const message = unknownErrorToMessage(error);
    throw new Error(`${label}失败：${message}`);
  }
}

function unknownErrorToMessage(error) {
  if (error instanceof Error) {
    return error.message || error.name || "未知错误";
  }

  if (typeof error === "string") {
    return error;
  }

  if (error && typeof error === "object") {
    const candidateKeys = ["message", "msg", "error", "statusText", "name"];
    for (const key of candidateKeys) {
      const value = error[key];
      if (typeof value === "string" && value.trim()) {
        return value.trim();
      }
    }

    try {
      const json = JSON.stringify(error);
      if (json && json !== "{}") {
        return json;
      }
    } catch (stringifyError) {
      // Ignore and fall through.
    }
  }

  return String(error);
}

async function uploadFileToCoze({ token, fileName, mimeType, bytes }) {
  const boundary = `----fcm-create-helper-${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`;
  const body = buildMultipartFormBody(boundary, fileName, mimeType, bytes);
  const response = await fetch("https://api.coze.cn/v1/files/upload", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": `multipart/form-data; boundary=${boundary}`
    },
    body
  });

  const payload = await parseJsonResponse(response, "Coze 上传文件");
  const fileId = payload && payload.data && payload.data.id;
  if (!fileId) {
    throw new Error("Coze 上传成功，但没有返回 file_id。");
  }
  return String(fileId);
}

function buildMultipartFormBody(boundary, fileName, mimeType, bytes) {
  const header =
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="file"; filename="${escapeMultipartValue(fileName)}"\r\n` +
    `Content-Type: ${mimeType || "application/octet-stream"}\r\n\r\n`;
  const footer = `\r\n--${boundary}--\r\n`;
  const headerBytes = stringToAsciiBytes(header);
  const footerBytes = stringToAsciiBytes(footer);
  const output = new Uint8Array(headerBytes.length + bytes.length + footerBytes.length);
  output.set(headerBytes, 0);
  output.set(bytes, headerBytes.length);
  output.set(footerBytes, headerBytes.length + bytes.length);
  return output;
}

function stringToAsciiBytes(value) {
  const text = String(value || "");
  const output = new Uint8Array(text.length);
  for (let index = 0; index < text.length; index += 1) {
    output[index] = text.charCodeAt(index) & 0xff;
  }
  return output;
}

function escapeMultipartValue(value) {
  return String(value || "file")
    .replaceAll("\r", "_")
    .replaceAll("\n", "_")
    .replaceAll("\"", "'");
}

async function runCozeWorkflowWithFileId({ token, workflowId, inputKey, outputKey, fileId }) {
  const body = JSON.stringify({
    workflow_id: workflowId || "7628515841907015721",
    parameters: {
      [inputKey || "create"]: JSON.stringify({ file_id: String(fileId) })
    }
  });

  let runFailure = null;

  try {
    const response = await fetch("https://api.coze.cn/v1/workflow/run", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body
    });
    const payload = await parseJsonResponse(response, "Coze workflow/run");
    const output = extractConfiguredOutput(payload, outputKey || COZE_DEFAULT_OUTPUT_KEY);
    if (output) {
      return output;
    }
    runFailure = new Error("workflow/run 没有返回可用的 output。");
  } catch (error) {
    runFailure = error instanceof Error ? error : new Error(String(error));
  }

  const streamResponse = await fetch("https://api.coze.cn/v1/workflow/stream_run", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body
  });
  const streamText = await streamResponse.text();

  if (!streamResponse.ok) {
    const prefix = runFailure ? `${runFailure.message}；` : "";
    throw new Error(`${prefix}${buildHttpErrorMessage("Coze workflow/stream_run", streamResponse.status, streamText)}`);
  }

  const streamedOutput =
    extractConfiguredOutput(streamText, outputKey || COZE_DEFAULT_OUTPUT_KEY) ||
    extractConfiguredOutputFromStreamText(streamText, outputKey || COZE_DEFAULT_OUTPUT_KEY);

  if (!streamedOutput) {
    const prefix = runFailure ? `${runFailure.message}；` : "";
    throw new Error(`${prefix}workflow/stream_run 没有返回可用的 output。`);
  }

  return streamedOutput;
}

async function downloadRemoteImage(url) {
  const host = extractHostFromUrl(url);
  if (host === "s.coze.cn") {
    const resolvedUrl = await resolveCozeShortUrl(url);
    if (resolvedUrl && resolvedUrl !== url) {
      return downloadRemoteImage(resolvedUrl);
    }
  }

  let response;
  try {
    response = await fetch(url);
  } catch (error) {
    const message = unknownErrorToMessage(error);
    throw new Error(`${message}${host ? `（目标域名：${host}）` : ""}`);
  }
  const buffer = await response.arrayBuffer();
  if (!response.ok) {
    const decoder = new TextDecoder();
    throw new Error(buildHttpErrorMessage("下载 Coze 抠图结果", response.status, decoder.decode(buffer.slice(0, 200))));
  }

  return {
    bytes: new Uint8Array(buffer),
    mimeType: readContentTypeHeader(response) || "image/png"
  };
}

function readContentTypeHeader(response) {
  return readHeader(response, "content-type");
}

function extractHostFromUrl(url) {
  const value = String(url || "").trim();
  const match = value.match(/^https?:\/\/([^\/?#]+)/i);
  return match ? match[1] : "";
}

async function resolveCozeShortUrl(url) {
  let response;
  try {
    response = await fetch(url, {
      method: "GET",
      redirect: "manual"
    });
  } catch (error) {
    const message = unknownErrorToMessage(error);
    throw new Error(`${message}（目标域名：${extractHostFromUrl(url)}）`);
  }

  const location = readHeader(response, "location");
  if (location) {
    return location;
  }

  return url;
}

function readHeader(response, headerName) {
  if (!response || !response.headers) {
    return null;
  }

  if (typeof response.headers.get === "function") {
    return response.headers.get(headerName);
  }

  const lower = String(headerName || "").toLowerCase();
  const directHeader =
    response.headers[lower] ||
    response.headers[headerName] ||
    response.headers[String(headerName || "").toUpperCase()];
  if (typeof directHeader === "string") {
    return directHeader;
  }

  return null;
}

async function parseJsonResponse(response, label) {
  const text = await response.text();
  let payload;

  try {
    payload = JSON.parse(text);
  } catch (error) {
    throw new Error(buildHttpErrorMessage(label, response.status, text));
  }

  if (!response.ok) {
    throw new Error(buildHttpErrorMessage(label, response.status, text));
  }

  if (payload && typeof payload.code === "number" && payload.code !== 0) {
    throw new Error(`${label}失败：${payload.msg || `code=${payload.code}`}`);
  }

  return payload;
}

function buildHttpErrorMessage(label, status, rawText) {
  const trimmed = String(rawText || "").trim();
  const shortText = trimmed.length > 180 ? `${trimmed.slice(0, 180)}...` : trimmed;
  return `${label}失败（HTTP ${status}）${shortText ? `：${shortText}` : ""}`;
}

function extractConfiguredOutput(payload, outputKey) {
  const byKey = findValueByKey(payload, outputKey);
  if (byKey) {
    return byKey;
  }
  return findAnyFileLikeValue(payload);
}

function extractConfiguredOutputFromStreamText(streamText, outputKey) {
  const events = parseStreamEvents(streamText);
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const output = extractConfiguredOutput(events[index], outputKey);
    if (output) {
      return output;
    }
  }
  return null;
}

function parseStreamEvents(streamText) {
  const events = [];
  const blocks = String(streamText || "").split(/\r?\n\r?\n+/);

  for (const block of blocks) {
    const dataLines = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .filter(Boolean);

    if (!dataLines.length) {
      continue;
    }

    const raw = dataLines.join("\n");
    if (raw === "[DONE]") {
      continue;
    }

    try {
      events.push(JSON.parse(raw));
    } catch (error) {
      events.push(raw);
    }
  }

  return events;
}

function findValueByKey(payload, outputKey) {
  if (!outputKey) {
    return null;
  }

  const visited = new Set();

  function visit(value) {
    if (!value) {
      return null;
    }

    if (typeof value === "string") {
      const direct = unwrapCozeFileReference(value);
      if (direct && direct !== value) {
        return direct;
      }

      const parsed = parseJsonLikeString(value);
      if (parsed !== null) {
        return visit(parsed);
      }

      return null;
    }

    if (Array.isArray(value)) {
      for (let index = value.length - 1; index >= 0; index -= 1) {
        const match = visit(value[index]);
        if (match) {
          return match;
        }
      }
      return null;
    }

    if (typeof value === "object") {
      if (visited.has(value)) {
        return null;
      }
      visited.add(value);

      if (Object.prototype.hasOwnProperty.call(value, outputKey)) {
        const direct = value[outputKey];
        const normalizedDirect = unwrapCozeFileReference(direct);
        if (normalizedDirect) {
          return normalizedDirect;
        }

        const nested = visit(direct);
        if (nested) {
          return nested;
        }
      }

      for (const nestedValue of Object.values(value)) {
        const match = visit(nestedValue);
        if (match) {
          return match;
        }
      }
    }

    return null;
  }

  return visit(payload);
}

function findAnyFileLikeValue(payload) {
  const visited = new Set();

  function visit(value) {
    if (!value) {
      return null;
    }

    if (typeof value === "string") {
      const normalized = unwrapCozeFileReference(value);
      if (normalized) {
        return normalized;
      }

      const parsed = parseJsonLikeString(value);
      if (parsed !== null) {
        return visit(parsed);
      }

      return null;
    }

    if (Array.isArray(value)) {
      for (let index = value.length - 1; index >= 0; index -= 1) {
        const match = visit(value[index]);
        if (match) {
          return match;
        }
      }
      return null;
    }

    if (typeof value === "object") {
      if (visited.has(value)) {
        return null;
      }
      visited.add(value);

      for (const nestedValue of Object.values(value)) {
        const match = visit(nestedValue);
        if (match) {
          return match;
        }
      }
    }

    return null;
  }

  return visit(payload);
}

function parseJsonLikeString(value) {
  const trimmed = String(value || "").trim();
  if (!trimmed || !/^[\[{"]/.test(trimmed)) {
    return null;
  }

  try {
    return JSON.parse(trimmed);
  } catch (error) {
    return null;
  }
}

function unwrapCozeFileReference(value) {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  const wrappedMatch = trimmed.match(/^<#file:(.+)#>$/);
  if (wrappedMatch) {
    return wrappedMatch[1].trim();
  }

  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed;
  }

  return null;
}
