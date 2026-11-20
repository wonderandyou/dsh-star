/**
 * dsh-star —— Client 半
 *
 * 每条助手回复底部：五颗星 + 打完分后出现「分析」。
 * 点「分析」打开一个小窗口：模型给出几条可改进的建议，勾选后写进规则。
 */

window.__ModuleLoader__.load({
  id: 'dsh-star',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useCallback, useRef } = React

    const CSS = `
.dtr-wrap{display:inline-flex;align-items:center;gap:6px;vertical-align:middle}
.dtr{display:inline-flex;align-items:center;gap:2px}
.dtr-star{
  appearance:none;border:none;background:transparent;padding:0 1px;
  font-size:14px;line-height:1;cursor:pointer;
  color:var(--dsw-alias-text-secondary, GrayText);
  opacity:.55;
  transition:color 140ms ease,opacity 140ms ease,transform 160ms cubic-bezier(.2,.9,.3,1.2);
}
.dtr-star:hover:not(:disabled){transform:translateY(-1px) scale(1.15);opacity:1}
.dtr-star.dtr-on{
  opacity:1;
  color:#e8a91d;
  text-shadow:0 0 10px rgba(232,169,29,.35);
}
.dtr-star:focus-visible{
  outline:2px solid var(--dsw-alias-accent-primary, AccentColor);
  outline-offset:2px;border-radius:5px;
}
.dtr-star:disabled{cursor:default}
.dtr-more{
  appearance:none;border:none;background:transparent;padding:0 6px;
  height:20px;border-radius:6px;
  font:inherit;font-size:11.5px;font-weight:500;line-height:1;cursor:pointer;
  color:var(--dsw-alias-text-secondary, GrayText);
  transition:background-color 140ms ease,color 140ms ease;
}
.dtr-more:hover{
  background:color-mix(in srgb, var(--dsw-alias-text-primary, CanvasText) 7%, transparent);
  color:var(--dsw-alias-text-primary, CanvasText);
}

/* ---------- 弹窗 ---------- */
.dtr-dialog{
  width:min(600px, calc(100vw - 40px));
  max-height:min(640px, calc(100vh - 48px));
  padding:0;border:none;border-radius:16px;overflow:hidden;
  background:var(--dsw-alias-surface-primary, Canvas);
  color:var(--dsw-alias-text-primary, CanvasText);
  box-shadow:
    0 0 0 1px color-mix(in srgb, var(--dsw-alias-text-primary, CanvasText) 8%, transparent),
    0 24px 64px -12px rgba(0,0,0,.32),
    0 8px 24px -8px rgba(0,0,0,.18);
}
.dtr-dialog[open]{
  display:flex;flex-direction:column;
  animation:dtr-pop 260ms cubic-bezier(.16,.9,.3,1.02);
}
@keyframes dtr-pop{
  from{opacity:0;transform:translateY(14px) scale(.965)}
  to{opacity:1;transform:none}
}
.dtr-dialog::backdrop{
  background:rgba(10,12,16,.42);
  backdrop-filter:blur(3px);
  animation:dtr-fade 260ms ease;
}
@keyframes dtr-fade{from{opacity:0}to{opacity:1}}

/* 顶部一道极细的主题渐变线，作为整块内容的"抬头" */
.dtr-dialog::before{
  content:"";position:absolute;inset:0 0 auto 0;height:1px;
  background:linear-gradient(90deg,
    transparent 0%,
    color-mix(in srgb, var(--dsw-alias-accent-primary, AccentColor) 55%, transparent) 30%,
    color-mix(in srgb, var(--dsw-alias-accent-primary, AccentColor) 55%, transparent) 70%,
    transparent 100%);
}

.dtr-hd{display:flex;align-items:flex-start;gap:12px;padding:18px 20px 0}
.dtr-hd-main{flex:1;min-width:0}
.dtr-hd h3{
  margin:0;font-size:16px;font-weight:650;letter-spacing:-.01em;
  line-height:1.3;
}
.dtr-sub{
  margin:5px 0 0;font-size:12px;line-height:1.5;
  color:var(--dsw-alias-text-secondary, GrayText);
}
.dtr-x{
  flex:none;width:30px;height:30px;border:none;border-radius:9px;background:transparent;
  color:var(--dsw-alias-text-secondary, GrayText);font-size:17px;line-height:1;cursor:pointer;
  transition:background-color 140ms ease,color 140ms ease;
}
.dtr-x:hover{
  background:color-mix(in srgb, var(--dsw-alias-text-primary, CanvasText) 8%, transparent);
  color:var(--dsw-alias-text-primary, CanvasText);
}

.dtr-score{
  display:flex;align-items:center;gap:9px;
  margin:12px 20px 0;padding:9px 13px;border-radius:10px;
  background:var(--dsw-alias-surface-subtle, Canvas);
}
.dtr-score-stars{font-size:13px;letter-spacing:1.5px;color:#e8a91d}
.dtr-score-txt{
  font-size:12px;font-weight:600;
  color:var(--dsw-alias-text-primary, CanvasText);
  font-variant-numeric:tabular-nums;
}

.dtr-body{flex:1;min-height:110px;overflow:auto;padding:14px 20px 16px}
.dtr-tip{font-size:12.5px;line-height:1.65;color:var(--dsw-alias-text-secondary, GrayText)}
.dtr-tip-lead{margin:0 0 10px}

/* 建议卡片 */
.dtr-item{
  position:relative;display:flex;align-items:flex-start;gap:10px;
  padding:11px 12px 11px 13px;margin-bottom:8px;
  border:1px solid var(--dsw-alias-border-subtle, CanvasText);border-radius:11px;
  cursor:pointer;font-size:13px;line-height:1.65;
  background:var(--dsw-alias-surface-primary, Canvas);
  transition:background-color 150ms ease,border-color 150ms ease,transform 150ms ease,box-shadow 150ms ease;
  animation:dtr-item-in 260ms cubic-bezier(.2,.8,.3,1) both;
}
@keyframes dtr-item-in{
  from{opacity:0;transform:translateY(4px)}
  to{opacity:1;transform:none}
}
.dtr-item:hover{
  transform:translateY(-1px);
  border-color:color-mix(in srgb, var(--dsw-alias-accent-primary, AccentColor) 40%, var(--dsw-alias-border-subtle, CanvasText));
  box-shadow:0 4px 14px -8px rgba(0,0,0,.28);
}
.dtr-item.on{
  border-color:color-mix(in srgb, var(--dsw-alias-accent-primary, AccentColor) 65%, transparent);
  background:color-mix(in srgb, var(--dsw-alias-accent-primary, AccentColor) 7%, var(--dsw-alias-surface-primary, Canvas));
}
.dtr-item.on::before{
  content:"";position:absolute;left:0;top:9px;bottom:9px;width:3px;border-radius:0 3px 3px 0;
  background:var(--dsw-alias-accent-primary, AccentColor);
  box-shadow:0 0 8px -1px color-mix(in srgb, var(--dsw-alias-accent-primary, AccentColor) 60%, transparent);
}
.dtr-item input{
  flex:none;margin:3px 0 0;width:14px;height:14px;cursor:pointer;
  accent-color:var(--dsw-alias-accent-primary, AccentColor);
}
.dtr-item span{flex:1;min-width:0}

/* 加载态：三点脉冲 */
.dtr-loading{display:flex;align-items:center;gap:9px;padding:6px 0}
.dtr-dots{display:inline-flex;gap:4px}
.dtr-dot{
  width:5px;height:5px;border-radius:50%;
  background:var(--dsw-alias-accent-primary, AccentColor);
  animation:dtr-bounce 1.1s ease-in-out infinite;
}
.dtr-dot:nth-child(2){animation-delay:.14s}
.dtr-dot:nth-child(3){animation-delay:.28s}
@keyframes dtr-bounce{
  0%,100%{opacity:.28;transform:translateY(0)}
  50%{opacity:1;transform:translateY(-3px)}
}

/* 错误态 */
.dtr-err{
  display:flex;gap:10px;align-items:flex-start;
  padding:11px 12px;border-radius:10px;
  font-size:12.5px;line-height:1.6;
  color:var(--dsw-alias-text-danger, #c0392b);
  background:color-mix(in srgb, var(--dsw-alias-text-danger, #c0392b) 8%, transparent);
  border:1px solid color-mix(in srgb, var(--dsw-alias-text-danger, #c0392b) 22%, transparent);
}
.dtr-err-mark{flex:none;font-weight:700}

/* 底部操作区 */
.dtr-ft{
  display:flex;align-items:center;gap:8px;
  padding:12px 20px;
  border-top:1px solid var(--dsw-alias-border-subtle, CanvasText);
  background:var(--dsw-alias-surface-subtle, Canvas);
}
.dtr-btn{
  appearance:none;border:1px solid var(--dsw-alias-border-subtle, CanvasText);
  background:var(--dsw-alias-surface-primary, Canvas);
  color:var(--dsw-alias-text-primary, CanvasText);
  border-radius:9px;padding:7px 14px;
  font:inherit;font-size:12.5px;font-weight:600;cursor:pointer;
  transition:background-color 140ms ease,border-color 140ms ease,transform 140ms ease,box-shadow 140ms ease;
}
.dtr-btn:hover:not([disabled]){
  border-color:color-mix(in srgb, var(--dsw-alias-text-primary, CanvasText) 26%, transparent);
  box-shadow:0 2px 8px -4px rgba(0,0,0,.24);
}
.dtr-btn:active:not([disabled]){transform:translateY(1px)}
.dtr-btn[disabled]{opacity:.42;cursor:default}
.dtr-btn-primary{
  border-color:transparent;
  background:linear-gradient(180deg,
    color-mix(in srgb, var(--dsw-alias-accent-primary, AccentColor) 88%, #fff) 0%,
    var(--dsw-alias-accent-primary, AccentColor) 100%);
  color:#fff;
  box-shadow:0 4px 14px -6px color-mix(in srgb, var(--dsw-alias-accent-primary, AccentColor) 70%, transparent);
}
.dtr-btn-primary:hover:not([disabled]){
  filter:brightness(1.06);
  box-shadow:0 6px 18px -6px color-mix(in srgb, var(--dsw-alias-accent-primary, AccentColor) 80%, transparent);
}
.dtr-note{
  margin-left:auto;font-size:11.5px;line-height:1.4;
  color:var(--dsw-alias-text-secondary, GrayText);
}

@media (prefers-reduced-motion: reduce){
  .dtr-star,.dtr-more,.dtr-item,.dtr-dialog,.dtr-dialog::backdrop,.dtr-btn,.dtr-score-fill{transition:none;animation:none}
  .dtr-dot{animation:none;opacity:.7}
}
`

    const STAR_FULL = '★'
    const STAR_EMPTY = '☆'

    function Stars(props) {
      const messageId = props && props.messageId
      const [score, setScore] = useState(0)
      const [hover, setHover] = useState(0)
      const [busy, setBusy] = useState(false)
      const [open, setOpen] = useState(false)
      const [phase, setPhase] = useState('idle') // idle | loading | ready | error
      const [tips, setTips] = useState([])
      const [picked, setPicked] = useState([])
      const [errMsg, setErrMsg] = useState('')
      const [note, setNote] = useState('')
      const dialogRef = useRef(null)

      useEffect(() => {
        if (!messageId) return
        let alive = true
        fetch('/star/state?messageId=' + encodeURIComponent(messageId), { headers: { accept: 'application/json' } })
          .then((r) => r.json())
          .then((j) => { if (alive && j && j.ok) setScore(Number(j.score) || 0) })
          .catch(() => {})
        return () => { alive = false }
      }, [messageId])

      useEffect(() => {
        const d = dialogRef.current
        if (!d) return
        if (open) { if (!d.open) d.showModal() }
        else if (d.open) d.close()
      }, [open])

      const rate = useCallback((n) => {
        if (!messageId || busy) return
        setBusy(true)
        fetch('/star/rate', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ messageId: messageId, score: n }),
        })
          .then((r) => r.json())
          .then((j) => { if (j && j.ok) setScore(n) })
          .catch(() => {})
          .then(() => setBusy(false))
      }, [messageId, busy])

      const startAnalyze = useCallback(() => {
        setOpen(true)
        setPhase('loading')
        setTips([])
        setPicked([])
        setErrMsg('')
        setNote('')
        fetch('/star/analyze', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ messageId: messageId, score: score }),
        })
          .then((r) => r.json())
          .then((j) => {
            if (j && j.ok && Array.isArray(j.suggestions) && j.suggestions.length) {
              setTips(j.suggestions)
              setPicked(j.suggestions.map(() => true))
              setPhase('ready')
            } else {
              setErrMsg((j && j.reason) || '没拿到建议')
              setPhase('error')
            }
          })
          .catch((e) => { setErrMsg(String((e && e.message) || e)); setPhase('error') })
      }, [messageId, score])

      const applyPicked = useCallback(() => {
        const list = tips.filter((_, i) => picked[i])
        if (!list.length) { setNote('先勾选至少一条'); return }
        setNote('写入中…')
        fetch('/star/apply', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ picked: list }),
        })
          .then((r) => r.json())
          .then((j) => {
            if (j && j.ok) {
              setNote('已写入规则 · 共 ' + j.count + ' 条')
              setTimeout(() => setOpen(false), 900)
            } else {
              setNote('写入失败：' + ((j && j.reason) || '未知原因'))
            }
          })
          .catch((e) => setNote('写入失败：' + String((e && e.message) || e)))
      }, [tips, picked])

      if (!messageId) return null
      const shown = hover || score

      const body = []
      if (phase === 'loading') {
        body.push(
          h('div', { key: 'l', className: 'dtr-loading' },
            h('span', { className: 'dtr-dots' },
              h('span', { className: 'dtr-dot' }),
              h('span', { className: 'dtr-dot' }),
              h('span', { className: 'dtr-dot' }),
            ),
            h('span', { className: 'dtr-tip' }, '正在读这条回复…'),
          ),
        )
      }
      if (phase === 'error') {
        body.push(
          h('div', { key: 'e', className: 'dtr-err' },
            h('span', { className: 'dtr-err-mark' }, '!'),
            h('span', null, errMsg),
          ),
        )
      }
      if (phase === 'ready') {
        body.push(h('p', { key: 'h', className: 'dtr-tip dtr-tip-lead' }, '勾选想长期生效的改进，点「加入规则」后会写进 AGENTS.md：'))
        tips.forEach((t, i) => {
          body.push(
            h('label', {
              key: 't' + i,
              className: 'dtr-item' + (picked[i] ? ' on' : ''),
              style: { animationDelay: i * 30 + 'ms' },
            },
              h('input', {
                type: 'checkbox',
                checked: Boolean(picked[i]),
                onChange: (ev) => {
                  const next = picked.slice()
                  next[i] = ev.target.checked
                  setPicked(next)
                },
              }),
              h('span', null, t),
            ),
          )
        })
      }

      const scoreStars = []
      for (let i = 1; i <= 5; i++) scoreStars.push(i <= score ? STAR_FULL : STAR_EMPTY)

      return h(
        React.Fragment,
        null,
        h('style', null, CSS),
        h(
          'span',
          { className: 'dtr-wrap' },
          h(
            'span',
            { className: 'dtr', role: 'group', 'aria-label': '给这条回复打分' },
            [1, 2, 3, 4, 5].map((n) => h('button', {
              key: n,
              type: 'button',
              className: 'dtr-star' + (n <= shown ? ' dtr-on' : ''),
              title: n + ' 星',
              'aria-label': n + ' 星',
              disabled: busy,
              onMouseEnter: () => setHover(n),
              onMouseLeave: () => setHover(0),
              onClick: () => rate(n),
            }, n <= shown ? STAR_FULL : STAR_EMPTY)),
          ),
          score > 0
            ? h('button', { type: 'button', className: 'dtr-more', onClick: startAnalyze, title: '看 AI 给的改进建议' }, '分析')
            : null,
        ),
        h(
          'dialog',
          {
            ref: dialogRef,
            className: 'dtr-dialog',
            onClose: () => setOpen(false),
            'aria-label': '改进建议',
          },
          h('div', { className: 'dtr-hd' },
            h('div', { className: 'dtr-hd-main' },
              h('h3', null, '可改进的地方'),
              h('p', { className: 'dtr-sub' }, '从这一轮的实际内容里提炼，勾选后写进规则'),
            ),
            h('button', { type: 'button', className: 'dtr-x', onClick: () => setOpen(false), 'aria-label': '关闭' }, '×'),
          ),
          h('div', { className: 'dtr-score' },
            h('span', { className: 'dtr-score-stars' }, scoreStars.join('')),
            h('span', { className: 'dtr-score-txt' }, score + ' / 5'),
          ),
          h('div', { className: 'dtr-body' }, body),
          h('div', { className: 'dtr-ft' },
            h('button', {
              type: 'button',
              className: 'dtr-btn dtr-btn-primary',
              disabled: phase !== 'ready',
              onClick: applyPicked,
            }, '加入规则'),
            h('button', { type: 'button', className: 'dtr-btn', onClick: () => setOpen(false) }, '关闭'),
            note ? h('span', { className: 'dtr-note' }, note) : null,
          ),
        ),
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('conversation.chat.assistant-actions', function () {
          return ctx.slots.register(
            { name: 'conversation.chat.assistant-actions', id: 'star', order: 5 },
            Stars,
          )
        })
      },
    }
  },
})
