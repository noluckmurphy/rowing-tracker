import { useState, useEffect, useCallback, useRef } from 'react'
import { storage } from './storage.js'

// ─── Config ───────────────────────────────────────────────────────────────────
const STORAGE_KEY = 'rowing-sessions-v2'

// Dev: Vite proxy routes /api/anthropic → api.anthropic.com and injects the key
// Prod (Netlify): serverless function at /api/parse-pm5 proxies with server-side key
const IS_DEV = import.meta.env?.DEV
const API_URL = IS_DEV ? '/api/anthropic/v1/messages' : '/api/parse-pm5'

// ─── Seed data (your first 3 sessions) ───────────────────────────────────────
const SEED_SESSIONS = [
  {
    id: 'session-w1c',
    date: '2026-03-18',
    week: 1,
    sessionType: 'C',
    label: '8×250m / 2:00r',
    totalMeters: 2000,
    totalTime: '6:27.9',
    avgPace: '1:36.9',
    avgRate: null,
    notes: 'Beat prescribed range (1:40–1:44). Negative split 1:38→1:35. Short interval capacity well ahead of schedule — zones adjusted upward for Phase 1 C sessions.',
    splits: []
  },
  {
    id: 'session-w1b',
    date: '2026-03-14',
    week: 1,
    sessionType: 'B',
    label: 'Pyramid v1:00/1:00r ×7',
    totalMeters: 4322,
    totalTime: '16:00.0',
    avgPace: '1:51.0',
    avgRate: 27,
    notes: 'Prescribed 1:52–1:55. Ascending side textbook (1:53.6→1:52.3). Descending side too fast — final 1\' at 1:43.4/r32. Reserve problem: HR dropped 171→163 on final piece despite going 10s faster. Fix: use pace boat at 1:51 from stroke one.',
    splits: [
      { interval: 'Piece 1 (1:00↑)', meters: 264, pace: '1:53.6', rate: 29 },
      { interval: 'Rest 1', meters: 201, pace: null, rate: null },
      { interval: 'Piece 2 (2:00↑)', meters: 529, pace: '1:53.4', rate: 28 },
      { interval: 'Rest 2', meters: 226, pace: null, rate: null },
      { interval: 'Piece 3 (3:00↑)', meters: 803, pace: '1:52.0', rate: 27 },
      { interval: 'Rest 3', meters: 155, pace: null, rate: null },
      { interval: 'Piece 4 (4:00 peak)', meters: 1068, pace: '1:52.3', rate: 27 },
      { interval: 'Rest 4', meters: 296, pace: null, rate: null },
      { interval: 'Piece 5 (3:00↓)', meters: 811, pace: '1:50.9', rate: 27 },
      { interval: 'Rest 5', meters: 108, pace: null, rate: null },
      { interval: 'Piece 6 (2:00↓)', meters: 556, pace: '1:47.9', rate: 29 },
      { interval: 'Rest 6', meters: 144, pace: null, rate: null },
      { interval: 'Piece 7 (1:00↓)', meters: 290, pace: '1:43.4', rate: 32 },
    ]
  },
  {
    id: 'session-w1a',
    date: '2026-03-10',
    week: 1,
    sessionType: 'A',
    label: '30:00 Steady State',
    totalMeters: 7042,
    totalTime: '30:00',
    avgPace: '2:07.8',
    avgRate: 22,
    notes: 'Week 1 Session A. Right on target (prescribed 2:05–2:10). Negative split again — last 6\' at 2:03.7 vs 2:08.8 opener. Rate drifted 21→24. Keep it flat next time.',
    splits: [
      { interval: '0–6:00',   meters: 1397, pace: '2:08.8', rate: 21 },
      { interval: '6–12:00',  meters: 1390, pace: '2:09.4', rate: 22 },
      { interval: '12–18:00', meters: 1388, pace: '2:09.6', rate: 22 },
      { interval: '18–24:00', meters: 1413, pace: '2:07.3', rate: 23 },
      { interval: '24–30:00', meters: 1454, pace: '2:03.7', rate: 24 },
    ]
  }
]

// ─── Helpers ──────────────────────────────────────────────────────────────────
const TYPE_META = {
  A:    { label: 'Session A', color: '#4a9eff', desc: 'Aerobic Infrastructure' },
  B:    { label: 'Session B', color: '#f5a623', desc: 'Spice / Intervals' },
  C:    { label: 'Session C', color: '#e8321e', desc: 'Speed & Race Specificity' },
  TEST: { label: '2k Test',   color: '#c0392b', desc: 'Benchmark' },
  FREE: { label: 'Free Row',  color: '#7a788a', desc: 'Unstructured' },
}

function paceToWatts(paceStr) {
  if (!paceStr) return null
  const parts = paceStr.split(':')
  if (parts.length < 2) return null
  const secs = parseInt(parts[0]) * 60 + parseFloat(parts[1])
  if (!secs) return null
  return Math.round(2.8 / Math.pow(secs / 500, 3))
}

