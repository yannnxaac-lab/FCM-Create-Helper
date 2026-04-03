figma.showUI(__html__, {
  width: 520,
  height: 760,
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

postTemplateStatus();
figma.on("selectionchange", postTemplateStatus);

figma.ui.onmessage = async (msg) => {
  if (!msg || typeof msg !== "object") {
    return;
  }

  if (msg.type === "generate-batch") {
    await generateBatch(msg.payload || {});
    return;
  }

  if (msg.type === "close-plugin") {
    figma.closePlugin();
  }
};

function postTemplateStatus() {
  const template = resolveTemplateNode();
  figma.ui.postMessage({
    type: "template-status",
    templateName: template ? template.name : null
  });
}

function resolveTemplateNode() {
  const [selected] = figma.currentPage.selection;
  if (selected && isTemplateCandidate(selected)) {
    return selected;
  }

  const matches = figma.currentPage.findAll((node) => {
    return node.name === NODE_NAMES.template && isTemplateCandidate(node);
  });

  return matches[0] || null;
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
        issues.push(...entryIssues.map((issue) => `${clone.name}: ${issue}`));
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
