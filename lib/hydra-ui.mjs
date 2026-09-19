/**
 * Hydra Terminal UI - Shared visual components for the Hydra orchestration system.
 *
 * Provides branded ASCII art, agent-colored output, spinners, box drawing,
 * and dashboard rendering. All functions are pure (no side effects except spinners).
 *
 * Dependency: picocolors (zero-dep, auto-strips ANSI in non-TTY)
 */

import pc from 'picocolors';
import { versionString } from './hydra-version.mjs';
import { getShortName as _getShortName } from './hydra-model-profiles.mjs';

// ─── Agent Colors ───────────────────────────────────────────────────────────

// Claude Code's signature orange (truecolor: #E8863A)
const claudeOrange = (str) => `\x1b[38;2;232;134;58m${str}\x1b[39m`;

export const AGENT_COLORS = {
  gemini: pc.cyan,
  opus: pc.magenta,
  codex: pc.green,
  claude: claudeOrange,
  human: pc.yellow,
  system: pc.blue,
};

export const AGENT_ICONS = {
  gemini: '\u2726',    // ✦
  opus: '\u25C9',      // ◉
  codex: '\u058E',     // ֎
  claude: '\u274B',    // ❋
  human: '\u{1F16F}',  // 🅯
  system: '\u{1F5B3}', // 🖳
};

// ─── Status Colors ──────────────────────────────────────────────────────────

const STATUS_COLORS = {
  todo: pc.white,
  in_progress: pc.yellow,
  blocked: pc.red,
  done: pc.green,
  cancelled: pc.gray,
};

const STATUS_ICONS = {
  todo: '\u25CB',        // ○
  in_progress: '\u25D4', // ◔
  blocked: '\u2717',     // ✗
  done: '\u2713',        // ✓
  cancelled: '\u2500',   // ─
};

// ─── Semantic Colors ────────────────────────────────────────────────────────

export const ACCENT = pc.magenta;
export const DIM = pc.gray;
export const HIGHLIGHT = pc.bold;
export const ERROR = pc.red;
export const SUCCESS = pc.green;
export const WARNING = pc.yellow;

// ─── ASCII Logo (100 columns) ───────────────────────────────────────────────
const HYDRA_SPLASH_100 = [
  "                                           ▒▒░",
  "                                   ▒▒░    ░▒▓▒░     ░░░",
  "                                   ▒▓▓░░░░░▓██▒▒░░░░▒▓▒",
  "                                  ░░▓▓▓▓▓▓▓████▓█▓▓▓█▓▒▒░",
  "                                ░░░▓▓█▓█▓█▓██████▓██▓█▓▒░",
  "                                ░▒▒▓███▓▓▓█▓██▓██▓█▓▓▓█▓▒░",
  "                                ░▒▓███▓▓ ▓▓█▓█▓█▓█▓ ██▓▒",
  "                                 ░▓▓████▓▓▓▓█▓▓█▓▓▓▓▓▓█▓░",
  "                                ░▒▓█▓██▓███▓▓████▓████▓▓░",
  "                          ░░    ░▒▓▓█▓██▓████████▓█▓█▓█▓▒",
  "             ░░░       ░░▒▒▒░   ░░▒▓████▓█▓█▓▓█▓█▓█▓██▓▒░",
  "       ░▒░ ░░▓▓░░  ░ ░▒▓▓█▓░      ░▓▓█▓█▓██▓▓▓▓▓▓▓▓██▓▒░",
  "      ░▓▓░░░▓▓█░░ ░▒▓▓██▓▓░       ░██▓█▓▓▓▓▓▓█▓█▓▓▓▓▒░            ░░▒░░ ░      ░",
  "     ░▒█▓▓▒▓▓██▓▒▓▓█▓███▓░       ░░███▓▓█▓▓█▓█▓██▓▓▒░              ░░▓▓▒▒░░   ░░▒▒",
  "    ░░▓▓█▓████▓█▓████▓█▓▒░░ ░     ▒▓███▓▓▓▓▓█▓█▓▓▒▓▒                 ░▒█▓█▓▒▒ ░░▓▓▓░░",
  "   ░▒▓▓███▓█▓█▓█▓███████▓▓▒▓▒░░  ░▒█████▓▓█▒▓▓▓▓▓▓▓░                 ░░░▓██▓█▓▒░▒█▓▓▒",
  "   ░▓█▓█▓██▓█▓▓█▓██▓█████▓▓▒░     ▒██████▓▓▓▓▓▓▓▓▓▒                   ░░░▓███▓▓▓▓▓██▓▒░░░",
  "   ░▒▓▓▓█▓█▓▓ ▓██▓█▓██████▓▒░    ░▒███████▓█▓█▓▓▓▓░             ░ ░░▒▒▒▓▒▒▓█████▓█▓█▓▓▒▒▓▒░",
  "  ░▒▓▓██▓██▓▓▓▓█████▓███▓▓▓▓░░    ▒██████▓█▓█▓███▓░           ░░░░▒▓▓▓█▓██▓████████▓██▓▓█▓▒░ ░",
  "░▒▒▓██▓▓█▓██████▓█▓███████▓█▓░░  ░▒▓███████▓██▓█▓▒         ░░░░▒▓█▓█▓▓██▓█████▓███▓█▓███▓▓▓▓▓▒",
  "░▓███▓█████▓█▓▓█▓█▓█▓█▓▓▓█▓██▓▒░  ▒██████▓██████▓░       ░ ░▒▓▓▓▓███▓█▓████████▓██▓██▓▓▓████▓▓░",
  " ▓▓████▓█▓█▓███▓█▓█▓█▓█▓██████▓▒ ░░▓████▓█▓█▓▓██▓░      ░░▒▒▓▓▓▓████▓▓▓▓██████▓█▓███▓▓▒ ▓█▓█▓▓▒░",
  " ▒▓▒▓▒▒▓▓▓▓▓█▓█▓▓▓█▓█▓█▓███████▓░ ▒█████████████▓      ░░▒▓▓▓▓███████▓██▓████▓███████▓▓▓▓█▓███▓▒░░",
  "  ░  ░ ░▓█▓█▓█▓███▓▓▓███▓██████▒░░▓█████▓█▓█▓█▓▒░    ░▓▓▓▓███████████▓▓██▓████▓▓█▓███████▓█▓█▓▓█▓▒░",
  "        ░▒█▓▓█▓▓▓▓▓▒▓██▓████████▓▒░██████▓██▓███▒   ░░▒▓▓██████████████▓█▓█▓████▓█▓▓█▓▓▓█▓██████▓█▓░",
  "       ░░▒▓█▓▓▓▓█▒░ ▒▓▓█▓████████▓▒▓███████████▓▒  ░░▓▓███████████▓██▓██▓▓█▓█▓▓██▓▓█▓██▓▓▓▓▓▓█▓▓█▓▓░",
  "        ▒▓▓▓▓▓▒▓▓░   ░▓██▓█▓█████▓▒▓████▓█▓▓█▓██░░░▒▓██▓███████▓██▓█▓█▓▓▓▓▒▒▓▓█▓█▓▓██▓█▓▓░░▒▒▒▒▒▓▒░",
  "       ░▒▒▓▓▓▓▓▓░     ░▓▓█████████▒▓███████████▓▒░▒▓███████▓███▓██▓▓▓▒░░   ░ ▒▓▓██▓▓██▓▓▒      ░░░",
  "        ░▒▓▒▓▒▓░       ▒▓█████████▓▓████▓█▓▓█▓██░▒██████████▓███▓▓▒░░         ░▒▓▓▓▓▓▓█▓▓░░     ░",
  "                      ░▒███████████▓███████████▓▓████████████▓▓▒░              ░▓▓▓▒▓▓▓▓▒░░",
  "                        ▒▓░GEMINI░▒▓▓▒▒░CODEX░▒▓█▓▒░CLAUDE░▓▓▒░                 ░▒▓▓▒▓▓▓▒░",
  "                                                                                  ░▓▓▓▓▓▓▒░",
  "                                                                                   ░▒▒▓▒▓▒",
].join("\n");

