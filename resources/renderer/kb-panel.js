/* 聊机·知识库管理面板（注入 renderer）
   入口：window.__openKbPanel()（聊天历史页「📚 知识库」按钮调用）
   后端：本地 AI 服务 http://127.0.0.1:7200 的 /shiflow/v2/sees/files、/shiflow/v1/sees/files/upload、/kb/* 端点
   能力：上传/预览/删除知识库文档；测试某条客户消息会命中哪些知识库段落（回复时模型按此作答） */
(function () {
  'use strict';
  if (window.__openKbPanel) return;

  const API = 'http://127.0.0.1:7200';
  const GREEN = '#8bc34a';
  const GREEN_DARK = '#5c8a2e';
  let overlay = null;

  function h(tag, style, text) {
    const el = document.createElement(tag);
    if (style) el.style.cssText = style;
    if (text !== undefined) el.textContent = text;
    return el;
  }

  async function api(path, body) {
    const opt = body === undefined
      ? {}
      : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
    const r = await fetch(API + path, opt);
    const j = await r.json();
    const b = (j && j.body) || {};
    if (b.error) throw new Error(b.error);
    return b;
  }

  function toast(text, warn) {
    const t = h('div', `position:fixed;top:24px;left:50%;transform:translateX(-50%);z-index:999999;padding:9px 22px;border-radius:20px;font-size:13px;box-shadow:0 4px 16px rgba(0,0,0,.18);transition:opacity .4s;${warn ? 'background:#fff7e6;color:#ad6800;border:1px solid #ffd591;' : 'background:#f6ffed;color:#389e0d;border:1px solid #b7eb8f;'}`, text);
    document.body.appendChild(t);
    setTimeout(() => { t.style.opacity = '0'; setTimeout(() => t.remove(), 450); }, 3600);
  }

  function buildUI() {
    overlay = h('div', 'position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:99999;display:flex;align-items:center;justify-content:center;');
    const panel = h('div', 'background:#fff;width:760px;max-width:94vw;height:86vh;border-radius:12px;display:flex;flex-direction:column;overflow:hidden;box-shadow:0 12px 40px rgba(0,0,0,.25);font-size:13px;color:#333;');

    const head = h('div', 'display:flex;align-items:center;padding:12px 18px;border-bottom:1px solid #eee;background:#f6faf1;');
    head.appendChild(h('div', 'font-size:16px;font-weight:600;flex:1;color:#4a7a28;', '📚 知识库管理'));
    const closeBtn = h('button', 'border:none;background:none;font-size:20px;cursor:pointer;color:#999;', '✕');
    closeBtn.onclick = () => overlay.remove();
    head.appendChild(closeBtn);
    panel.appendChild(head);

    const bodyBox = h('div', 'flex:1;overflow-y:auto;padding:14px 18px;');
    panel.appendChild(bodyBox);
    overlay.appendChild(panel);

    // ---- 上传区 ----
    const upCard = h('div', 'border:1px solid #e8f0dc;border-radius:10px;padding:12px 14px;margin-bottom:12px;background:#fcfdf9;');
    upCard.appendChild(h('div', 'font-weight:600;color:#3d5a1e;margin-bottom:6px;', '① 上传知识库文档'));
    upCard.appendChild(h('div', 'font-size:12px;color:#999;margin-bottom:8px;', '支持 TXT / MD / CSV / JSON / Word(docx) / Excel(xlsx)，自动提取文字；PDF 与旧版 xls 能保存但暂不解析。回复客户时，产品相关内容会严格按这里的资料作答'));
    const upRow = h('div', 'display:flex;gap:8px;align-items:center;flex-wrap:wrap;');
    const fileI = h('input', 'font-size:12px;');
    fileI.type = 'file'; fileI.multiple = true;
    fileI.accept = '.txt,.md,.csv,.json,.docx,.xlsx,.pdf,.log';
    const upBtn = h('button', `border:none;background:${GREEN};color:#fff;border-radius:6px;padding:7px 18px;cursor:pointer;font-weight:600;`, '上传');
    const upStat = h('span', 'font-size:12px;color:#999;');
    upRow.appendChild(fileI); upRow.appendChild(upBtn); upRow.appendChild(upStat);
    upCard.appendChild(upRow);
    bodyBox.appendChild(upCard);

    upBtn.onclick = async () => {
      if (!fileI.files || !fileI.files.length) { toast('先选择文件', true); return; }
      upBtn.disabled = true;
      let okN = 0, failN = 0;
      for (const f of fileI.files) {
        upStat.textContent = `上传中：${f.name}…`;
        try {
          const fd = new FormData();
          fd.append('file', f, f.name);
          const r = await fetch(API + '/shiflow/v1/sees/files/upload', { method: 'POST', body: fd });
          const j = await r.json();
          if (j.code === 0 && j.body && !j.body.error) { okN++; }
          else { failN++; toast(`❌ ${f.name}：${(j.body && j.body.error) || j.msg || '上传失败'}`, true); }
        } catch (e) { failN++; toast(`❌ ${f.name}：${e.message || e}`, true); }
      }
      upStat.textContent = `完成：成功 ${okN} 个${failN ? '，失败 ' + failN + ' 个' : ''}`;
      upBtn.disabled = false;
      fileI.value = '';
      refreshList();
    };

    // ---- 文档列表 ----
    const listCard = h('div', 'border:1px solid #e8f0dc;border-radius:10px;padding:12px 14px;margin-bottom:12px;background:#fff;');
    const listHead = h('div', 'display:flex;align-items:center;margin-bottom:6px;');
    listHead.appendChild(h('div', 'font-weight:600;color:#3d5a1e;flex:1;', '② 已上传文档'));
    const refBtn = h('button', 'border:1px solid #ddd;background:#fff;border-radius:6px;padding:3px 12px;cursor:pointer;font-size:12px;', '刷新');
    listHead.appendChild(refBtn);
    listCard.appendChild(listHead);
    const listBox = h('div', 'font-size:12px;max-height:240px;overflow-y:auto;');
    listCard.appendChild(listBox);
    bodyBox.appendChild(listCard);

    async function refreshList() {
      listBox.textContent = '加载中…';
      try {
        const r = await fetch(API + '/shiflow/v2/sees/files?page=1&size=100');
        const j = await r.json();
        const items = (j.body && (j.body.items || j.body.files)) || [];
        listBox.textContent = '';
        if (!items.length) { listBox.appendChild(h('div', 'color:#999;', '（暂无文档，先在①上传）')); return; }
        for (const d of items) {
          const row = h('div', 'padding:5px 0;border-bottom:1px dashed #f0f0f0;display:flex;align-items:center;gap:8px;');
          row.appendChild(h('span', 'flex:1;font-weight:600;color:#3d5a1e;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;', d.name));
          row.appendChild(h('span', 'color:#999;white-space:nowrap;', `${(d.size / 1024).toFixed(0)}KB / 提取 ${d.chars} 字`));
          const pv = h('button', 'border:1px solid #ddd;background:#fff;border-radius:5px;padding:2px 10px;cursor:pointer;font-size:11px;', '预览');
          pv.onclick = () => previewDoc(d);
          const del = h('button', 'border:1px solid #f0b4b4;background:#fff;color:#c0392b;border-radius:5px;padding:2px 10px;cursor:pointer;font-size:11px;', '删除');
          del.onclick = async () => {
            if (!confirm(`删除知识库文档「${d.name}」？`)) return;
            try {
              await fetch(API + '/shiflow/v2/sees/files/' + encodeURIComponent(d.id), { method: 'DELETE' });
              toast('已删除'); refreshList();
            } catch (e) { toast('❌ ' + (e.message || e), true); }
          };
          row.appendChild(pv); row.appendChild(del);
          listBox.appendChild(row);
        }
      } catch (e) { listBox.textContent = '❌ ' + (e.message || e) + '（本地 AI 服务是否已启动？）'; }
    }
    refBtn.onclick = refreshList;

    // ---- 预览区 ----
    const pvBox = h('div', 'display:none;border:1px solid #eee;border-radius:8px;padding:8px 10px;margin-top:6px;font-size:12px;background:#f8faf4;white-space:pre-wrap;word-break:break-all;max-height:380px;overflow-y:auto;');
    listCard.appendChild(pvBox);
    async function previewDoc(d) {
      pvBox.style.display = 'block';
      pvBox.textContent = '加载中…';
      try {
        const b = await api('/kb/preview?id=' + encodeURIComponent(d.id));
        pvBox.textContent = b.preview ? `【${d.name}】（共 ${b.text_length} 字，完整内容）\n\n${b.preview}` : `【${d.name}】未解析出文字（该格式暂不支持解析，文件已保存但不参与回复）`;
      } catch (e) { pvBox.textContent = '❌ ' + (e.message || e); }
    }

    // ---- 检索测试 ----
    const testCard = h('div', 'border:1px solid #e8f0dc;border-radius:10px;padding:12px 14px;background:#fff;');
    testCard.appendChild(h('div', 'font-weight:600;color:#3d5a1e;margin-bottom:6px;', '③ 检索测试（看客户问题会命中哪些知识库内容）'));
    const testRow = h('div', 'display:flex;gap:8px;margin-bottom:6px;');
    const testI = h('input', 'flex:1;border:1px solid #ddd;border-radius:6px;padding:6px 10px;font-size:13px;');
    testI.placeholder = '输入一条客户消息，如：广电奔马卡多少钱';
    const testBtn = h('button', `border:none;background:${GREEN};color:#fff;border-radius:6px;padding:6px 16px;cursor:pointer;font-weight:600;`, '测试');
    testRow.appendChild(testI); testRow.appendChild(testBtn);
    testCard.appendChild(testRow);
    const testBox = h('div', 'font-size:12px;background:#f8faf4;border-radius:6px;padding:8px 10px;display:none;white-space:pre-wrap;word-break:break-all;max-height:200px;overflow-y:auto;');
    testCard.appendChild(testBox);
    bodyBox.appendChild(testCard);

    testBtn.onclick = async () => {
      const q = testI.value.trim();
      if (!q) { toast('先输入一条客户消息', true); return; }
      testBtn.disabled = true;
      testBox.style.display = 'block'; testBox.textContent = '检索中…';
      try {
        const b = await api('/kb/test', { query: q });
        testBox.textContent = b.empty
          ? `「${q}」未命中任何知识库段落——回复时按人设通用规则作答（建议补充相关知识库文档）`
          : `「${q}」命中以下知识库内容，回复将严格以此为准：\n\n${b.matched}`;
      } catch (e) { testBox.textContent = '❌ ' + (e.message || e); }
      finally { testBtn.disabled = false; }
    };

    refreshList();
  }

  window.__openKbPanel = function () {
    if (overlay) { overlay.remove(); overlay = null; }
    buildUI();
    document.body.appendChild(overlay);
  };
})();