function compressImage(file, maxDim = 1568, quality = 0.85) {
  return new Promise((resolve, reject) => {
    const img = new Image()
    const objUrl = URL.createObjectURL(file)
    img.onload = () => {
      URL.revokeObjectURL(objUrl)
      let { width, height } = img
      if (width > maxDim || height > maxDim) {
        const scale = maxDim / Math.max(width, height)
        width = Math.round(width * scale)
        height = Math.round(height * scale)
      }
      const canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = height
      const ctx = canvas.getContext('2d')
      ctx.drawImage(img, 0, 0, width, height)
      const dataUrl = canvas.toDataURL('image/jpeg', quality)
      resolve({ base64: dataUrl.split(',')[1], mediaType: 'image/jpeg' })
    }
    img.onerror = () => { URL.revokeObjectURL(objUrl); reject(new Error('Failed to load image')) }
    img.src = objUrl
  })
}

// ─── PM5 Vision Parsing ───────────────────────────────────────────────────────
const PM5_SYSTEM_PROMPT = `You are a Concept2 PM5 rowing monitor data extractor.

The user will send 1–N screenshots from a Concept2 PM5 "View Detail" screen. Multiple screenshots may represent the same session where splits overflow to additional pages (common for pyramid/interval workouts).

CRITICAL: Synthesize ALL screenshots into ONE session. Never duplicate summary rows.

PM5 workout formats you may encounter:
1. Fixed distance (e.g. "2000m") — bold summary row + 500m cumulative splits
2. Fixed time (e.g. "30:00") — bold summary row + equal time-interval splits (meters per interval)
3. Fixed intervals (e.g. "4x4:00.0") — summary row + each piece shown with its own splits
4. Variable intervals / pyramids (e.g. "v1:00/1:00r...7") — many pieces of different duration, rest rows labeled "r1:00" etc.
5. Free row — summary only, no splits

The PM5 columns are always: time | meters | /500m pace | s/m (stroke rate) | optional HR
The bold/first row = overall summary for the work intervals only. "Total Time" shown separately includes rest.
Remaining rows = work pieces (with pace/rate) and rest rows (meters only, no pace).

For multi-page screenshots: Page 1 has summary + first N splits. Page 2+ continues splits. Combine all in order, deduplicating the summary row and any repeated context rows.

Label work pieces as "Piece 1 (1:00↑)", "Piece 2 (2:00↑)" etc for pyramids, including the direction.
Label rest rows as "Rest 1", "Rest 2" etc.

Return ONLY valid JSON with no markdown fences, no explanation:
{
  "date": "YYYY-MM-DD",
  "workoutType": "distance|time|intervals|pyramid|free",
  "workoutLabel": "e.g. 2000m or 30:00 or 4×4:00 or Pyramid v1:00/1:00r×7",
  "totalTime": "M:SS.s",
  "totalMeters": 4322,
  "avgPace": "M:SS.s",
  "avgRate": 27,
  "splits": [
    { "interval": "Piece 1 (1:00↑)", "meters": 264, "pace": "1:53.6", "rate": 29 },
    { "interval": "Rest 1", "meters": 201, "pace": null, "rate": null }
  ]
}
Use null for any field not visible. Parse date from screen (e.g. "Mar 14 2026" → "2026-03-14").`

async function parsePM5Screenshots(files) {
  const imageBlocks = await Promise.all(
    files.map(async (file) => {
      const { base64, mediaType } = await compressImage(file)
      return { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } }
    })
  )

  const headers = { 'Content-Type': 'application/json' }
  // Locally: API key injected by vite proxy. In Claude artifact: no key needed.
  // For deployed apps (Vercel, etc.) add a serverless function to proxy instead.

  const response = await fetch(API_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1000,
      system: PM5_SYSTEM_PROMPT,
      messages: [{
        role: 'user',
        content: [
          ...imageBlocks,
          { type: 'text', text: `Extract session data from ${files.length > 1 ? `these ${files.length} PM5 screenshots of the same session` : 'this PM5 screenshot'}. Return only JSON.` }
        ]
      }]
    })
  })

  if (!response.ok) {
    const errBody = await response.text().catch(() => '')
    if (response.status >= 500) {
      throw new Error('Image processing failed — try fewer or smaller images')
    }
    throw new Error(`API error ${response.status}: ${errBody}`)
  }
  const data = await response.json()
  const raw = data.content.find(b => b.type === 'text')?.text || ''
  const clean = raw.replace(/```json|```/gi, '').trim()
  try {
    return JSON.parse(clean)
  } catch {
    throw new Error('Failed to parse workout data from screenshot — try a clearer image')
  }
}

