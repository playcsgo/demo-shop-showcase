#!/usr/bin/env node
/**
 * Excalidraw-style elements JSON -> hand-drawn SVG (+ optional .excalidraw source).
 *
 * Fully headless: uses only roughjs's generator API (no DOM, no canvas, no Chrome).
 * Output is deterministic — the rough "seed" is derived from each element's id, so
 * re-rendering unchanged input produces a byte-identical SVG (clean git diffs).
 *
 * Usage:
 *   node render-diagram.mjs <input.json> <output.svg> [--excalidraw]
 *
 * Deps are installed on demand into DIAGRAM_DEPS_DIR (default /tmp/.diagram-deps).
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'

// ── dependency bootstrap ────────────────────────────────────────────────
const DEPS = process.env.DIAGRAM_DEPS_DIR || new URL('./.deps', import.meta.url).pathname
let rough
try {
  rough = (await import('roughjs')).default
} catch {
  if (!existsSync(join(DEPS, 'node_modules', 'roughjs'))) {
    mkdirSync(DEPS, { recursive: true })
    // write package.json directly — `npm init -y` rejects dir names npm considers
    // invalid package names (e.g. a leading dot), which the default DEPS path has
    writeFileSync(
      join(DEPS, 'package.json'),
      JSON.stringify({ name: 'diagram-deps', version: '1.0.0', private: true }),
    )
    console.error('installing roughjs (one time)...')
    execSync('npm install --silent --no-audit --no-fund roughjs', {
      cwd: DEPS,
      stdio: 'inherit',
    })
  }
  const req = createRequire(join(DEPS, 'noop.js'))
  rough = (await import(req.resolve('roughjs'))).default
}

// ── config ──────────────────────────────────────────────────────────────
const FONT =
  "'Segoe UI', 'Microsoft JhengHei', 'PingFang TC', 'Noto Sans CJK TC', system-ui, sans-serif"
const PAD = 40
const gen = rough.generator()

// ── helpers ─────────────────────────────────────────────────────────────
const esc = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

// CJK glyphs are full-width; latin averages ~0.52em. Good enough for label boxes.
const charW = (ch, fs) => (/[⺀-鿿＀-￯　-〿]/.test(ch) ? fs : fs * 0.52)
const textW = (s, fs) => [...String(s).replace(/\*\*/g, '')].reduce((a, c) => a + charW(c, fs), 0)

function seedFor(id) {
  let h = 2166136261
  for (const c of String(id)) {
    h ^= c.charCodeAt(0)
    h = Math.imul(h, 16777619) >>> 0
  }
  return (h % 2 ** 31) || 1
}

function opts(el) {
  const bg = el.backgroundColor
  return {
    seed: seedFor(el.id ?? JSON.stringify([el.x, el.y, el.type])),
    roughness: el.roughness ?? 1,
    stroke: el.strokeColor ?? '#1e1e1e',
    strokeWidth: el.strokeWidth ?? 2,
    fill: bg && bg !== 'transparent' ? bg : undefined,
    fillStyle: el.fillStyle ?? 'solid',
    strokeLineDash: el.strokeStyle === 'dashed' ? [8, 8] : undefined,
  }
}

function pathsToSvg(drawable) {
  return gen
    .toPaths(drawable)
    .map(
      (p) =>
        `<path d="${p.d}" stroke="${p.stroke}" stroke-width="${p.strokeWidth ?? 1}"` +
        ` fill="${p.fill || 'none'}"` +
        (drawable.options?.strokeLineDash ? ` stroke-dasharray="${drawable.options.strokeLineDash.join(' ')}"` : '') +
        ` stroke-linecap="round" stroke-linejoin="round"/>`,
    )
    .join('')
}

function roundedRectPath(x, y, w, h, r) {
  return (
    `M${x + r},${y} L${x + w - r},${y} Q${x + w},${y} ${x + w},${y + r}` +
    ` L${x + w},${y + h - r} Q${x + w},${y + h} ${x + w - r},${y + h}` +
    ` L${x + r},${y + h} Q${x},${y + h} ${x},${y + h - r}` +
    ` L${x},${y + r} Q${x},${y} ${x + r},${y} Z`
  )
}

function shape(el) {
  const o = opts(el)
  const { x, y, width: w, height: h } = el
  switch (el.type) {
    case 'rectangle':
      return el.roundness
        ? gen.path(roundedRectPath(x, y, w, h, Math.min(24, w / 4, h / 4)), o)
        : gen.rectangle(x, y, w, h, o)
    case 'ellipse':
      return gen.ellipse(x + w / 2, y + h / 2, w, h, o)
    case 'diamond':
      return gen.polygon(
        [
          [x + w / 2, y],
          [x + w, y + h / 2],
          [x + w / 2, y + h],
          [x, y + h / 2],
        ],
        o,
      )
    case 'line':
      return gen.linearPath(
        (el.points ?? [[0, 0], [el.width ?? 0, el.height ?? 0]]).map(([dx, dy]) => [
          x + dx,
          y + dy,
        ]),
        o,
      )
    default:
      return null
  }
}