export const HYDRA_SPLASH_50 = [
  "                 ░░  ░▒   ░",
  "                 ░▓▒▒▓█▓▒▒▓▒",
  "                ▒▒██▓█████▓▓░",
  "                ░▓██ ▓██▓ █▓",
  "             ░  ▒▓█████████▓░",
  "    ░ ░▒   ▒▓▒  ░▒████▓▓▓██▒",
  "   ▓▓▒▓▓▒▓▓█▓    ▓█▓▓▓██▓▓░      ░▒▒░  ░░",
  "  ▒▓████████▒▒░  ▓██▓▓▓▓▓▒        ░▒█▓▒▒▓▓░",
  " ░▓▓██ ▓█████▓░  ▓███▓▓▓▓░       ░░▒▒███▓█▓▒▒",
  "░▒███████████▓▒  ▓██████▓     ░▒▒▓▓█████████▓▒▒",
  "▒██████████▓███▒ ▓██████▒   ░░▓▓██▓▓██████▓ ██▓░",
  "░▓▒▒▓▓███▓█████▓░▓█████▓░  ▒▒██████████████████▓▒",
  "    ▒█▓▓▓▒▓█████▓▓██████░ ▒▓████████▓████▓█▓▓████▒",
  "   ▒▓▓▓▓░  ▓█████▓██████▒▓███████▓▓▒▒░▒▓█▓█▓▒░░░▒",
  "   ░░░░    ░GEMINI▓CODEX░▒CLAUDE▒░     ░▓▓▓▓▒░",
].join("\n");

// ─── Truecolor Gradient Renderer (head zones + ink shading) ─────────────────

const ESC = "\x1b[";
const ansiReset = `${ESC}0m`;
const ansiFg = (r, g, b) => `${ESC}38;2;${r};${g};${b}m`;

const clamp01 = (t) => Math.max(0, Math.min(1, t));
const lerp = (a, b, t) => Math.round(a + (b - a) * t);
const lerpRgb = (c1, c2, t) => ([
  lerp(c1[0], c2[0], t),
  lerp(c1[1], c2[1], t),
  lerp(c1[2], c2[2], t),
]);

function hexToRgb(hex) {
  const h = String(hex).replace("#", "").trim();
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  const n = parseInt(full, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

// Multi-stop gradient interpolation for richer color bands
function lerpMultiStop(stops, t) {
  const cT = clamp01(t);
  if (stops.length <= 1) return stops[0].slice();
  const segments = stops.length - 1;
  const scaled = cT * segments;
  const idx = Math.min(Math.floor(scaled), segments - 1);
  const localT = scaled - idx;
  return lerpRgb(stops[idx], stops[idx + 1], localT);
}

// 4-stop head gradients for refined color transitions
// Left (Blue/Green) => Center (Green/Yellow) => Right (Orange/Red)
const HEAD_GRAD = {
  left:   [hexToRgb("#0060FF"), hexToRgb("#00CCFF"), hexToRgb("#00FFB0"), hexToRgb("#00FF55")],
  center: [hexToRgb("#22FF44"), hexToRgb("#77FF00"), hexToRgb("#BBEE00"), hexToRgb("#FFD400")],
  right:  [hexToRgb("#FF9500"), hexToRgb("#FF5500"), hexToRgb("#FF2D1A"), hexToRgb("#EE1111")],
};

// Head centers converge as y increases (necks merge toward body)
function headCentersAtY(ny) {
  const converge = clamp01(ny * 0.8) * 0.4;
  const mid = 50;
  return {
    left:   20 + (mid - 20) * converge,
    center: 52 + (mid - 52) * converge,
    right:  82 + (mid - 82) * converge,
  };
}

// Proximity-based blending weights (Gaussian falloff from each head center)
function headWeights(x, ny) {
  const centers = headCentersAtY(ny);
  const sigma = 12 + ny * 8; // tighter at top, wider blend at bottom
  const wL = Math.exp(-0.5 * ((x - centers.left) / sigma) ** 2);
  const wC = Math.exp(-0.5 * ((x - centers.center) / sigma) ** 2);
  const wR = Math.exp(-0.5 * ((x - centers.right) / sigma) ** 2);
  const total = wL + wC + wR;
  return [wL / total, wC / total, wR / total];
}

// Gradient direction per head (returns 0-1 parameter along the gradient)
function headGradT(hk, nx, ny) {
  if (hk === 'left') {
    // Blue->Green: diagonal flow, top-left to bottom-right
    return clamp01(nx * 0.55 + ny * 0.45);
  }
  if (hk === 'center') {
    // Green->Yellow: mostly vertical, top to bottom
    return clamp01(ny * 0.75 + nx * 0.25);
  }
  // Orange->Red: diagonal from top-right toward bottom-left
  return clamp01((1 - nx) * 0.45 + ny * 0.55);
}

// Ink model: makes faces/edges read better by using glyph density.
function charInk(ch) {
  switch (ch) {
    case "█": return 1.00;
    case "▓": return 0.78;
    case "▒": return 0.52;
    case "░": return 0.30;
    default:  return 0.55;
  }
}

function mulRgb(rgb, k) {
  return [
    Math.max(0, Math.min(255, Math.round(rgb[0] * k))),
    Math.max(0, Math.min(255, Math.round(rgb[1] * k))),
    Math.max(0, Math.min(255, Math.round(rgb[2] * k))),
  ];
}

function colorHydraSplashTruecolor() {
  const isTTY = process.stdout?.isTTY;
  const canColor = Boolean(pc.isColorSupported);
  if (!isTTY || !canColor) return HYDRA_SPLASH_50;

  const lines = HYDRA_SPLASH_50.split("\n");
  const totalH = lines.length;
  const totalW = Math.max(...lines.map(l => l.length), 1);

  return lines.map((line, y) => {
    let out = "";
    const ny = clamp01(y / (totalH - 1));

    for (let x = 0; x < line.length; x++) {
      const ch = line[x];
      if (ch === " ") { out += " "; continue; }

      const nx = clamp01(x / (totalW - 1));

      // Compute gradient color for each head at this position
      const rgbL = lerpMultiStop(HEAD_GRAD.left, headGradT('left', nx, ny));
      const rgbC = lerpMultiStop(HEAD_GRAD.center, headGradT('center', nx, ny));
      const rgbR = lerpMultiStop(HEAD_GRAD.right, headGradT('right', nx, ny));

      // Blend heads based on horizontal proximity (converging with depth)
      const [wL, wC, wR] = headWeights(nx * 100, ny);
      let rgb = [
        Math.round(rgbL[0] * wL + rgbC[0] * wC + rgbR[0] * wR),
        Math.round(rgbL[1] * wL + rgbC[1] * wC + rgbR[1] * wR),
        Math.round(rgbL[2] * wL + rgbC[2] * wC + rgbR[2] * wR),
      ];

      // Ink shading: denser glyphs get brighter
      const ink = charInk(ch);
      const shade = 0.70 + ink * 0.55;
      rgb = mulRgb(rgb, shade);

      // Subtle vignette: edges slightly dimmer
      const edgeX = Math.min(nx, 1 - nx);
      const edgeY = Math.min(ny, 1 - ny);
      const edge = Math.min(edgeX, edgeY);
      const vignette = 0.88 + clamp01(edge / 0.4) * 0.18;
      rgb = mulRgb(rgb, vignette);

      // Neck desaturation: lower portions slightly more muted
      const neckDim = ny > 0.55 ? 1.0 - (ny - 0.55) * 0.35 : 1.0;
      rgb = mulRgb(rgb, neckDim);

      out += ansiFg(rgb[0], rgb[1], rgb[2]) + ch + ansiReset;
    }

    return out;
  }).join("\n");
}

// ─── Gradient Title Letters ──────────────────────────────────────────────────

function colorGradientLetters(text) {
  const isTTY = process.stdout?.isTTY;
  const canColor = Boolean(pc.isColorSupported);
  if (!isTTY || !canColor) return pc.bold(pc.magentaBright(text));

  // Collect non-space character indices so we can map them across 0→1
  const charPositions = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== " ") charPositions.push(i);
  }

  const ny = 0.5; // mid-height: heads still spread for distinct color zones

  let out = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === " ") { out += " "; continue; }

    // Spread letters evenly across the full gradient width
    const idx = charPositions.indexOf(i);
    const nx = charPositions.length > 1 ? idx / (charPositions.length - 1) : 0.5;

    const rgbL = lerpMultiStop(HEAD_GRAD.left, headGradT("left", nx, ny));
    const rgbC = lerpMultiStop(HEAD_GRAD.center, headGradT("center", nx, ny));
    const rgbR = lerpMultiStop(HEAD_GRAD.right, headGradT("right", nx, ny));

    const [wL, wC, wR] = headWeights(nx * 100, ny);
    let rgb = [
      Math.round(rgbL[0] * wL + rgbC[0] * wC + rgbR[0] * wR),
      Math.round(rgbL[1] * wL + rgbC[1] * wC + rgbR[1] * wR),
      Math.round(rgbL[2] * wL + rgbC[2] * wC + rgbR[2] * wR),
    ];

    // Boost brightness so bold letters pop against the terminal background
    rgb = mulRgb(rgb, 1.35);

    out += `${ESC}1m` + ansiFg(rgb[0], rgb[1], rgb[2]) + ch + ansiReset;
  }

  return out;
}

