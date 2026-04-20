# FCM Create Helper 安装说明

## 文件说明

安装包中包含：

- `manifest.json`
- `code.js`
- `ui.html`
- `vendor/`
- 使用说明文档

## 在 Figma 中安装本地插件

### 方法一：Import plugin from manifest

1. 打开 Figma
2. 进入 `Plugins` 或 `Development` 相关菜单
3. 选择 `Import plugin from manifest...`
4. 选择安装包中的 `manifest.json`
5. 导入完成后，在本地插件列表中可看到：

`FCM Create Helper`

## 首次使用前检查

请确认你的 FCM 模板中有这些图层名：

- `人物`
- `歌名`
- `歌手名`
- `Hires标志`
- `背景`
- `大圆`
- `小圆`

模板根节点建议命名为：

`FCM模版`

## 基本使用方式

1. 在 Figma 中选中 `FCM模版`
2. 打开 `FCM Create Helper`
3. 上传 CSV
4. 上传序号图片
5. 选择图片处理方式：
   - `直接导入原图`
   - `使用 Coze 工作流去背`
6. 如果走 Coze 去背，填写 `Token / Workflow ID / 输入参数名 / 输出字段名`
7. 点击 `生成草稿`

## 关于图片导入

支持图片格式混用，例如：

- `jpg`
- `jpeg`
- `png`
- `webp`
- `gif`

插件会自动处理兼容格式，并统一写入 Figma。

## 关于透明 PNG

如果你上传的是已经抠好的透明 PNG：

- 插件会尽量保留透明背景
- 即使你选择了 Coze 去背，也会优先跳过去背流程

## 关于 Coze 去背

说明：

- Coze 去背需要你自己的 Coze Token 和工作流
- 插件会先上传图片，再把 `file_id` 传入工作流的 `Image` 输入参数
- 默认工作流参数：
  - `Workflow ID`: `7628515841907015721`
  - 输入参数名：`create`
  - 输出字段名：`output`

建议：

- 先使用新生成的 Token，不要继续使用已经暴露过的旧 Token
- 如果 Coze 工作流暂时失败，插件会回退为原图导入，不会直接中断整批生成
- Token 会保存在 Figma 插件本地存储中，下次打开会自动回填
- 如果要更换 Token，可点击 `清除已保存 Token`

## 常见问题

### 1. 找不到模板

请确认：

- 当前页面有一个名为 `FCM模版` 的节点
- 或你已经手动选中了该模板

### 2. 图片没有匹配上

请检查：

- CSV 中的 `id` 是否和图片文件名一致
- 例如 `001` 对应 `001.jpg`

### 3. 文字位置不理想

插件已经会自动处理歌名和歌手名位置，但极端长短标题仍可能需要手工微调。

### 4. 去背效果不理想

建议直接改用你熟悉的去背工具处理后，再把透明 PNG 导入插件，或者让 Coze 工作流先跑一版再手工微调。