function textSvg(lines, cx, cy, fs, color, anchor = 'middle') {
  const lh = fs * 1.25
  const top = cy - ((lines.length - 1) * lh) / 2
  return lines
    .map((ln, i) => {
      // a line wrapped in **double asterisks** renders bold (keyword/heading lines)
      const m = /^\*\*(.*)\*\*$/.exec(ln)
      const bold = m ? ' font-weight="700"' : ''
      const txt = m ? m[1] : ln
      return (
        `<text x="${cx.toFixed(1)}" y="${(top + i * lh).toFixed(1)}" font-family="${FONT}"` +
        ` font-size="${fs}" fill="${color}" text-anchor="${anchor}"${bold}` +
        ` dominant-baseline="central">${esc(txt)}</text>`
      )
    })
    .join('')
}

function arrowPoints(el) {
  return (el.points ?? [[0, 0], [el.width ?? 0, el.height ?? 0]]).map(([dx, dy]) => [
    el.x + dx,
    el.y + dy,
  ])
}

function arrowSvg(el) {
  const o = { ...opts(el), fill: undefined }
  const pts = arrowPoints(el)
  let out = pathsToSvg(gen.linearPath(pts, o))

  if ((el.endArrowhead ?? 'arrow') !== null) {
    const [x2, y2] = pts.at(-1)
    const [x1, y1] = pts.at(-2)
    const a = Math.atan2(y2 - y1, x2 - x1)
    for (const s of [-1, 1]) {
      out += pathsToSvg(
        gen.line(
          x2,
          y2,
          x2 - 16 * Math.cos(a + (s * Math.PI) / 7),
          y2 - 16 * Math.sin(a + (s * Math.PI) / 7),
          o,
        ),
      )
    }
  }

  if (el.label?.text) {
    const fs = el.label.fontSize ?? 16
    const i = Math.floor((pts.length - 1) / 2)
    const cx = (pts[i][0] + (pts[i + 1] ?? pts[i])[0]) / 2
    const cy = (pts[i][1] + (pts[i + 1] ?? pts[i])[1]) / 2
    const lines = String(el.label.text).split('\n')
    const w = Math.max(...lines.map((l) => textW(l, fs))) + 12
    const h = lines.length * fs * 1.25 + 6
    // opaque plate so the label stays readable where it crosses the line
    out +=
      `<rect x="${(cx - w / 2).toFixed(1)}" y="${(cy - h / 2).toFixed(1)}"` +
      ` width="${w.toFixed(1)}" height="${h.toFixed(1)}" fill="#ffffff" opacity="0.92" rx="4"/>`
    out += textSvg(lines, cx, cy, fs, el.strokeColor ?? '#1e1e1e')
  }
  return out
}

function bounds(els) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const el of els) {
    let pts
    if (el.type === 'arrow' || el.type === 'line') {
      pts = arrowPoints(el)
    } else if (el.type === 'text') {
      const fs = el.fontSize ?? 16
      const lines = String(el.text ?? '').split('\n')
      pts = [
        [el.x, el.y],
        [el.x + Math.max(...lines.map((l) => textW(l, fs))), el.y + lines.length * fs * 1.25],
      ]
    } else {
      pts = [
        [el.x, el.y],
        [el.x + (el.width ?? 0), el.y + (el.height ?? 0)],
      ]
    }
    for (const [px, py] of pts) {
      minX = Math.min(minX, px); minY = Math.min(minY, py)
      maxX = Math.max(maxX, px); maxY = Math.max(maxY, py)
    }
  }
  return { minX, minY, maxX, maxY }
}

const DISPLAY_ONLY = new Set(['cameraUpdate', 'delete', 'restoreCheckpoint'])