// ─── Splash + Compact ───────────────────────────────────────────────────────

export function hydraSplash() {
  const ver = pc.dim(`v${versionString()}`);
  return [
    "",
    colorHydraSplashTruecolor(),
    "",
    `  ${colorGradientLetters("H Y D R A")}  ${pc.gray("Hybrid Yielding Deliberation & Routing Automaton")}  ${ver}`,
    `  ${pc.dim("developed by")} ${pc.white("SillyPepper")} 🌶️`,
    "",
  ].join("\n");
}

export function hydraLogoCompact() {
  return `${pc.bold(ACCENT("HYDRA"))} ${DIM("|")} ${DIM("Hybrid Yielding Deliberation & Routing Automaton")}`;
}

// ─── Agent Formatting ───────────────────────────────────────────────────────

// Lazy resolver for virtual→physical agent lookup.
// Uses dynamic import to avoid circular dependency (hydra-agents doesn't import hydra-ui).
// The resolver is populated asynchronously; before it loads, virtual agents fall back gracefully.
let _resolverSync = null;
import('./hydra-agents.mjs').then(mod => { _resolverSync = mod.resolvePhysicalAgent; }).catch(() => {});

/**
 * Get the display color function for an agent (physical or virtual).
 * Virtual agents inherit their base physical agent's color.
 */
export function getAgentColor(name) {
  const lower = String(name || '').toLowerCase();
  if (AGENT_COLORS[lower]) return AGENT_COLORS[lower];
  // Try resolving virtual → physical
  if (_resolverSync) {
    const base = _resolverSync(lower);
    if (base && AGENT_COLORS[base.name]) return AGENT_COLORS[base.name];
  }
  return AGENT_COLORS.system || pc.white;
}

/**
 * Get the display icon for an agent (physical or virtual).
 * Virtual agents get a distinct sub-icon (◇) to differentiate from physical agents.
 */
export function getAgentIcon(name) {
  const lower = String(name || '').toLowerCase();
  if (AGENT_ICONS[lower]) return AGENT_ICONS[lower];
  // Virtual agents get a diamond outline icon
  return '\u25C7'; // ◇
}

export function colorAgent(name) {
  const lower = String(name || "").toLowerCase();
  const colorFn = getAgentColor(lower);
  return colorFn(name);
}

export function agentBadge(name) {
  const lower = String(name || "").toLowerCase();
  const icon = getAgentIcon(lower);
  const colorFn = getAgentColor(lower);
  return colorFn(`${icon} ${String(name).toUpperCase()}`);
}

// ─── Status Formatting ─────────────────────────────────────────────────────

export function colorStatus(status) {
  const lower = String(status || '').toLowerCase();
  const colorFn = STATUS_COLORS[lower] || pc.white;
  const icon = STATUS_ICONS[lower] || '\u2022';
  return colorFn(`${icon} ${status}`);
}

// ─── Task Formatting ────────────────────────────────────────────────────────

export function formatTaskLine(task) {
  if (!task) return '';
  const id = pc.bold(pc.white(task.id || '???'));
  const status = colorStatus(task.status || 'todo');
  const owner = colorAgent(task.owner || 'unassigned');
  const title = DIM(String(task.title || '').slice(0, 60));
  return `  ${id} ${status}  ${owner}  ${title}`;
}

export function formatHandoffLine(handoff) {
  if (!handoff) return '';
  const id = pc.bold(pc.white(handoff.id || '???'));
  const from = colorAgent(handoff.from || '?');
  const to = colorAgent(handoff.to || '?');
  const arrow = DIM('\u2192'); // →
  const ack = handoff.acknowledgedAt
      ? SUCCESS('\u2713 ack')
      : WARNING('pending');
  const summary = DIM(String(handoff.summary || '').slice(0, 50));
  return `  ${id} ${from} ${arrow} ${to}  ${ack}  ${summary}`;
}

// ─── Time Formatting ────────────────────────────────────────────────────────

export function relativeTime(iso) {
  if (!iso) return DIM('never');
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 0) return DIM('future');
  const secs = Math.floor(diff / 1000);
  if (secs < 10) return DIM('just now');
  if (secs < 60) return DIM(`${secs}s ago`);
  const mins = Math.floor(secs / 60);
  if (mins < 60) return DIM(`${mins}m ago`);
  const hours = Math.floor(mins / 60);
  if (hours < 24) return DIM(`${hours}h ago`);
  const days = Math.floor(hours / 24);
  return DIM(`${days}d ago`);
}

