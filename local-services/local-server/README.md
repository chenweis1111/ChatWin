# 聊机本地 AI 服务器（方案 B）

完整替代云端后端 `api.shiflow.com` 的本地服务器：客户端 RPA 部分（截图、拟人键鼠）零改动复用，AI 大脑换成本地配置的 DeepSeek / 豆包 API。零依赖 Node.js（开发验证 v24）。

## 启动

```bash
cd local-server
npm run dev                      # 默认 127.0.0.1:7200
node server.js --port 7201       # 自定义端口
node server.js --host 0.0.0.0 --port 7200
```

LLM key、模型、客服人设都在 `config.json` 里（浏览器/渲染层不可见，只有主进程发起的请求会到本服务器）。

## 客户端打补丁

```bash
python apply_local_patch.py            # biz/index.js 的 production httpOrigin -> http://127.0.0.1:7200
python apply_local_patch.py --restore  # 回滚（恢复 biz/index.js.before-local-patch）
```

补丁带锚点唯一性断言，改完自动 `node --check`。wss 任务推送地址故意不动（连不上会自动失败，不影响主流程）。

## 端点清单

| 端点 | 实现 |
|---|---|
| `POST /shiflow/v3/sees/speed`、`/shiflow/v2/sees/speed` | 核心。截图 → 豆包视觉（理解聊天+生成回复）→ SSE 动作流：`thinking` 思考流 → `keyboard` 回复分片（带 `is_end`/`chat_history_id`/`trace_id`）→ `event: done`。`agent_type=think/think_beta` 时用 DeepSeek 二次润色。无需回复时发 `stop-reply` |
| `POST /shiflow/v1/unread/detect` | 纯 JS PNG 解码（zlib 手工解 IHDR+IDAT+filter）+ 高饱和红色连通域检测（微信红点 #FA5151 特征），毫秒级，满足客户端 2.5s 超时 |
| `POST /shiflow/v1/sees/grounding/resolve` | 截图+operation → 豆包视觉返回像素坐标 JSON；逐字段回显 `operation/frame_id/coordinate_space:"frame_pixels"/frame_width_px/frame_height_px`；8% 容差钳制轻微越界坐标；失败/找不到返回 `{point:null}`（客户端有容错） |
| `POST /shiflow/v1/sees/chat/completions` | multipart 表单解析，转发豆包视觉，SSE 输出 `event: content` 分片 + `event: done` / `event: error` |
| `GET /shiflow/v1/accounts/open/settings`、`/accounts/settings` | 假账户：balance/left_count 999999，vip_level corp，2099 年过期 |
| `POST /shiflow/v1/accounts/see/use_code` | 假兑换，恒成功 |
| `GET /shiflow/v1/accounts/open/records`、`/accounts/records` | 空列表 |
| `GET /shiflow/v1/sees/settings` | 下发 agent_type 列表（极速 speed / 深思 think，shape 同客户端 DEFAULT_AGENT_TYPES） |
| `GET /shiflow/v1/sees/chat_records` | 本地沉淀记录分页查询（`body.items[]` 含 `chat_type/target_name/nickname/content/created_at`，`body.total`），支持 `chat_type/chat_name/date_start/date_end/page/page_size` |
| `GET /shiflow/v1/sees/chat_records/export` | HTML 表格 xls（带 BOM、五列格式与原版导出文件一致），定时导出功能可继续用 |
| `GET /health` | 健康检查 |
| 其他一切 | 统一 `{code:0, body:{}}` 兜底并 console.log 记录，方便后续补 |

## 聊天记录沉淀

每次 `/sees/speed` 理解的对话（客户最新消息 + AI 回复）追加到 `data/chat_records.jsonl`，AI 回复昵称固定 `sf_agent`（与原版一致）。列表/导出端点读这个文件。

## 已知限制

1. **Grounding 精度是全链路最弱一环**：豆包视觉模型返回的坐标有误差（实测 y 方向常偏差几十像素，已做 8% 容差钳制），且该模型为推理型，延迟 13–70s 波动，而客户端 grounding 超时 35s——约半数请求会超时/返回空点位，客户端走「未找到」分支，不会乱点，但搜索/收藏等依赖 grounding 的 RPA 流程成功率有限。
2. **unread/detect 仅支持 PNG**：零依赖服务器只实现了 PNG 解码；若客户端某路径上传 JPEG，返回 `code:4003` 让客户端重试后走自身兜底（不会崩溃）。
3. **chat/completions 客户端超时偏紧**：客户端默认 15s（部分调用 30s），慢速视觉模型可能超时，调用方已按失败处理。
4. 红点检测基于颜色启发式，对极端主题/自定义皮肤的微信可能漏检误检；正常默认皮肤实测准确。
5. 聊天记录来自 VLM 对截图的理解，`customer_message` 是模型转写，可能与原文有个别错字；`chat_type` 恒为模型判断的私聊/群聊。
6. wss 任务推送（定时任务下发）未实现，连接会静默失败，不影响主流程。

## 测试脚本

- `test_reddot.js`：生成带/不带红点的测试 PNG
- `test_e2e.js [speed|grounding|completion|all]`：用真实回放截图打端到端（需先启动服务器并改脚本里 BASE 端口）
- `extract.js "关键词" [前] [后] [条数]`：从 minified `biz/index.js` 挖上下文

## 回滚

1. `python apply_local_patch.py --restore`（恢复 `biz/index.js.before-local-patch`）
2. 更早的原始文件在 `biz/index.js.bak`（上一轮账户补丁前的版本）
3. 停掉 `node server.js` 进程即可