// ─── Global CSS ───────────────────────────────────────────────────────────────
const GLOBAL_CSS = `
  @import url('https://fonts.googleapis.com/css2?family=Epilogue:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;600&display=swap');
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  html, body, #root { min-height: 100vh; }
  body { background: #0a0a0c; }

  .drop-zone {
    border: 2px dashed #2a2a38; border-radius: 8px; padding: 32px 24px;
    text-align: center; cursor: pointer;
    transition: border-color 0.2s, background 0.2s;
  }
  .drop-zone:hover, .drop-zone.drag-over {
    border-color: #e8321e; background: rgba(232,50,30,0.04);
  }
  .thumb-row { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 12px; }
  .thumb {
    position: relative; width: 68px; height: 68px; border-radius: 5px;
    overflow: hidden; border: 1px solid #2a2a38; flex-shrink: 0;
  }
  .thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .thumb-del {
    position: absolute; top: 2px; right: 2px;
    background: rgba(0,0,0,0.75); border: none; color: #fff;
    border-radius: 50%; width: 18px; height: 18px; font-size: 12px;
    cursor: pointer; display: flex; align-items: center; justify-content: center;
  }
  .parse-btn {
    width: 100%; margin-top: 14px;
    background: linear-gradient(135deg, #e8321e, #ff6b52);
    border: none; color: #fff; border-radius: 6px; padding: 12px;
    font-family: 'JetBrains Mono', monospace; font-size: 12px;
    letter-spacing: 0.1em; text-transform: uppercase; cursor: pointer;
    font-weight: 600; transition: opacity 0.2s;
  }
  .parse-btn:disabled { opacity: 0.35; cursor: not-allowed; }
  .parse-btn:hover:not(:disabled) { opacity: 0.88; }
  .parsed-banner {
    background: rgba(46,204,113,0.06); border: 1px solid rgba(46,204,113,0.3);
    border-radius: 6px; padding: 14px 16px; margin-bottom: 16px;
  }
  .parsed-banner-label {
    font-family: 'JetBrains Mono', monospace; font-size: 10px;
    letter-spacing: 0.14em; text-transform: uppercase; color: #2ecc71; margin-bottom: 10px;
  }
  .parsed-chips { display: flex; gap: 12px; flex-wrap: wrap; }
  .parsed-chip span:first-child {
    font-family: 'JetBrains Mono', monospace; font-size: 10px;
    text-transform: uppercase; color: #7a788a; display: block; margin-bottom: 2px;
  }
  .parsed-chip span:last-child {
    font-family: 'JetBrains Mono', monospace; font-size: 15px; font-weight: 600; color: #e8e6f0;
  }
  .error-banner {
    background: rgba(232,50,30,0.08); border: 1px solid rgba(232,50,30,0.3);
    border-radius: 6px; padding: 10px 14px; margin-bottom: 14px;
    font-family: 'JetBrains Mono', monospace; font-size: 11px; color: #ff8070;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
  .spinner {
    width: 15px; height: 15px; border: 2px solid #2a2a38;
    border-top-color: #e8321e; border-radius: 50%;
    animation: spin 0.75s linear infinite; flex-shrink: 0;
  }
  .parsing-row {
    display: flex; align-items: center; gap: 10px; justify-content: center;
    padding: 14px; color: #7a788a;
    font-family: 'JetBrains Mono', monospace; font-size: 12px; margin-top: 14px;
  }
  .tab-row {
    display: flex; border: 1px solid #2a2a38; border-radius: 6px;
    overflow: hidden; margin-bottom: 22px;
  }
  .tab {
    flex: 1; padding: 9px 0; text-align: center; cursor: pointer;
    font-family: 'JetBrains Mono', monospace; font-size: 11px;
    letter-spacing: 0.1em; text-transform: uppercase; background: none;
    border: none; color: #7a788a; transition: all 0.15s;
  }
  .tab.active { background: #1c1c25; color: #e8e6f0; }
  .divider { border-top: 1px solid #2a2a38; margin: 18px 0; }
  .col-label {
    font-family: 'JetBrains Mono', monospace; font-size: 10px;
    text-transform: uppercase; letter-spacing: 0.1em; color: #7a788a;
  }
  .x-btn {
    background: none; border: none; color: #7a788a; cursor: pointer;
    font-size: 18px; line-height: 1; padding: 0; text-align: center;
  }
  .add-split-btn {
    background: none; border: 1px dashed #2a2a38; color: #7a788a;
    border-radius: 4px; padding: 5px 12px;
    font-family: 'JetBrains Mono', monospace; font-size: 11px;
    cursor: pointer; width: 100%; margin-top: 2px; transition: border-color 0.15s;
  }
  .add-split-btn:hover { border-color: #4a4a5a; color: #aba8be; }
  .card-hover:hover { border-color: #3a3a4a !important; }
`