// ─── Layout Helpers ─────────────────────────────────────────────────────────

const BOX_STYLES = {
  light:   { tl: '\u250C', tr: '\u2510', bl: '\u2514', br: '\u2518', h: '\u2500', v: '\u2502' },
  heavy:   { tl: '\u250F', tr: '\u2513', bl: '\u2517', br: '\u251B', h: '\u2501', v: '\u2503' },
  rounded: { tl: '\u256D', tr: '\u256E', bl: '\u2570', br: '\u256F', h: '\u2500', v: '\u2502' },
  double:  { tl: '\u2554', tr: '\u2557', bl: '\u255A', br: '\u255D', h: '\u2550', v: '\u2551' },
};

/**
 * Draw a box around content with optional style and padding.
 * @param {string} title - Title shown in top border
 * @param {string[]} lines - Content lines
 * @param {number|object} [widthOrOpts=60] - Box width (number) or options object
 * @param {number} [widthOrOpts.width=60] - Box width
 * @param {'light'|'heavy'|'rounded'|'double'} [widthOrOpts.style='light'] - Border style
 * @param {number} [widthOrOpts.padding=0] - Internal horizontal padding (spaces)
 */
export function box(title, lines, widthOrOpts = 60) {
  let width = 60, style = 'light', padding = 0;
  if (typeof widthOrOpts === 'number') {
    width = widthOrOpts;
  } else if (typeof widthOrOpts === 'object' && widthOrOpts !== null) {
    width = widthOrOpts.width || 60;
    style = widthOrOpts.style || 'light';
    padding = widthOrOpts.padding || 0;
  }
  const s = BOX_STYLES[style] || BOX_STYLES.light;
  const padStr = ' '.repeat(padding);
  const inner = Math.max(width - 2 - padding * 2, 10);
  const totalInner = inner + padding * 2;
  const titleStr = title ? ` ${title} ` : '';
  const topPad = totalInner - titleStr.length;
  const top = `${s.tl}${titleStr}${s.h.repeat(Math.max(topPad, 0))}${s.tr}`;
  const bot = `${s.bl}${s.h.repeat(totalInner)}${s.br}`;
  const body = (lines || []).map((line) => {
    const stripped = stripAnsi(line);
    const pad = Math.max(inner - stripped.length, 0);
    return `${s.v}${padStr}${line}${' '.repeat(pad)}${padStr}${s.v}`;
  });
  if (padding > 0) {
    const blank = `${s.v}${' '.repeat(totalInner)}${s.v}`;
    return [top, blank, ...body, blank, bot].join('\n');
  }
  return [top, ...body, bot].join('\n');
}

export function sectionHeader(title, totalWidth = 60) {
  const titleText = String(title || '');
  const strippedTitle = stripAnsi(titleText);
  const titleWidth = strippedTitle.length;
  const barWidth = Math.max(totalWidth - titleWidth - 2, 4); // -2 for spaces around title
  const leftBar = Math.floor(barWidth / 2);
  const rightBar = barWidth - leftBar;
  return `\n${DIM('─'.repeat(leftBar))} ${HIGHLIGHT(title)} ${DIM('─'.repeat(rightBar))}`;
}

/**
 * Animated section header: bars expand from center outward.
 * @param {string} title - Section title
 * @param {number} [totalWidth=60] - Total width
 */
export function animatedSectionHeader(title, totalWidth = 60) {
  const isTTY = process.stdout?.isTTY;
  const titleText = String(title || '');
  const strippedTitle = stripAnsi(titleText);
  const titleWidth = strippedTitle.length;
  const barWidth = Math.max(totalWidth - titleWidth - 2, 4);
  const leftBar = Math.floor(barWidth / 2);
  const rightBar = barWidth - leftBar;

  if (!isTTY) {
    console.log(`\n${DIM('─'.repeat(leftBar))} ${HIGHLIGHT(title)} ${DIM('─'.repeat(rightBar))}`);
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    console.log(''); // blank line
    const steps = 5;
    let step = 0;

    const interval = setInterval(() => {
      if (step > steps) {
        clearInterval(interval);
        resolve();
        return;
      }

      const progress = step / steps;
      const currentLeft = Math.floor(leftBar * progress);
      const currentRight = Math.floor(rightBar * progress);
      const line = `${DIM('─'.repeat(currentLeft))} ${HIGHLIGHT(title)} ${DIM('─'.repeat(currentRight))}`;

      // Move up and redraw
      if (step > 0) {
        process.stdout.write('\x1b[1A\r\x1b[2K');
      }
      console.log(line);
      step++;
    }, 30);
  });
}

export function divider() {
  return DIM('─'.repeat(56));
}

// ─── Animations ─────────────────────────────────────────────────────────────

/**
 * Animated progress bar with shimmer effect (for in-progress operations).
 * Returns an object with update() and stop() methods.
 * @param {string} label - Label shown before the bar
 * @param {number} width - Bar width in characters
 */
export function animatedProgressBar(label, width = 30) {
  const isTTY = process.stderr?.isTTY;
  let interval = null;
  let currentPercent = 0;
  let shimmerOffset = 0;

  function render() {
    if (!isTTY) return;
    const clamped = Math.max(0, Math.min(100, currentPercent));
    const filled = Math.round((clamped / 100) * width);
    const empty = width - filled;

    let colorFn = pc.green;
    if (clamped >= 90) colorFn = pc.red;
    else if (clamped >= 80) colorFn = pc.yellow;

    // Shimmer: alternate between filled and dim for a wave effect
    const shimmerIdx = shimmerOffset % 3;
    let bar = '';
    for (let i = 0; i < filled; i++) {
      if ((i + shimmerIdx) % 3 === 0) {
        bar += pc.bold(colorFn('\u2588'));
      } else {
        bar += colorFn('\u2588');
      }
    }
    bar += pc.gray('\u2591'.repeat(empty));

    const line = `  ${label} ${bar} ${colorFn(`${clamped.toFixed(1)}%`)}`;
    process.stderr.write(`\r\x1b[2K${line}`);
    shimmerOffset++;
  }

  return {
    start() {
      if (!isTTY) {
        process.stderr.write(`  ${label} ${currentPercent.toFixed(1)}%\n`);
        return this;
      }
      interval = setInterval(render, 150);
      render();
      return this;
    },
    update(percent) {
      currentPercent = percent;
      return this;
    },
    stop() {
      if (interval) {
        clearInterval(interval);
        interval = null;
      }
      if (isTTY) {
        process.stderr.write('\r\x1b[2K');
      }
      return this;
    },
  };
}

export function label(key, value) {
  const k = DIM(`${key}:`);
  return `  ${k} ${value}`;
}

// ─── Spinner ────────────────────────────────────────────────────────────────

