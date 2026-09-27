# -*- coding: utf-8 -*-
"""聊机本地 OCR 服务（RapidOCR，端口 7300）。
借鉴开源项目 screen-ocr-sim-agent 的本地 OCR 思路，
为 local-server 提供毫秒~秒级的文字识别，替代慢速 VLM 调用。

端点：
  POST /ocr               {image_base64, region?:[x,y,w,h]} -> {code, boxes:[{text,bbox,score}], elapsed_ms}
  POST /ocr/last_message  {image_base64} -> {code, message:{role,text,bbox}|null, elapsed_ms}
  GET  /health            -> {ok: true}
"""
import base64
import io
import json
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np
from PIL import Image
from rapidocr_onnxruntime import RapidOCR

ocr = None


def get_ocr():
    global ocr
    if ocr is None:
        ocr = RapidOCR(det_limit_side_len=512, use_cls=False)  # 关方向分类+限长边，提速
    return ocr


def decode_image(b64):
    b64 = b64.split("base64,")[-1]
    return Image.open(io.BytesIO(base64.b64decode(b64))).convert("RGB")


def run_ocr(img):
    engine = get_ocr()
    arr = np.array(img)
    result, _ = engine(arr)
    boxes = []
    for item in result or []:
        quad, text, score = item[0], item[1], float(item[2])
        xs = [p[0] for p in quad]
        ys = [p[1] for p in quad]
        boxes.append({
            "text": text,
            "bbox": [[int(min(xs)), int(min(ys))], [int(max(xs)), int(max(ys))]],
            "score": round(score, 3),
        })
    return boxes


def last_message(img, app_type="wechat", bottom=False):
    """裁剪右侧聊天面板做 OCR，判断最后一条消息的方向（兼容微信/企微布局）。
    bottom=True 时只扫聊天区下半部分（发送核实场景：刚发的气泡必在底部），显著提速。"""
    w, h = img.size
    # 企微左侧栏+列表更宽
    pane_ratio = 0.36 if app_type == "wecom" else 0.30
    pane_left = int(w * pane_ratio)
    top = int(h * 0.45) if bottom else int(h * 0.08)
    crop = img.crop((pane_left, top, w, int(h * 0.92)))
    boxes = run_ocr(crop)
    if not boxes:
        return None
    # 还原到全图坐标
    for b in boxes:
        b["bbox"][0][0] += pane_left; b["bbox"][1][0] += pane_left
        b["bbox"][0][1] += top;       b["bbox"][1][1] += top
    # 过滤掉输入区以下的内容（底部 12% 是输入框/工具栏）
    cutoff = int(h * 0.88)
    boxes = [b for b in boxes if b["bbox"][1][1] <= cutoff]
    # 过滤时间戳/日期行（不是消息内容）
    import re as _re
    boxes = [b for b in boxes if not _re.fullmatch(r"[\d:：\-/年月日周星期一二三四五六天 ]{4,20}", b["text"])]
    if not boxes:
        return None
    # 取最靠下的 3 条气泡（位置序≈时间序），逐条判方向
    boxes.sort(key=lambda b: b["bbox"][1][1])
    lasts = boxes[-3:]
    pane_w = w - pane_left

    # 颜色辅助：企微/微信我方气泡是绿色系，采样泡泡内角填充色，明显偏绿则铁定是我方
    def _fill_color(bx):
        x1, y1 = bx[0]
        pts = []
        for dx in (1, 3, 5):
            for dy in (1, 3, 5):
                px, py = min(max(x1 + dx, 0), w - 1), min(max(y1 + dy, 0), h - 1)
                pts.append(img.getpixel((px, py)))
        pts.sort()
        return pts[len(pts) // 2]

    def _is_green(c):
        r, g, b_ = c
        return g > 130 and g > r + 25 and g > b_ + 25

    for b in lasts:
        x2_rel = b["bbox"][1][0] - pane_left
        x1_rel = b["bbox"][0][0] - pane_left
        if _is_green(_fill_color(b["bbox"])):
            b["role"] = "right"
        elif x2_rel >= pane_w * 0.90:
            b["role"] = "right"
        elif x1_rel <= pane_w * 0.10:
            b["role"] = "left"
        else:
            b["role"] = "right" if x1_rel >= pane_w * 0.45 else "left"
    last = lasts[-1]
    # 我方消息右对齐：文本右边缘贴近聊天区右缘；对方消息左对齐
    x2_rel = last["bbox"][1][0] - pane_left
    x1_rel = last["bbox"][0][0] - pane_left
    if _is_green(_fill_color(last["bbox"])):
        role = "right"
    elif x2_rel >= pane_w * 0.90:
        role = "right"
    elif x1_rel <= pane_w * 0.10:
        role = "left"
    else:
        # 居中情况用左侧起始判定（微信气泡文字总有左缩进，右气泡左边缘明显靠右）
        role = "right" if x1_rel >= pane_w * 0.45 else "left"
    return {"role": last["role"], "text": last["text"], "bbox": last["bbox"],
            "recent": [{"role": b["role"], "text": b["text"], "bbox": b["bbox"]} for b in lasts]}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _json(self, obj, status=200):
        data = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path.startswith("/health"):
            return self._json({"ok": True})
        self._json({"code": 404}, 404)

    def do_POST(self):
        t0 = time.time()
        try:
            n = int(self.headers.get("Content-Length", 0))
            payload = json.loads(self.rfile.read(n) or b"{}")
            b64 = payload.get("image_base64", "")
            if not b64:
                return self._json({"code": 4001, "msg": "missing image_base64"})
            img = decode_image(b64)
            if self.path.startswith("/ocr/last_message"):
                msg = last_message(img, payload.get("app_type", "wechat"), bool(payload.get("bottom")))
                return self._json({"code": 0, "message": msg,
                                   "elapsed_ms": int((time.time() - t0) * 1000)})
            if self.path.startswith("/ocr"):
                region = payload.get("region")
                offset = [0, 0]
                if region:
                    x, y, w, h = [int(v) for v in region]
                    img = img.crop((x, y, x + w, y + h))
                    offset = [x, y]
                boxes = run_ocr(img)
                for b in boxes:
                    b["bbox"][0][0] += offset[0]; b["bbox"][1][0] += offset[0]
                    b["bbox"][0][1] += offset[1]; b["bbox"][1][1] += offset[1]
                return self._json({"code": 0, "boxes": boxes,
                                   "elapsed_ms": int((time.time() - t0) * 1000)})
            self._json({"code": 404}, 404)
        except Exception as e:
            self._json({"code": 5000, "msg": str(e)[:200]}, 200)


if __name__ == "__main__":
    import sys
    port = 7300
    for i, a in enumerate(sys.argv):
        if a == "--port" and i + 1 < len(sys.argv):
            port = int(sys.argv[i + 1])
        elif a.startswith("--port="):
            port = int(a.split("=", 1)[1])
    get_ocr()  # 预热模型
    print(f"[OCR] listening on 127.0.0.1:{port}", flush=True)
    ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