// ─── Styles ───────────────────────────────────────────────────────────────────
const S = {
  app: { background: '#0a0a0c', color: '#e8e6f0', minHeight: '100vh', fontFamily: "'Epilogue', sans-serif", fontSize: 14 },
  header: { padding: '36px 40px 28px', borderBottom: '1px solid #2a2a38', background: 'linear-gradient(180deg,#0f0f14 0%,#0a0a0c 100%)' },
  eyebrow: { fontFamily: "'JetBrains Mono',monospace", fontSize: 10, letterSpacing: '0.2em', textTransform: 'uppercase', color: '#e8321e', marginBottom: 10 },
  h1: { fontSize: 28, fontWeight: 700, color: '#fff', letterSpacing: '-0.02em', marginBottom: 4 },
  subline: { fontFamily: "'JetBrains Mono',monospace", fontSize: 12, color: '#7a788a' },
  progressBar: { marginTop: 20, height: 4, background: '#1c1c25', borderRadius: 2, overflow: 'hidden' },
  main: { padding: '0 40px 60px' },
  statsRow: { display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', borderBottom: '1px solid #2a2a38', marginBottom: 32 },
  statCell: { padding: '20px 24px 20px 4px', borderRight: '1px solid #2a2a38' },
  statLabel: { fontFamily: "'JetBrains Mono',monospace", fontSize: 10, letterSpacing: '0.14em', textTransform: 'uppercase', color: '#7a788a', marginBottom: 6 },
  statValue: { fontFamily: "'JetBrains Mono',monospace", fontSize: 20, fontWeight: 700, color: '#e8e6f0' },
  sectionTitle: { fontFamily: "'JetBrains Mono',monospace", fontSize: 11, letterSpacing: '0.15em', textTransform: 'uppercase', color: '#7a788a', paddingTop: 28, paddingBottom: 14, borderBottom: '1px solid #2a2a38', marginBottom: 16, display: 'flex', alignItems: 'center', justifyContent: 'space-between' },
  addBtn: { background: '#e8321e', color: '#fff', border: 'none', borderRadius: 4, padding: '6px 16px', fontFamily: "'JetBrains Mono',monospace", fontSize: 11, letterSpacing: '0.1em', cursor: 'pointer', textTransform: 'uppercase' },
  card: { background: '#111116', border: '1px solid #2a2a38', borderRadius: 8, marginBottom: 10, overflow: 'hidden', transition: 'border-color 0.2s' },
  cardHeader: { display: 'flex', alignItems: 'center', gap: 14, padding: '16px 20px', cursor: 'pointer', userSelect: 'none' },
  badge: { fontFamily: "'JetBrains Mono',monospace", fontSize: 10, letterSpacing: '0.1em', padding: '3px 8px', borderRadius: 3, fontWeight: 700, flexShrink: 0 },
  cardMeta: { flex: 1, minWidth: 0 },
  cardLabel: { fontWeight: 600, fontSize: 14, color: '#e8e6f0' },
  cardDate: { fontFamily: "'JetBrains Mono',monospace", fontSize: 11, color: '#7a788a', marginTop: 2 },
  cardStats: { display: 'flex', gap: 20, fontFamily: "'JetBrains Mono',monospace", fontSize: 13, color: '#aba8be', flexShrink: 0 },
  chevron: { color: '#7a788a', fontSize: 12, transition: 'transform 0.25s', flexShrink: 0 },
  splitsWrap: { borderTop: '1px solid #2a2a38', padding: '0 20px 16px' },
  splitRow: { display: 'grid', gridTemplateColumns: '1.6fr 90px 90px 50px 70px', padding: '8px 0', borderBottom: '1px solid #1c1c25', fontFamily: "'JetBrains Mono',monospace", fontSize: 12, color: '#aba8be', alignItems: 'center' },
  splitHdr: { color: '#7a788a', fontSize: 10, letterSpacing: '0.1em', textTransform: 'uppercase', paddingBottom: 6, paddingTop: 12 },
  notesWrap: { padding: '10px 20px 16px', fontSize: 12, color: '#7a788a', fontStyle: 'italic', borderTop: '1px solid #1c1c25' },
  delBtn: { background: 'none', border: '1px solid #2a2a38', color: '#7a788a', borderRadius: 3, padding: '3px 8px', fontFamily: "'JetBrains Mono',monospace", fontSize: 10, cursor: 'pointer', marginTop: 4, marginRight: 20, float: 'right' },
  overlay: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.82)', zIndex: 100, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 },
  modal: { background: '#111116', border: '1px solid #2a2a38', borderRadius: 12, width: '100%', maxWidth: 600, maxHeight: '90vh', overflowY: 'auto', padding: 28 },
  modalTitle: { fontSize: 18, fontWeight: 700, marginBottom: 4, color: '#fff' },
  modalSub: { fontSize: 12, color: '#7a788a', marginBottom: 20 },
  fieldGroup: { marginBottom: 14 },
  label: { display: 'block', fontFamily: "'JetBrains Mono',monospace", fontSize: 10, letterSpacing: '0.12em', textTransform: 'uppercase', color: '#7a788a', marginBottom: 6 },
  input: { width: '100%', background: '#1c1c25', border: '1px solid #2a2a38', borderRadius: 4, color: '#e8e6f0', padding: '8px 12px', fontFamily: "'JetBrains Mono',monospace", fontSize: 13, outline: 'none', boxSizing: 'border-box' },
  select: { width: '100%', background: '#1c1c25', border: '1px solid #2a2a38', borderRadius: 4, color: '#e8e6f0', padding: '8px 12px', fontFamily: "'JetBrains Mono',monospace", fontSize: 13, outline: 'none', boxSizing: 'border-box' },
  textarea: { width: '100%', background: '#1c1c25', border: '1px solid #2a2a38', borderRadius: 4, color: '#e8e6f0', padding: '8px 12px', fontFamily: "'JetBrains Mono',monospace", fontSize: 12, outline: 'none', resize: 'vertical', minHeight: 58, boxSizing: 'border-box' },
  row2: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 },
  row3: { display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8 },
  btnRow: { display: 'flex', gap: 10, marginTop: 20, justifyContent: 'flex-end' },
  cancelBtn: { background: 'none', border: '1px solid #2a2a38', color: '#7a788a', borderRadius: 4, padding: '8px 18px', fontFamily: "'JetBrains Mono',monospace", fontSize: 12, cursor: 'pointer' },
  saveBtn: { background: '#e8321e', border: 'none', color: '#fff', borderRadius: 4, padding: '8px 18px', fontFamily: "'JetBrains Mono',monospace", fontSize: 12, cursor: 'pointer', fontWeight: 700 },
}