const SPINNER_STYLES = {
  braille: [
    '\u2801', '\u2803', '\u2807', '\u280F',
    '\u281F', '\u283F', '\u287F', '\u28FF',
    '\u28FE', '\u28FC', '\u28F8', '\u28F0',
    '\u28E0', '\u28C0', '\u2880', '\u2800'
  ],
  dots: [
    '\u2804', '\u2806', '\u2807', '\u280F',
    '\u281F', '\u283F', '\u287F', '\u28FF',
    '\u28FE', '\u28FC', '\u28F8', '\u28F0',
    '\u28E0', '\u28C0', '\u2880', '\u2800'
  ],
  moon: ['\u{1F311}', '\u{1F312}', '\u{1F313}', '\u{1F314}', '\u{1F315}', '\u{1F316}', '\u{1F317}', '\u{1F318}'],
  arrow: ['\u2190', '\u2196', '\u2191', '\u2197', '\u2192', '\u2198', '\u2193', '\u2199'],
  bounce: ['\u2801', '\u2802', '\u2804', '\u2840', '\u2880', '\u2804', '\u2802'],
  pulse: ['\u25CF', '\u25CE', '\u25CB', '\u25CE'],
  clock: ['\u{1F550}', '\u{1F551}', '\u{1F552}', '\u{1F553}', '\u{1F554}', '\u{1F555}', '\u{1F556}', '\u{1F557}', '\u{1F558}', '\u{1F559}', '\u{1F55A}', '\u{1F55B}'],
  // Solar Pulse — breathing sun, general processing
  solar: ['\u2604', '\u2609', '\u2299', '\u25C9', '\u25CF', '\u25C9', '\u2299', '\u2609'],
  // Orbital Ring — concentric patterns, council deliberation
  orbital: ['\u25CE', '\u2299', '\u2297', '\u2295', '\u25C9', '\u2295', '\u2297', '\u2299'],
  // Stellar Rotation — spinning star, research/search
  stellar: ['\u22C6', '\u2739', '\u2756', '\u26DA', '\u263C', '\u273B', '\u2736', '\u2739'],
  // Eclipse Cycle — phase morph, idle/waiting
  eclipse: ['\u25CE', '\u25C9', '\u25CF', '\u25C9', '\u25CE', '\u2299'],
};

const STYLE_INTERVALS = { solar: 100, orbital: 120, stellar: 100, eclipse: 200 };
const STYLE_COLORS = {
  solar: pc.yellow,
  orbital: pc.magenta,
  stellar: pc.yellow,
  eclipse: pc.white,
};

/**
 * Create an animated spinner with optional elapsed time and ETA display.
 * @param {string} message - Text shown next to the spinner
 * @param {object} [opts] - Options
 * @param {number} [opts.estimatedMs] - Estimated total duration in ms (shows ETA)
 * @param {keyof SPINNER_STYLES} [opts.style='braille'] - Spinner style (braille, dots, moon, arrow, bounce, pulse, clock, solar, orbital, stellar, eclipse)
 * @param {number} [opts.intervalMs] - Override frame interval (default varies by style)
 * @param {function} [opts.color] - Color function for frames (default: per-style or ACCENT)
 */
export function createSpinner(message, opts = {}) {
  const isTTY = process.stderr?.isTTY;
  let frameIdx = 0;
  let interval = null;
  let currentMsg = message;
  const startTime = Date.now();
  const estimatedMs = opts.estimatedMs || 0;
  const style = opts.style || 'braille';
  const frames = SPINNER_STYLES[style] || SPINNER_STYLES.braille;
  const intervalMs = opts.intervalMs || STYLE_INTERVALS[style] || 80;
  const colorFn = opts.color || STYLE_COLORS[style] || ACCENT;

  function timeSuffix() {
    const elapsed = Date.now() - startTime;
    const elapsedStr = formatElapsed(elapsed);
    if (estimatedMs > 0) {
      const etaStr = formatElapsed(estimatedMs);
      return DIM(` (${elapsedStr} / ~${etaStr})`);
    }
    return DIM(` (${elapsedStr})`);
  }

  function render() {
    if (!isTTY) return;
    const frame = colorFn(frames[frameIdx % frames.length]);
    const line = `${frame} ${currentMsg}${timeSuffix()}`;
    process.stderr.write(`\r\x1b[2K${line}`);
    frameIdx++;
  }

  function clearLine() {
    if (!isTTY) return;
    process.stderr.write('\r\x1b[2K');
  }

  return {
    start() {
      if (!isTTY) {
        const eta = estimatedMs > 0 ? ` (~${formatElapsed(estimatedMs)})` : '';
        process.stderr.write(`  ${DIM('\u2026')} ${currentMsg}${DIM(eta)}\n`);
        return this;
      }
      interval = setInterval(render, intervalMs);
      render();
      return this;
    },
    update(msg) {
      currentMsg = msg;
      return this;
    },
    succeed(msg) {
      clearLine();
      if (interval) clearInterval(interval);
      interval = null;
      const elapsed = formatElapsed(Date.now() - startTime);
      process.stderr.write(`  ${SUCCESS('\u2713')} ${msg || currentMsg} ${DIM(`(${elapsed})`)}\n`);
      return this;
    },
    fail(msg) {
      clearLine();
      if (interval) clearInterval(interval);
      interval = null;
      const elapsed = formatElapsed(Date.now() - startTime);
      process.stderr.write(`  ${ERROR('\u2717')} ${msg || currentMsg} ${DIM(`(${elapsed})`)}\n`);
      return this;
    },
    stop() {
      clearLine();
      if (interval) clearInterval(interval);
      interval = null;
      return this;
    },
  };
}

// ─── Dashboard ──────────────────────────────────────────────────────────────

const DASHBOARD_TIPS = [
  'Tip: Use :chat to start a conversational session with the concierge',
  'Tip: :workers start will launch all agents in headless background mode',
  'Tip: Smart mode auto-selects the best model tier for each prompt',
  'Tip: Council mode runs full multi-round deliberation across all agents',
  'Tip: Use :confirm off to skip post-dispatch confirmation prompts',
  'Tip: The status bar shows real-time agent activity and recent events',
  'Tip: Virtual sub-agents like security-reviewer provide specialized capabilities',
  'Tip: :stats shows detailed token usage and per-agent performance metrics',
  'Tip: Prefix prompts with ! to force-dispatch without concierge routing',
  'Pro tip: The daemon persists all events — replay with /events/replay?from=N',
];

function randomTip() {
  return DASHBOARD_TIPS[Math.floor(Math.random() * DASHBOARD_TIPS.length)];
}

