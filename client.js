/**
 * prompt-polish 客户端半：composer 工具行左侧的「✨ 润色」按钮。
 *
 * 浏览器加载器格式：window.__ModuleLoader__.load({ id, factory })。
 * 点击后：读草稿 → POST 宿主接口 → 把结果就地写回输入框（不发消息）。
 */
window.__ModuleLoader__.load({
  id: 'lin-prompt-polish',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const ENDPOINT = '/plugins/lin-prompt-polish/polish';

    /** 找 composer 编辑器：优先当前焦点，其次最靠下的可见候选。 */
    function findEditor() {
      const active = document.activeElement;
      if (active && (active.tagName === 'TEXTAREA' || active.isContentEditable)) return active;
      const nodes = Array.from(document.querySelectorAll('textarea, [contenteditable="true"]'));
      let best = null;
      for (const el of nodes) {
        const rect = el.getBoundingClientRect();
        if (rect.width < 100 || rect.height < 14) continue;
        if (best === null || rect.top > best.getBoundingClientRect().top) best = el;
      }
      return best;
    }

    function readDraft() {
      const el = findEditor();
      if (el === null) return '';
      const value = typeof el.value === 'string' ? el.value : el.innerText;
      return (value ?? '').trim();
    }

    /**
     * 写回草稿。React 受控组件会忽略直接赋值，必须走原生 setter + input 事件；
     * 富文本编辑器用 selectAll + insertText（保留撤销栈）。
     */
    function writeDraft(el, text) {
      if (typeof el.value === 'string') {
        const proto = Object.getPrototypeOf(el);
        const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
        if (setter) setter.call(el, text);
        else el.value = text;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      }
      if (el.isContentEditable) {
        el.focus();
        const selection = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(el);
        if (selection) {
          selection.removeAllRanges();
          selection.addRange(range);
        }
        const ok = document.execCommand && document.execCommand('insertText', false, text);
        if (!ok) {
          el.innerText = text;
          el.dispatchEvent(new Event('input', { bubbles: true }));
        }
        return true;
      }
      return false;
    }

    function PolishButton() {
      const [busy, setBusy] = React.useState(false);
      const [note, setNote] = React.useState('');

      const onClick = async () => {
        if (busy) return;
        const el = findEditor();
        const draft = readDraft();
        if (el === null || !draft) {
          setNote('没读到草稿');
          console.warn('[prompt-polish] 未读到草稿', { el, draft });
          return;
        }
        setBusy(true);
        setNote('');
        try {
          const response = await fetch(ENDPOINT, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ text: draft }),
          });
          if (!response.ok) {
            setNote('失败:' + response.status);
            console.error('[prompt-polish] HTTP 错误', response.status);
            return;
          }
          // SSE：边生成边把部分结果写回草稿，用户立刻就能看到文字出现，
          // 而不是干等整段生成完（总耗时不变，但体感快很多）。
          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let buffer = '';
          let finalText = '';
          let failed = false;
          const applyFrame = (frame) => {
            if (!frame.trim()) return;
            const lines = frame.split('\n');
            const eventLine = lines.find((l) => l.startsWith('event:'));
            const dataLine = lines.find((l) => l.startsWith('data:'));
            if (!dataLine) return;
            let payload = null;
            try {
              payload = JSON.parse(dataLine.slice(5).trim());
            } catch {
              return;
            }
            const kind = eventLine ? eventLine.slice(6).trim() : '';
            if (kind === 'error') {
              failed = true;
              setNote('失败:' + (payload.error || 'unknown'));
              return;
            }
            if (kind === 'done') return;
            if (payload.partial) {
              finalText = payload.partial;
              writeDraft(el, finalText);
            }
          };
          for (;;) {
            const read = await reader.read();
            if (read.done) break;
            buffer += decoder.decode(read.value, { stream: true });
            const frames = buffer.split('\n\n');
            buffer = frames.pop() ?? '';
            for (const frame of frames) applyFrame(frame);
          }
          if (buffer.trim()) applyFrame(buffer);
          if (failed) return;
          if (!finalText) {
            setNote('空结果');
            return;
          }
          writeDraft(el, finalText);
          setNote('已替换');
        } catch (error) {
          setNote('请求失败');
          console.error('[prompt-polish] 请求失败', error);
        } finally {
          setBusy(false);
        }
      };

      const accent = 'var(--dsw-accent, #4f7cff)'
      const label = busy ? '润色中…' : note ? '⚠ ' + note : '✨ 润色'
      const failed = note && note.startsWith('失败') || note === '空结果' || note === '请求失败'
      return h(
        'button',
        {
          type: 'button',
          onClick,
          disabled: busy,
          title: note || '把当前草稿优化成清晰可执行的提示词（就地替换，不发送）',
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            height: 28,
            padding: '0 12px',
            borderRadius: 999,
            cursor: busy ? 'progress' : 'pointer',
            fontSize: 12,
            fontWeight: 600,
            lineHeight: 1,
            border: '1px solid ' + (failed ? 'var(--dsw-danger, #e5484d)' : 'var(--dsw-alias-border, rgba(127,127,127,.25))'),
            background: failed ? 'var(--dsw-danger-bg, rgba(229,72,77,.12))' : 'transparent',
            color: failed ? 'var(--dsw-danger, #e5484d)' : 'var(--dsw-accent, #4f7cff)',
            opacity: busy ? 0.65 : 1,
            transition: 'background .15s ease, border-color .15s ease, transform .05s ease',
            userSelect: 'none',
          },
          onMouseEnter: (e) => {
            if (!busy && !failed) e.currentTarget.style.background = 'var(--dsw-accent-bg, rgba(79,124,255,.12))'
          },
          onMouseLeave: (e) => {
            if (!busy && !failed) e.currentTarget.style.background = 'transparent'
          },
          onMouseDown: (e) => {
            if (!busy) e.currentTarget.style.transform = 'scale(.96)'
          },
          onMouseUp: (e) => {
            e.currentTarget.style.transform = 'scale(1)'
          },
        },
        label,
      );
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('conversation.input.left', () =>
          ctx.slots.register(
            {
              name: 'conversation.input.left',
              id: 'prompt-polish',
              order: 5,
            },
            PolishButton,
          ),
        );
      },
    };
  },
});