// ─── Scan Panel ───────────────────────────────────────────────────────────────
function ScanPanel({ onParsed, onError }) {
  const [files, setFiles] = useState([])
  const [previews, setPreviews] = useState([])
  const [parsing, setParsing] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const inputRef = useRef()

  const addFiles = (incoming) => {
    const valid = Array.from(incoming).filter(f => f.type.startsWith('image/'))
    if (!valid.length) return
    setFiles(p => [...p, ...valid])
    valid.forEach(f => setPreviews(p => [...p, URL.createObjectURL(f)]))
  }

  const removeFile = (i) => {
    URL.revokeObjectURL(previews[i])
    setFiles(p => p.filter((_, idx) => idx !== i))
    setPreviews(p => p.filter((_, idx) => idx !== i))
  }

  const handleParse = async () => {
    if (!files.length) return
    setParsing(true)
    try {
      const result = await parsePM5Screenshots(files)
      onParsed(result)
    } catch (err) {
      onError(err.message || 'Parsing failed')
    } finally {
      setParsing(false)
    }
  }

  return (
    <div>
      <div
        className={`drop-zone${dragOver ? ' drag-over' : ''}`}
        onDrop={e => { e.preventDefault(); setDragOver(false); addFiles(e.dataTransfer.files) }}
        onDragOver={e => { e.preventDefault(); setDragOver(true) }}
        onDragLeave={() => setDragOver(false)}
        onClick={() => inputRef.current?.click()}
      >
        <input ref={inputRef} type="file" accept="image/*" multiple style={{ display: 'none' }} onChange={e => addFiles(e.target.files)} />
        <div style={{ fontSize: 30, marginBottom: 8 }}>📸</div>
        <div style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 12, color: '#aba8be' }}>
          Drop PM5 screenshots here, or click to browse
        </div>
        <div style={{ fontSize: 11, color: '#7a788a', marginTop: 4 }}>
          1–N images · all PM5 formats · multi-page pyramids supported
        </div>
      </div>

      {previews.length > 0 && (
        <div className="thumb-row">
          {previews.map((url, i) => (
            <div key={i} className="thumb">
              <img src={url} alt={`Screenshot ${i + 1}`} />
              <button className="thumb-del" onClick={e => { e.stopPropagation(); removeFile(i) }}>×</button>
            </div>
          ))}
          <div style={{ alignSelf: 'center', fontFamily: 'monospace', fontSize: 11, color: '#7a788a', paddingLeft: 4 }}>
            {previews.length} screenshot{previews.length > 1 ? 's' : ''}
          </div>
        </div>
      )}

      {parsing ? (
        <div className="parsing-row">
          <div className="spinner" />
          Sending {files.length} image{files.length > 1 ? 's' : ''} to Claude Vision…
        </div>
      ) : (
        <button className="parse-btn" disabled={!files.length} onClick={handleParse}>
          {files.length ? `Parse ${files.length} Screenshot${files.length > 1 ? 's' : ''} →` : 'Select Screenshots to Continue'}
        </button>
      )}
    </div>
  )
}