export function renderDashboard(summary, agentNextMap, extras = {}) {
  const lines = [];
  lines.push(hydraLogoCompact());
  lines.push(divider());

  // Session
  const session = summary?.activeSession;
  if (session) {
    lines.push(sectionHeader('Session'));
    lines.push(label('Focus', pc.white(session.focus || 'not set')));
    lines.push(label('Branch', pc.white(session.branch || '?')));
    lines.push(label('Status', colorStatus(session.status || 'active')));
    lines.push(label('Updated', relativeTime(summary.updatedAt)));
  }

  // Counts
  const counts = summary?.counts || {};
  lines.push(sectionHeader('Overview'));
  lines.push(label('Open tasks', counts.tasksOpen ?? '?'));
  lines.push(label('Open blockers', counts.blockersOpen > 0 ? ERROR(String(counts.blockersOpen)) : SUCCESS('0')));
  lines.push(label('Decisions', String(counts.decisions ?? '?')));
  lines.push(label('Handoffs', String(counts.handoffs ?? '?')));
  if (extras.usage && extras.usage.level !== 'unknown') {
    lines.push(label('Token usage', progressBar(extras.usage.percent || 0, 20)));
  }

  // Agent Status
  if (agentNextMap && Object.keys(agentNextMap).length > 0) {
    lines.push(sectionHeader('Agents'));
    for (const [agent, next] of Object.entries(agentNextMap)) {
      const action = next?.action || 'unknown';
      let desc = action;
      if (action === 'continue_task') {
        desc = `working on ${pc.bold(next.task?.id || '?')}`;
      } else if (action === 'pickup_handoff') {
        desc = WARNING(`handoff ${next.handoff?.id || '?'} waiting`);
      } else if (action === 'claim_owned_task' || action === 'claim_unassigned_task') {
        desc = `can claim ${pc.bold(next.task?.id || '?')}`;
      } else if (action === 'idle') {
        desc = DIM('idle');
      } else if (action === 'resolve_blocker') {
        desc = ERROR(`blocked on ${next.task?.id || '?'}`);
      }
      const modelLabel = extras.models?.[agent]
          ? DIM(` [${extras.models[agent]}]`)
          : '';

      // Mood indicator based on success rate (if available)
      let mood = '';
      if (extras.metrics?.[agent]?.successRate !== undefined) {
        const rate = extras.metrics[agent].successRate;
        if (rate >= 90) mood = ' \u{1F60A}'; // 😊
        else if (rate >= 50) mood = ' \u{1F610}'; // 😐
        else mood = ' \u{1F61F}'; // 😟
      }

      lines.push(`  ${agentBadge(agent)}  ${desc}${modelLabel}${mood}`);
    }
  }

  // Open Tasks
  const tasks = summary?.openTasks || [];
  if (tasks.length > 0) {
    lines.push(sectionHeader('Open Tasks'));
    for (const task of tasks.slice(0, 10)) {
      lines.push(formatTaskLine(task));
    }
    if (tasks.length > 10) {
      lines.push(DIM(`  ... and ${tasks.length - 10} more`));
    }
  } else {
    // All clear! Show a congratulatory message
    const celebrations = [
      '\u2728 All tasks complete! Time for a victory lap.',
      '\u{1F389} Queue clear! The agents are ready for action.',
      '\u2713 No open tasks. Smooth sailing ahead!',
      '\u{1F680} Zero tasks in flight. Ready to launch the next mission.',
      '\u{1F3C6} Task queue conquered! What\'s next?',
    ];
    const msg = celebrations[Math.floor(Math.random() * celebrations.length)];
    lines.push('');
    lines.push(`  ${SUCCESS(msg)}`);
  }

  // Open Blockers
  const blockers = summary?.openBlockers || [];
  if (blockers.length > 0) {
    lines.push(sectionHeader('Blockers'));
    for (const b of blockers) {
      lines.push(`  ${ERROR('\u2717')} ${pc.bold(b.id)} ${colorAgent(b.owner)} ${DIM(String(b.title || '').slice(0, 50))}`);
    }
  }

  // Latest Handoff
  const handoff = summary?.latestHandoff;
  if (handoff) {
    lines.push(sectionHeader('Latest Handoff'));
    lines.push(formatHandoffLine(handoff));
  }

  // Footer tip
  lines.push('');
  lines.push(DIM(randomTip()));
  lines.push('');
  return lines.join('\n');
}

// ─── Stats Dashboard ────────────────────────────────────────────────────────

/**
 * Render a color-coded ASCII progress bar with fractional precision.
 * @param {number} percent - 0-100
 * @param {number} [width=30] - Bar width in characters
 * @param {boolean} [fractional=true] - Use fractional block characters for smoother rendering
 */
export function progressBar(percent, width = 30, fractional = true) {
  const clamped = Math.max(0, Math.min(100, percent || 0));

  let colorFn = pc.green;
  if (clamped >= 90) colorFn = pc.red;
  else if (clamped >= 80) colorFn = pc.yellow;

  if (!fractional) {
    // Original block rendering
    const filled = Math.round((clamped / 100) * width);
    const empty = width - filled;
    return colorFn('\u2588'.repeat(filled)) + pc.gray('\u2591'.repeat(empty)) + ' ' + colorFn(`${clamped.toFixed(1)}%`);
  }

  // Fractional rendering with smooth blocks
  const fractionalBlocks = [' ', '\u258F', '\u258E', '\u258D', '\u258C', '\u258B', '\u258A', '\u2589', '\u2588'];
  const exactFilled = (clamped / 100) * width;
  const fullBlocks = Math.floor(exactFilled);
  const fraction = exactFilled - fullBlocks;
  const fractionalIdx = Math.round(fraction * (fractionalBlocks.length - 1));
  const partialBlock = fractionalBlocks[fractionalIdx];
  const empty = Math.max(0, width - fullBlocks - 1);

  let bar = colorFn('\u2588'.repeat(fullBlocks));
  if (fullBlocks < width && partialBlock !== ' ') {
    bar += colorFn(partialBlock);
  }
  if (empty > 0) {
    bar += pc.gray('\u2591'.repeat(empty));
  }

  return bar + ' ' + colorFn(`${clamped.toFixed(1)}%`);
}

function fmtTokens(n) {
  if (!n || n === 0) return '0';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function fmtCost(usd) {
  if (!usd || usd === 0) return '-';
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  if (usd < 1) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(2)}`;
}

function fmtDuration(ms) {
  if (!ms || ms === 0) return '-';
  if (ms < 1000) return `${ms}ms`;
  const secs = (ms / 1000).toFixed(1);
  if (ms < 60000) return `${secs}s`;
  const mins = Math.floor(ms / 60000);
  const remSecs = Math.round((ms % 60000) / 1000);
  return `${mins}m${remSecs}s`;
}

function fmtReset(ms) {
  if (ms === null || ms === undefined) return '-';
  const clamped = Math.max(0, Number(ms) || 0);
  const totalMinutes = Math.floor(clamped / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${hours}h ${minutes}m`;
}

/**
 * Render a full stats dashboard combining metrics and usage data.
 * @param {object} metrics - From getMetricsSummary()
 * @param {object} usage - From checkUsage()
 */