function render(elements) {
  const els = elements.filter((e) => !DISPLAY_ONLY.has(e.type))
  if (!els.length) throw new Error('no drawable elements')
  const b = bounds(els)
  const W = b.maxX - b.minX + PAD * 2
  const H = b.maxY - b.minY + PAD * 2

  const body = els
    .map((el) => {
      if (el.type === 'text') {
        const fs = el.fontSize ?? 16
        // standalone text: el.x is the LEFT edge, el.y the TOP
        return textSvg(
          String(el.text ?? '').split('\n'),
          el.x,
          el.y + fs * 0.6,
          fs,
          el.strokeColor ?? '#1e1e1e',
          'start',
        )
      }
      if (el.type === 'arrow') return arrowSvg(el)
      const d = shape(el)
      if (!d) return ''
      let out = pathsToSvg(d)
      if (el.label?.text) {
        out += textSvg(
          String(el.label.text).split('\n'),
          el.x + el.width / 2,
          el.y + el.height / 2,
          el.label.fontSize ?? 20,
          el.label.strokeColor ?? '#1e1e1e',
        )
      }
      return out
    })
    .join('\n')

  const vb = `${(b.minX - PAD).toFixed(1)} ${(b.minY - PAD).toFixed(1)} ${W.toFixed(1)} ${H.toFixed(1)}`
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W.toFixed(0)}" height="${H.toFixed(0)}" viewBox="${vb}">` +
    `<rect x="${(b.minX - PAD).toFixed(1)}" y="${(b.minY - PAD).toFixed(1)}"` +
    ` width="${W.toFixed(1)}" height="${H.toFixed(1)}" fill="#ffffff"/>\n${body}\n</svg>\n`
  )
}

/** Emit a real .excalidraw file so the diagram stays editable at excalidraw.com */
function toExcalidraw(elements) {
  const els = elements.filter((e) => !DISPLAY_ONLY.has(e.type))
  const out = []
  for (const el of els) {
    const base = {
      id: el.id,
      type: el.type,
      x: el.x,
      y: el.y,
      width: el.width ?? 0,
      height: el.height ?? 0,
      angle: 0,
      strokeColor: el.strokeColor ?? '#1e1e1e',
      backgroundColor: el.backgroundColor ?? 'transparent',
      fillStyle: el.fillStyle ?? 'solid',
      strokeWidth: el.strokeWidth ?? 2,
      strokeStyle: el.strokeStyle ?? 'solid',
      roughness: el.roughness ?? 1,
      opacity: el.opacity ?? 100,
      groupIds: [],
      roundness: el.roundness ?? null,
      seed: seedFor(el.id),
      version: 1,
      versionNonce: 1,
      isDeleted: false,
      boundElements: [],
      updated: 1,
      link: null,
      locked: false,
    }
    if (el.type === 'text') {
      out.push({
        ...base,
        text: el.text,
        fontSize: el.fontSize ?? 16,
        fontFamily: 1,
        textAlign: 'left',
        verticalAlign: 'top',
        containerId: null,
        originalText: el.text,
        lineHeight: 1.25,
        width: textW(el.text ?? '', el.fontSize ?? 16),
        height: (el.fontSize ?? 16) * 1.25,
      })
      continue
    }
    if (el.type === 'arrow' || el.type === 'line') {
      const pts = el.points ?? [[0, 0], [el.width ?? 0, el.height ?? 0]]
      out.push({
        ...base,
        width: Math.max(...pts.map((p) => p[0])) - Math.min(...pts.map((p) => p[0])),
        height: Math.max(...pts.map((p) => p[1])) - Math.min(...pts.map((p) => p[1])),
        points: pts,
        lastCommittedPoint: null,
        startBinding: null,
        endBinding: null,
        startArrowhead: el.startArrowhead ?? null,
        endArrowhead: el.endArrowhead ?? 'arrow',
      })
    } else {
      out.push(base)
    }
    if (el.label?.text) {
      out.push({
        ...base,
        id: `${el.id}__label`,
        type: 'text',
        text: el.label.text,
        originalText: el.label.text,
        fontSize: el.label.fontSize ?? 20,
        fontFamily: 1,
        textAlign: 'center',
        verticalAlign: 'middle',
        containerId: el.id,
        lineHeight: 1.25,
        strokeColor: el.label.strokeColor ?? '#1e1e1e',
        backgroundColor: 'transparent',
      })
    }
  }
  return {
    type: 'excalidraw',
    version: 2,
    source: 'yoution-ticket-diagram',
    elements: out,
    appState: { gridSize: null, viewBackgroundColor: '#ffffff' },
    files: {},
  }
}

// ── main ────────────────────────────────────────────────────────────────
const [, , inFile, outFile, ...flags] = process.argv
if (!inFile || !outFile) {
  console.error('usage: node render-diagram.mjs <input.json> <output.svg> [--excalidraw]')
  process.exit(1)
}
const elements = JSON.parse(readFileSync(inFile, 'utf8'))
if (!Array.isArray(elements)) throw new Error('input must be a JSON array of elements')

writeFileSync(outFile, render(elements))
console.log(`wrote ${outFile}  (${elements.length} elements)`)

if (flags.includes('--excalidraw')) {
  const exPath = resolve(outFile).replace(/\.svg$/, '.excalidraw')
  writeFileSync(exPath, JSON.stringify(toExcalidraw(elements), null, 2))
  console.log(`wrote ${exPath}`)
}