// ─── Session Form ─────────────────────────────────────────────────────────────
function SessionForm({ onSave, onCancel }) {
  const [tab, setTab] = useState('scan')
  const [parseError, setParseError] = useState(null)
  const [parsedData, setParsedData] = useState(null)

  const [form, setForm] = useState({
    date: new Date().toISOString().slice(0, 10),
    week: '', sessionType: 'A', label: '',
    totalMeters: '', totalTime: '', avgPace: '', avgRate: '', notes: '',
  })
  const [splits, setSplits] = useState([{ interval: '', meters: '', pace: '', rate: '' }])

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))
  const setSplit = (i, k, v) => setSplits(s => s.map((r, idx) => idx === i ? { ...r, [k]: v } : r))
  const addSplit = () => setSplits(s => [...s, { interval: '', meters: '', pace: '', rate: '' }])
  const removeSplit = i => setSplits(s => s.filter((_, idx) => idx !== i))

  const handleParsed = (data) => {
    setParsedData(data)
    setParseError(null)
    setForm(f => ({
      ...f,
      date: data.date || f.date,
      label: data.workoutLabel || f.label,
      totalMeters: data.totalMeters != null ? String(data.totalMeters) : f.totalMeters,
      totalTime: data.totalTime || f.totalTime,
      avgPace: data.avgPace || f.avgPace,
      avgRate: data.avgRate != null ? String(data.avgRate) : f.avgRate,
    }))
    if (data.splits?.length) {
      setSplits(data.splits.map(s => ({
        interval: s.interval || '',
        meters: s.meters != null ? String(s.meters) : '',
        pace: s.pace || '',
        rate: s.rate != null ? String(s.rate) : '',
      })))
    }
    setTab('manual')
  }

  const handleSave = () => {
    const session = {
      ...form,
      id: `session-${Date.now()}`,
      week: parseInt(form.week) || 1,
      totalMeters: parseInt(form.totalMeters) || 0,
      avgRate: parseInt(form.avgRate) || 0,
      splits: splits
        .filter(s => s.interval || s.meters || s.pace)
        .map(s => ({ ...s, meters: parseInt(s.meters) || 0, rate: parseInt(s.rate) || 0 })),
    }
    onSave(session)
  }

  return (
    <div style={S.overlay}>
      <div style={S.modal}>
        <div style={S.modalTitle}>Log Session</div>
        <div style={S.modalSub}>Scan PM5 screenshots or enter manually — parsed data auto-fills the form.</div>

        <div className="tab-row">
          {[['scan', '📸  Scan Screenshots'], ['manual', '✏️  Manual Entry']].map(([key, lbl]) => (
            <button key={key} className={`tab${tab === key ? ' active' : ''}`} onClick={() => setTab(key)}>{lbl}</button>
          ))}
        </div>

        {parseError && <div className="error-banner">⚠ {parseError}</div>}

        {parsedData && tab === 'manual' && (
          <div className="parsed-banner">
            <div className="parsed-banner-label">✓ Parsed — review &amp; edit below</div>
            <div className="parsed-chips">
              {[
                ['Workout', parsedData.workoutLabel],
                ['Time', parsedData.totalTime],
                ['Meters', parsedData.totalMeters?.toLocaleString()],
                ['Avg Pace', parsedData.avgPace],
                ['Splits', parsedData.splits?.length ? `${parsedData.splits.length} rows` : null],
              ].filter(([, v]) => v != null).map(([k, v]) => (
                <div key={k} className="parsed-chip">
                  <span>{k}</span><span>{v}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {tab === 'scan' && (
          <>
            <ScanPanel onParsed={handleParsed} onError={msg => setParseError(msg)} />
            <div style={S.btnRow}>
              <button style={S.cancelBtn} onClick={onCancel}>Cancel</button>
            </div>
          </>
        )}

        {tab === 'manual' && (
          <>
            <div style={S.row2}>
              <div style={S.fieldGroup}>
                <label style={S.label}>Date</label>
                <input style={S.input} type="date" value={form.date} onChange={e => set('date', e.target.value)} />
              </div>
              <div style={S.fieldGroup}>
                <label style={S.label}>Week #</label>
                <input style={S.input} type="number" min="1" max="12" placeholder="1" value={form.week} onChange={e => set('week', e.target.value)} />
              </div>
            </div>
            <div style={S.row2}>
              <div style={S.fieldGroup}>
                <label style={S.label}>Session Type</label>
                <select style={S.select} value={form.sessionType} onChange={e => set('sessionType', e.target.value)}>
                  {Object.entries(TYPE_META).map(([k, v]) => (
                    <option key={k} value={k}>{v.label} — {v.desc}</option>
                  ))}
                </select>
              </div>
              <div style={S.fieldGroup}>
                <label style={S.label}>Label</label>
                <input style={S.input} placeholder="e.g. 4×4' Intervals" value={form.label} onChange={e => set('label', e.target.value)} />
              </div>
            </div>
            <div style={S.row3}>
              <div style={S.fieldGroup}>
                <label style={S.label}>Total Meters</label>
                <input style={S.input} type="number" placeholder="7042" value={form.totalMeters} onChange={e => set('totalMeters', e.target.value)} />
              </div>
              <div style={S.fieldGroup}>
                <label style={S.label}>Total Time</label>
                <input style={S.input} placeholder="30:00" value={form.totalTime} onChange={e => set('totalTime', e.target.value)} />
              </div>
              <div style={S.fieldGroup}>
                <label style={S.label}>Avg Pace /500m</label>
                <input style={S.input} placeholder="2:07.8" value={form.avgPace} onChange={e => set('avgPace', e.target.value)} />
              </div>
            </div>
            <div style={{ ...S.fieldGroup, maxWidth: 130 }}>
              <label style={S.label}>Avg Rate (s/m)</label>
              <input style={S.input} type="number" placeholder="22" value={form.avgRate} onChange={e => set('avgRate', e.target.value)} />
            </div>

            <div className="divider" />

            <div style={S.fieldGroup}>
              <label style={S.label}>Splits</label>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 80px 80px 58px 18px', gap: 8, marginBottom: 6 }}>
                {['Interval', 'Meters', 'Pace', 'Rate', ''].map((h, i) => (
                  <div key={i} className="col-label">{h}</div>
                ))}
              </div>
              {splits.map((sp, i) => (
                <div key={i} style={{ display: 'grid', gridTemplateColumns: '1fr 80px 80px 58px 18px', gap: 8, marginBottom: 7, alignItems: 'center' }}>
                  <input style={S.input} placeholder="0–6:00" value={sp.interval} onChange={e => setSplit(i, 'interval', e.target.value)} />
                  <input style={S.input} type="number" placeholder="1397" value={sp.meters} onChange={e => setSplit(i, 'meters', e.target.value)} />
                  <input style={S.input} placeholder="2:07.8" value={sp.pace} onChange={e => setSplit(i, 'pace', e.target.value)} />
                  <input style={S.input} type="number" placeholder="22" value={sp.rate} onChange={e => setSplit(i, 'rate', e.target.value)} />
                  {splits.length > 1
                    ? <button className="x-btn" onClick={() => removeSplit(i)}>×</button>
                    : <div />}
                </div>
              ))}
              <button className="add-split-btn" onClick={addSplit}>+ Add Split</button>
            </div>

            <div style={S.fieldGroup}>
              <label style={S.label}>Notes</label>
              <textarea style={S.textarea} placeholder="How did it feel? Pacing notes…" value={form.notes} onChange={e => set('notes', e.target.value)} />
            </div>

            <div style={S.btnRow}>
              <button style={S.cancelBtn} onClick={onCancel}>Cancel</button>
              <button style={S.saveBtn} onClick={handleSave}>Save Session →</button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

// ─── Session Card ─────────────────────────────────────────────────────────────
function SessionCard({ session, onDelete }) {
  const [open, setOpen] = useState(false)
  const meta = TYPE_META[session.sessionType] || TYPE_META.FREE
  const watts = paceToWatts(session.avgPace)

  const workSplits = session.splits?.filter(s => s.pace)
  const fastestSplit = workSplits?.length > 1
    ? workSplits.reduce((best, s) => (paceToWatts(s.pace) || 0) > (paceToWatts(best.pace) || 0) ? s : best, workSplits[0])
    : null

  return (
    <div className="card-hover" style={{ ...S.card, borderColor: open ? '#3a3a4a' : '#2a2a38' }}>
      <div style={S.cardHeader} onClick={() => setOpen(o => !o)}>
        <div style={{ ...S.badge, background: meta.color + '22', color: meta.color, border: `1px solid ${meta.color}55` }}>
          {meta.label}
        </div>
        <div style={S.cardMeta}>
          <div style={S.cardLabel}>{session.label || meta.desc}</div>
          <div style={S.cardDate}>{session.date} · Week {session.week}</div>
        </div>
        <div style={S.cardStats}>
          <span style={{ color: '#e8e6f0', fontWeight: 700 }}>{session.avgPace}</span>
          <span>{session.totalMeters?.toLocaleString()}m</span>
          {watts && <span style={{ color: '#7a788a' }}>{watts}W</span>}
          {session.avgRate ? <span style={{ color: '#7a788a' }}>r{session.avgRate}</span> : null}
        </div>
        <div style={{ ...S.chevron, transform: open ? 'rotate(180deg)' : 'none' }}>▾</div>
      </div>

      {open && (
        <>
          {session.splits?.length > 0 && (
            <div style={S.splitsWrap}>
              <div style={{ ...S.splitRow, ...S.splitHdr }}>
                <span>Interval</span><span>Meters</span><span>Pace</span><span>Rate</span><span>Watts</span>
              </div>
              {session.splits.map((s, i) => {
                const isLast = i === session.splits.length - 1
                const isFastest = fastestSplit === s
                const isRest = !s.pace
                return (
                  <div key={i} style={{
                    ...S.splitRow,
                    borderBottom: isLast ? 'none' : '1px solid #1c1c25',
                    color: isRest ? '#3a3a4a' : isLast ? '#e8e6f0' : '#aba8be',
                    background: isFastest ? 'rgba(232,50,30,0.05)' : 'transparent',
                    fontStyle: isRest ? 'italic' : 'normal',
                  }}>
                    <span>{s.interval}</span>
                    <span>{s.meters?.toLocaleString()}</span>
                    <span style={{ fontWeight: 700, color: isFastest ? '#e8321e' : 'inherit' }}>{s.pace || '—'}</span>
                    <span>{s.rate || '—'}</span>
                    <span style={{ color: '#7a788a' }}>{paceToWatts(s.pace) ?? '—'}W</span>
                  </div>
                )
              })}
            </div>
          )}
          {session.notes && <div style={S.notesWrap}>"{session.notes}"</div>}
          <button style={S.delBtn} onClick={() => onDelete(session.id)}>Delete</button>
          <div style={{ clear: 'both' }} />
        </>
      )}
    </div>
  )
}

// ─── App ──────────────────────────────────────────────────────────────────────
export default function App() {
  const [sessions, setSessions] = useState(null)
  const [showForm, setShowForm] = useState(false)

  useEffect(() => {
    (async () => {
      try {
        const raw = await storage.get(STORAGE_KEY)
        const stored = raw ? JSON.parse(raw) : null
        setSessions(stored?.length ? stored : SEED_SESSIONS)
        if (!stored?.length) await storage.set(STORAGE_KEY, JSON.stringify(SEED_SESSIONS))
      } catch { setSessions(SEED_SESSIONS) }
    })()
  }, [])

  const persist = useCallback(async (updated) => {
    setSessions(updated)
    try { await storage.set(STORAGE_KEY, JSON.stringify(updated)) }
    catch (e) { console.error('Storage:', e) }
  }, [])

  const handleSave = (session) => {
    const updated = [session, ...(sessions || [])].sort((a, b) => b.date.localeCompare(a.date))
    persist(updated)
    setShowForm(false)
  }

  const handleDelete = (id) => {
    if (!confirm('Delete this session?')) return
    persist((sessions || []).filter(s => s.id !== id))
  }

  const totalMeters = (sessions || []).reduce((a, s) => a + (s.totalMeters || 0), 0)
  const weeksCompleted = sessions?.length ? Math.max(...sessions.map(s => s.week || 0)) : 0
  const latestPace = sessions?.[0]?.avgPace || '—'
  const progressPct = Math.min(100, (weeksCompleted / 12) * 100)

  if (!sessions) return (
    <div style={{ ...S.app, display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', fontFamily: 'monospace', color: '#7a788a' }}>
      Loading…
    </div>
  )

  return (
    <div style={S.app}>
      <style>{GLOBAL_CSS}</style>

      <div style={S.header}>
        <div style={S.eyebrow}>Concept2 RowErg · 12-Week PR Program</div>
        <div style={S.h1}>Session Log</div>
        <div style={S.subline}>Kyle → 6:55 · Current best: 7:35.7 · Target: 1:43.75 /500m</div>
        <div style={S.progressBar}>
          <div style={{ height: '100%', width: `${progressPct}%`, background: 'linear-gradient(90deg,#e8321e,#ff6b52)', borderRadius: 2, transition: 'width 0.6s ease' }} />
        </div>
        <div style={{ fontFamily: 'monospace', fontSize: 10, color: '#7a788a', marginTop: 6 }}>
          Week {weeksCompleted} of 12 — {Math.round(progressPct)}% complete
        </div>
      </div>

      <div style={S.main}>
        <div style={S.statsRow}>
          {[
            { label: 'Sessions Logged', value: sessions.length },
            { label: 'Total Meters',    value: totalMeters.toLocaleString() + 'm' },
            { label: 'Latest Avg Pace', value: latestPace, accent: true },
            { label: 'Week Progress',   value: `${weeksCompleted} / 12` },
          ].map((s, i) => (
            <div key={i} style={{ ...S.statCell, borderRight: i < 3 ? '1px solid #2a2a38' : 'none' }}>
              <div style={S.statLabel}>{s.label}</div>
              <div style={{ ...S.statValue, color: s.accent ? '#e8321e' : '#e8e6f0' }}>{s.value}</div>
            </div>
          ))}
        </div>

        <div style={S.sectionTitle}>
          <span>Sessions — Most Recent First</span>
          <button style={S.addBtn} onClick={() => setShowForm(true)}>+ Log Session</button>
        </div>

        {sessions.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '48px 24px', color: '#7a788a', fontFamily: 'monospace', fontSize: 13, border: '1px dashed #2a2a38', borderRadius: 8 }}>
            No sessions yet.
          </div>
        ) : sessions.map(s => (
          <SessionCard key={s.id} session={s} onDelete={handleDelete} />
        ))}
      </div>

      {showForm && <SessionForm onSave={handleSave} onCancel={() => setShowForm(false)} />}
    </div>
  )
}