export function renderStatsDashboard(metrics, usage) {
  const lines = [];
  lines.push('');
  lines.push(hydraLogoCompact());
  lines.push(DIM('\u2500'.repeat(56)));

  // Usage bar
  if (usage) {
    lines.push(sectionHeader('Token Usage'));
    lines.push(`  ${progressBar(usage.percent || 0)}`);
    const statusColors = { normal: pc.green, warning: pc.yellow, critical: pc.red, unknown: pc.gray };
    const statusFn = statusColors[usage.level] || pc.white;
    lines.push(label('Status', statusFn(String(usage.level || 'unknown').toUpperCase())));
    if (usage.todayTokens) {
      lines.push(label('Today', pc.white(fmtTokens(usage.todayTokens))));
    }
    if (usage.message) {
      lines.push(label('Note', DIM(usage.message)));
    }
    if (usage.agents && Object.keys(usage.agents).length > 0) {
      lines.push('');
      lines.push(`  ${pc.bold('Per-Agent:')}`);
      for (const agent of ['gemini', 'codex', 'claude']) {
        const row = usage.agents[agent];
        if (!row) continue;
        const colorFn = AGENT_COLORS[agent] || pc.white;
        const icon = AGENT_ICONS[agent] || '\u2022';
        const badge = colorFn(`${icon} ${agent.toUpperCase()}`);
        const rowStatusColors = { normal: pc.green, warning: pc.yellow, critical: pc.red, unknown: pc.gray };
        const rowStatusFn = rowStatusColors[row.level] || pc.white;
        const status = rowStatusFn(String(row.level || 'unknown').toUpperCase());
        if (row.budget) {
          lines.push(
              `    ${badge} ${status} ${pc.white(`${(row.percent || 0).toFixed(1)}%`)}  `
              + `${DIM('used')} ${pc.white(fmtTokens(row.used || 0))}/${pc.white(fmtTokens(row.budget || 0))}  `
              + `${DIM('left')} ${pc.white(fmtTokens(row.remaining || 0))}  `
              + `${DIM('reset')} ${pc.white(fmtReset(row.resetInMs))}`
          );
        } else {
          lines.push(
              `    ${badge} ${status} ${DIM('used')} ${pc.white(fmtTokens(row.todayTokens || 0))}  `
              + `${DIM('budget')} ${pc.white('n/a')}  ${DIM('source')} ${pc.white(row.source || 'none')}`
          );
        }
      }
    }
  }

  if (!metrics || !metrics.agents || Object.keys(metrics.agents).length === 0) {
    lines.push('');
    lines.push(`  ${DIM('No agent calls recorded yet.')}`);
    lines.push('');
    return lines.join('\n');
  }

  // Per-agent table
  lines.push(sectionHeader('Agent Performance'));
  const sep = DIM(' \u2502 ');
  const header = `  ${'Agent'.padEnd(10)}${sep}${'Calls'.padStart(6)}${sep}${'Tokens'.padStart(10)}${sep}${'Cost'.padStart(8)}${sep}${'Avg Time'.padStart(9)}${sep}${'Success'.padStart(8)}`;
  lines.push(DIM(header));
  lines.push(DIM('  ' + '\u2500'.repeat(62)));

  for (const [agent, data] of Object.entries(metrics.agents)) {
    const colorFn = AGENT_COLORS[agent] || pc.white;
    const icon = AGENT_ICONS[agent] || '\u2022';
    const agentLabel = colorFn(`${icon} ${agent.padEnd(8)}`);
    const calls = pc.white(String(data.callsToday || 0).padStart(6));
    // Prefer real session tokens when available, fall back to estimate
    const st = data.sessionTokens;
    const hasReal = st && st.totalTokens > 0;
    const tokenVal = hasReal ? st.totalTokens : (data.estimatedTokensToday || 0);
    const tokenStr = fmtTokens(tokenVal).padStart(10);
    const tokens = hasReal ? pc.white(tokenStr) : DIM(tokenStr);
    const costVal = hasReal ? st.costUsd : 0;
    const cost = costVal > 0 ? pc.white(fmtCost(costVal).padStart(8)) : DIM('-'.padStart(8));
    const avgTime = pc.white(fmtDuration(data.avgDurationMs || 0).padStart(9));
    const rate = data.successRate !== undefined
        ? (data.successRate >= 100 ? pc.green : data.successRate >= 80 ? pc.yellow : pc.red)(`${data.successRate}%`.padStart(8))
        : DIM('   -'.padStart(8));
    lines.push(`  ${agentLabel}${sep}${calls}${sep}${tokens}${sep}${cost}${sep}${avgTime}${sep}${rate}`);
  }

  // Session totals
  const su = metrics.sessionUsage;
  const hasSessionData = su && su.callCount > 0;
  lines.push(sectionHeader('Session Totals'));
  lines.push(label('Total calls', pc.white(String(metrics.totalCalls || 0))));
  if (hasSessionData) {
    lines.push(label('Input tokens', pc.white(fmtTokens(su.inputTokens))));
    lines.push(label('Output tokens', pc.white(fmtTokens(su.outputTokens))));
    lines.push(label('Total tokens', pc.white(fmtTokens(su.totalTokens))));
    if (su.cacheCreationTokens > 0 || su.cacheReadTokens > 0) {
      lines.push(label('Cache create', pc.white(fmtTokens(su.cacheCreationTokens))));
      lines.push(label('Cache read', pc.white(fmtTokens(su.cacheReadTokens))));
    }
    lines.push(label('Cost', pc.white(fmtCost(su.costUsd))));
  } else {
    lines.push(label('Est. tokens', pc.white(fmtTokens(metrics.totalTokens || 0))));
  }
  lines.push(label('Total time', pc.white(fmtDuration(metrics.totalDurationMs || 0))));
  lines.push(label('Uptime', pc.white(fmtDuration((metrics.uptimeSec || 0) * 1000))));

  lines.push('');
  return lines.join('\n');
}

// ─── Agent Header ───────────────────────────────────────────────────────────

export function agentHeader(name) {
  const lower = String(name || '').toLowerCase();
  const colorFn = AGENT_COLORS[lower] || pc.white;
  const agentConfig = {
    gemini: { tagline: 'Analyst \u00B7 Critic \u00B7 Reviewer', icon: '\u2726' },
    codex: { tagline: 'Implementer \u00B7 Builder \u00B7 Executor', icon: '\u25B6' },
    claude: { tagline: 'Architect \u00B7 Planner \u00B7 Coordinator', icon: '\u2666' },
  };
  const cfg = agentConfig[lower] || { tagline: 'Agent', icon: '\u2022' };
  const lines = [
    '',
    colorFn(`  ${cfg.icon} ${String(name).toUpperCase()}`),
    DIM(`  ${cfg.tagline}`),
    colorFn('─'.repeat(42)),
    '',
  ];
  return lines.join('\n');
}

// ─── Utility: Strip ANSI ────────────────────────────────────────────────────

export function stripAnsi(str) {
  // Removes CSI sequences like \x1b[...m (including 38;2;r;g;b)
  // eslint-disable-next-line no-control-regex
  return String(str || '').replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '');
}

// ─── Health Icons (for status bar) ──────────────────────────────────────────

export const HEALTH_ICONS = {
  idle:     pc.green('\u25CF'),    // ● green
  working:  pc.yellow('\u25CF'),   // ● yellow
  error:    pc.red('\u25CF'),      // ● red
  inactive: pc.gray('\u25CF'),     // ● gray
};

/**
 * Format elapsed milliseconds as a compact human-readable string.
 * @param {number} ms - Elapsed time in milliseconds
 * @returns {string} e.g. "2m 15s", "45s", "1h 3m"
 */
export function formatElapsed(ms) {
  if (!ms || ms < 0) return '0s';
  const totalSec = Math.floor(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const mins = Math.floor(totalSec / 60);
  const secs = totalSec % 60;
  if (mins < 60) return secs > 0 ? `${mins}m ${secs}s` : `${mins}m`;
  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;
  return remMins > 0 ? `${hours}h ${remMins}m` : `${hours}h`;
}

/**
 * Compact progress bar for the status bar token gauge with fractional precision.
 * @param {number} percent - 0-100
 * @param {number} [width=15] - Bar width in characters
 */
export function compactProgressBar(percent, width = 15) {
  const clamped = Math.max(0, Math.min(100, percent || 0));

  let colorFn = pc.green;
  if (clamped >= 90) colorFn = pc.red;
  else if (clamped >= 75) colorFn = pc.yellow;

  // Fractional rendering
  const fractionalBlocks = [' ', '\u258F', '\u258E', '\u258D', '\u258C', '\u258B', '\u258A', '\u2589', '\u2588'];
  const exactFilled = (clamped / 100) * width;
  const fullBlocks = Math.floor(exactFilled);
  const fraction = exactFilled - fullBlocks;
  const fractionalIdx = Math.round(fraction * (fractionalBlocks.length - 1));
  const partialBlock = fractionalBlocks[fractionalIdx];
  const empty = Math.max(0, width - fullBlocks - 1);

  let bar = colorFn('\u2588'.repeat(fullBlocks));
  if (fullBlocks < width && partialBlock !== ' ') {
    bar += colorFn(partialBlock);
  }
  if (empty > 0) {
    bar += pc.gray('\u2591'.repeat(empty));
  }

  return bar + ' ' + colorFn(`${clamped.toFixed(1)}%`);
}

/**
 * Convert a full model ID to a compact display name.
 * @param {string} modelId - e.g. "claude-sonnet-4-5-20250929"
 * @returns {string} - e.g. "sonnet"
 */
export function shortModelName(modelId) {
  // Try profile-derived short name first (single source of truth)
  const profileName = _getShortName(modelId);
  if (profileName) return profileName;

  // Fallback for unknown models not in profiles
  const id = String(modelId || '').toLowerCase();
  if (id.includes('opus')) return 'opus';
  if (id.includes('sonnet')) return 'sonnet';
  if (id.includes('haiku')) return 'haiku';
  if (id.includes('flash')) return 'flash';
  if (id.includes('pro')) return 'pro';
  if (id.includes('o4-mini')) return 'o4-mini';
  if (id.includes('terra')) return 'terra';
  if (id.includes('gpt-5.2-codex')) return 'gpt-5.2c';
  if (id.includes('codex-5.2') || id.includes('codex-5.3')) return 'gpt-5.2c';
  if (id.includes('gpt-5.2')) return 'gpt-5.2';
  if (id.includes('gpt-5')) return 'gpt-5';
  if (id.includes('gpt-4')) return 'gpt-4';
  return id.replace(/^claude-/, '').replace(/^gemini-/, '').replace(/-\d{8}$/, '');
}

// ─── Topic Extraction & Phase Narratives ─────────────────────────────────

const LEADING_VERBS = /^(lets?|please|can you|could you|go ahead and|try to|we should|we need to|i want to|i need to|you should)\s+/i;
const ACTION_VERBS = /^(fix|implement|refactor|add|create|build|update|change|remove|delete|rewrite|rework|debug|investigate|analyze|review|check|test|write|design|plan|migrate|convert|optimize|improve|integrate|deploy|setup|configure|install|upgrade|move|rename|replace|merge|split|extract|clean|comb through|look at|go through|work on|figure out|sort out|deal with|take care of)\s+/i;

/**
 * Extract a short topic phrase from a user prompt for status bar narratives.
 * Strips leading filler and action verbs, takes the first clause, truncates at word boundary.
 * @param {string} prompt - The user's input prompt
 * @param {number} [maxLen=30] - Maximum character length
 * @returns {string} A short topic phrase, or '' if nothing meaningful extracted
 */
export function extractTopic(prompt, maxLen = 30) {
  if (!prompt) return '';
  let text = String(prompt).trim();

  // Strip leading filler phrases
  text = text.replace(LEADING_VERBS, '');
  // Strip leading action verbs
  text = text.replace(ACTION_VERBS, '');

  // Take first clause (split on comma, semicolon, period, newline, " so that ", " because ")
  // Note: " and " is intentionally not a splitter — too aggressive for short phrases
  text = text.split(/[;.\n]|(?:\s+so\s+that\s+)|(?:\s+because\s+)/i)[0].trim();
  // Split on comma only if result would still be meaningful (>8 chars)
  const commaIdx = text.indexOf(',');
  if (commaIdx > 8) text = text.slice(0, commaIdx).trim();

  if (!text) return '';

  // Truncate at word boundary
  if (text.length > maxLen) {
    const truncated = text.slice(0, maxLen);
    const lastSpace = truncated.lastIndexOf(' ');
    text = lastSpace > maxLen * 0.4 ? truncated.slice(0, lastSpace) : truncated;
    text = text.replace(/\s+$/, '') + '\u2026';
  }

  return text;
}

const PHASE_NARRATIVES = {
  propose:   (agent, topic) => topic ? `Analyzing ${topic}` : 'Analyzing the objective',
  critique:  (agent, topic) => topic ? `Reviewing plan for ${topic}` : 'Reviewing the proposed plan',
  refine:    (_agent, _topic) => 'Incorporating feedback into plan',
  implement: (agent, topic) => topic ? `Evaluating approach for ${topic}` : 'Evaluating implementation approach',
  vote:      (_agent, _topic) => 'Casting final vote',
  summarize: (_agent, _topic) => 'Summarizing council outcome',
};

/**
 * Generate a narrative status description for a council phase.
 * @param {string} phase - Council phase name (propose, critique, refine, implement)
 * @param {string} agent - Agent name
 * @param {string} [topic] - Extracted topic from the prompt
 * @returns {string} Human-readable narrative description
 */
export function phaseNarrative(phase, agent, topic) {
  const fn = PHASE_NARRATIVES[phase];
  if (fn) return fn(agent, topic);
  // Fallback: capitalize the phase name
  return topic ? `${phase} ${topic}` : `${phase}...`;
}

export function formatAgentStatus(agent, status, action, maxWidth) {
  const lower = String(agent || '').toLowerCase();
  const icon = AGENT_ICONS[lower] || '\u2022';
  const colorFn = AGENT_COLORS[lower] || pc.white;
  const healthIcon = HEALTH_ICONS[status] || HEALTH_ICONS.inactive;
  const name = String(agent).toUpperCase();
  const actionText = String(action || status || 'Inactive');

  // Measure visible width (action may contain ANSI codes like DIM)
  const raw = `${name} ${stripAnsi(actionText)}`;
  const prefixLen = 4; // "● ✦ " — healthIcon + space + icon + space
  const availableWidth = maxWidth ? maxWidth - prefixLen : 0;
  let truncated;
  if (availableWidth > 0 && raw.length > availableWidth) {
    // Truncate the action part, keep the agent name intact
    const namePrefix = `${name} `;
    const actionMaxLen = Math.max(1, availableWidth - namePrefix.length);
    const actionStripped = stripAnsi(actionText);
    const shortAction = actionStripped.length > actionMaxLen
      ? actionStripped.slice(0, actionMaxLen - 1) + '\u2026'
      : actionStripped;
    truncated = `${namePrefix}${shortAction}`;
  } else {
    truncated = `${name} ${actionText}`;
  }

  return `${healthIcon} ${colorFn(icon)} ${colorFn(truncated)}`;
}
