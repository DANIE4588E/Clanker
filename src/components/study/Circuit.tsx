import { memo, useMemo, type ReactNode } from 'react';
import { StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import Svg, { Circle, G, Line, Path, Polyline, Rect, Text as SvgText } from 'react-native-svg';
import { useTheme } from '@/lib/theme';
import { REPLY_GUTTER } from '../Chart';
import { CardTitle, parseLoose, str, StudyCard } from './shared';

/**
 * A ```circuit block: an electrical schematic or logic-gate diagram on a grid. Two-terminal parts
 * run between two grid points, with their leads stretched to fit; gates take their input and
 * output points and draw their bodies between them.
 */

type Pt = { x: number; y: number };

const TWO_TERMINAL = [
  'resistor',
  'capacitor',
  'inductor',
  'battery',
  'source',
  'current',
  'ac',
  'diode',
  'led',
  'zener',
  'switch',
  'lamp',
  'fuse',
  'ammeter',
  'voltmeter',
  'wire',
] as const;
type TwoType = (typeof TWO_TERMINAL)[number];
const GATES = ['and', 'or', 'not', 'nand', 'nor', 'xor', 'xnor', 'buffer'] as const;
type GateType = (typeof GATES)[number];

type Element =
  | { kind: 'two'; type: TwoType; a: Pt; b: Pt; label?: string }
  | { kind: 'ground'; at: Pt }
  | { kind: 'node'; at: Pt; label?: string }
  | { kind: 'gate'; type: GateType; inputs: Pt[]; output: Pt; label?: string }
  | { kind: 'text'; at: Pt; text: string };

export type CircuitSpec = { title?: string; caption?: string; elements: Element[] };

const ALIASES: Record<string, string> = {
  r: 'resistor',
  res: 'resistor',
  c: 'capacitor',
  cap: 'capacitor',
  l: 'inductor',
  coil: 'inductor',
  cell: 'battery',
  v: 'source',
  vs: 'source',
  dc: 'source',
  voltage: 'source',
  voltagesource: 'source',
  vsource: 'source',
  i: 'current',
  currentsource: 'current',
  isource: 'current',
  acsource: 'ac',
  vac: 'ac',
  d: 'diode',
  bulb: 'lamp',
  light: 'lamp',
  gnd: 'ground',
  earth: 'ground',
  line: 'wire',
  junction: 'node',
  dot: 'node',
  label: 'text',
  inverter: 'not',
  buf: 'buffer',
  sw: 'switch',
};

const point = (v: any): Pt | null => {
  const x = Array.isArray(v) ? v[0] : v?.x;
  const y = Array.isArray(v) ? v[1] : v?.y;
  return typeof x === 'number' && typeof y === 'number' && Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
};

/** Reads a circuit block's JSON; null when it isn't a circuit this can draw. */
export function parseCircuit(json: string): CircuitSpec | null {
  const raw = parseLoose(json);
  const list = Array.isArray(raw) ? raw : Array.isArray(raw?.elements) ? raw.elements : Array.isArray(raw?.components) ? raw.components : null;
  if (!list) return null;
  const elements: Element[] = [];
  for (const e of list) {
    const name = str(e?.type ?? e?.kind).toLowerCase().replace(/[\s_-]/g, '');
    const type = ALIASES[name] ?? name;
    const label = str(e?.label ?? e?.name ?? e?.value) || undefined;
    if ((TWO_TERMINAL as readonly string[]).includes(type)) {
      // A wire may run through several points.
      const pts = Array.isArray(e?.points) ? e.points.map(point) : [point(e?.from ?? e?.a ?? e?.start), point(e?.to ?? e?.b ?? e?.end)];
      const ok = pts.filter(Boolean) as Pt[];
      if (ok.length < 2) continue;
      if (type === 'wire') {
        for (let i = 1; i < ok.length; i++) elements.push({ kind: 'two', type: 'wire', a: ok[i - 1], b: ok[i] });
      } else elements.push({ kind: 'two', type: type as TwoType, a: ok[0], b: ok[1], label });
    } else if (type === 'ground' || type === 'node') {
      const at = point(e?.at ?? e?.position ?? e?.point);
      if (at) elements.push(type === 'node' ? { kind: 'node', at, label } : { kind: 'ground', at });
    } else if ((GATES as readonly string[]).includes(type)) {
      const inputs = (Array.isArray(e?.inputs) ? e.inputs : Array.isArray(e?.in) ? e.in : []).map(point).filter(Boolean) as Pt[];
      const output = point(e?.output ?? e?.out);
      if (inputs.length && output) elements.push({ kind: 'gate', type: type as GateType, inputs, output, label: str(e?.label) || undefined });
    } else if (type === 'text') {
      const at = point(e?.at ?? e?.position);
      const text = str(e?.text ?? e?.label);
      if (at && text) elements.push({ kind: 'text', at, text });
    }
  }
  if (!elements.some((e) => e.kind !== 'text')) return null;
  return { title: str(raw?.title) || undefined, caption: str(raw?.caption) || undefined, elements };
}

// One grid unit, in drawing units.
const U = 24;
const STROKE = 1.8;
const LABEL = 11;
// Half the length each part's body takes up between its leads.
const GAP: Record<TwoType, number> = {
  resistor: 16,
  inductor: 16,
  capacitor: 4,
  battery: 5,
  source: 11,
  current: 11,
  ac: 11,
  ammeter: 11,
  voltmeter: 11,
  lamp: 11,
  diode: 8,
  led: 8,
  zener: 8,
  switch: 14,
  fuse: 13,
  wire: 0,
};
const ROUND = new Set<TwoType>(['source', 'current', 'ac', 'ammeter', 'voltmeter', 'lamp']);

/** A part's body along +x, centered on the origin; `ink` is the stroke color. */
function body(type: TwoType, g: number, ink: string): ReactNode {
  const s = { stroke: ink, strokeWidth: STROKE, fill: 'none', strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };
  switch (type) {
    case 'resistor': {
      const step = (2 * g) / 6;
      const pts = [`${-g},0`, ...Array.from({ length: 6 }, (_, i) => `${-g + step * (i + 0.5)},${i % 2 ? 6 : -6}`), `${g},0`];
      return <Polyline points={pts.join(' ')} {...s} />;
    }
    case 'inductor': {
      const w = (2 * g) / 4;
      return <Path d={`M ${-g} 0 ${Array.from({ length: 4 }, () => `a ${w / 2} ${w / 2} 0 0 1 ${w} 0`).join(' ')}`} {...s} />;
    }
    case 'capacitor':
      return (
        <>
          <Line x1={-g} y1={-11} x2={-g} y2={11} {...s} strokeWidth={STROKE + 0.6} />
          <Line x1={g} y1={-11} x2={g} y2={11} {...s} strokeWidth={STROKE + 0.6} />
        </>
      );
    case 'battery':
      return (
        <>
          <Line x1={-g} y1={-6} x2={-g} y2={6} {...s} strokeWidth={STROKE + 2} />
          <Line x1={g} y1={-12} x2={g} y2={12} {...s} />
        </>
      );
    case 'source':
      return (
        <>
          <Circle r={11} {...s} />
          <Path d="M 2 0 H 8 M 5 -3 V 3 M -8 0 H -2" {...s} strokeWidth={1.4} />
        </>
      );
    case 'current':
      return (
        <>
          <Circle r={11} {...s} />
          <Path d="M -6 0 H 6 M 2 -3.5 L 6 0 L 2 3.5" {...s} strokeWidth={1.4} />
        </>
      );
    case 'ac':
      return (
        <>
          <Circle r={11} {...s} />
          <Path d="M -6 0 Q -3 -7 0 0 T 6 0" {...s} strokeWidth={1.4} />
        </>
      );
    case 'lamp':
      return (
        <>
          <Circle r={11} {...s} />
          <Path d="M -7.8 -7.8 L 7.8 7.8 M -7.8 7.8 L 7.8 -7.8" {...s} />
        </>
      );
    case 'ammeter':
    case 'voltmeter':
      // The letter is drawn upright by the caller.
      return <Circle r={11} {...s} />;
    case 'diode':
    case 'led':
    case 'zener':
      return (
        <>
          <Path d={`M ${-g} -7 L ${-g} 7 L ${g} 0 Z`} {...s} fill={ink} />
          {type === 'zener' ? <Path d={`M ${g - 3} -9 L ${g} -7 L ${g} 7 L ${g + 3} 9`} {...s} /> : <Line x1={g} y1={-7} x2={g} y2={7} {...s} />}
          {type === 'led' && <Path d="M -1 -10 L 4 -16 M 1 -16 L 4 -16 L 4 -13 M 5 -8 L 10 -14 M 7 -14 L 10 -14 L 10 -11" {...s} strokeWidth={1.3} />}
        </>
      );
    case 'switch':
      return (
        <>
          <Circle cx={-g} r={2} {...s} fill={ink} />
          <Circle cx={g} r={2} {...s} fill={ink} />
          <Line x1={-g} y1={0} x2={g - 2} y2={-10} {...s} />
        </>
      );
    case 'fuse':
      return (
        <>
          <Rect x={-g} y={-5} width={2 * g} height={10} rx={2} {...s} />
          <Line x1={-g} y1={0} x2={g} y2={0} {...s} strokeWidth={1.2} />
        </>
      );
    default:
      return null;
  }
}

type Box = { minX: number; minY: number; maxX: number; maxY: number };
const grow = (box: Box, x: number, y: number) => {
  box.minX = Math.min(box.minX, x);
  box.minY = Math.min(box.minY, y);
  box.maxX = Math.max(box.maxX, x);
  box.maxY = Math.max(box.maxY, y);
};
// Rough width of a label character, for room around labels without measuring them.
const CHAR_W = 6.2;

/** Draws a label's lines with their first baseline at (x, y). */
function Label({ x, y, text, anchor, color, size = LABEL }: { x: number; y: number; text: string; anchor: 'start' | 'middle' | 'end'; color: string; size?: number }) {
  return (
    <>
      {text.split('\n').map((line, i) => (
        <SvgText key={i} x={x} y={y + i * (size + 3)} fontSize={size} fill={color} textAnchor={anchor}>
          {line}
        </SvgText>
      ))}
    </>
  );
}

function draw(spec: CircuitSpec, ink: string, muted: string) {
  const out: ReactNode[] = [];
  const box: Box = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  const ends = new Map<string, { x: number; y: number; n: number }>();
  const end = (p: Pt) => {
    const k = `${Math.round(p.x * 100)},${Math.round(p.y * 100)}`;
    const e = ends.get(k) ?? { x: p.x * U, y: p.y * U, n: 0 };
    e.n++;
    ends.set(k, e);
  };
  const s = { stroke: ink, strokeWidth: STROKE, fill: 'none', strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };
  const labelBox = (x: number, y: number, text: string, anchor: 'start' | 'middle' | 'end') => {
    const lines = text.split('\n');
    const w = Math.max(...lines.map((l) => l.length)) * CHAR_W;
    const x0 = anchor === 'start' ? x : anchor === 'end' ? x - w : x - w / 2;
    grow(box, x0, y - LABEL);
    grow(box, x0 + w, y + (lines.length - 1) * (LABEL + 3) + 3);
  };

  spec.elements.forEach((e, i) => {
    if (e.kind === 'two') {
      const ax = e.a.x * U;
      const ay = e.a.y * U;
      const bx = e.b.x * U;
      const by = e.b.y * U;
      const len = Math.hypot(bx - ax, by - ay);
      if (len < 1) return;
      end(e.a);
      end(e.b);
      grow(box, ax, ay);
      grow(box, bx, by);
      const ux = (bx - ax) / len;
      const uy = (by - ay) / len;
      const mx = (ax + bx) / 2;
      const my = (ay + by) / 2;
      const g = Math.min(GAP[e.type], len / 2);
      out.push(<Line key={`l${i}a`} x1={ax} y1={ay} x2={mx - ux * g} y2={my - uy * g} {...s} />);
      if (e.type !== 'wire') {
        out.push(<Line key={`l${i}b`} x1={mx + ux * g} y1={my + uy * g} x2={bx} y2={by} {...s} />);
        const deg = (Math.atan2(by - ay, bx - ax) * 180) / Math.PI;
        out.push(
          <G key={`b${i}`} transform={`translate(${mx} ${my}) rotate(${deg})`}>
            {body(e.type, g, ink)}
          </G>
        );
        if (e.type === 'ammeter' || e.type === 'voltmeter') {
          out.push(
            <SvgText key={`m${i}`} x={mx} y={my + 4.5} fontSize={13} fontWeight="700" fill={ink} textAnchor="middle">
              {e.type === 'ammeter' ? 'A' : 'V'}
            </SvgText>
          );
        }
        const reach = ROUND.has(e.type) ? 13 : 14;
        grow(box, mx - reach, my - reach);
        grow(box, mx + reach, my + reach);
      } else {
        out.push(<Line key={`l${i}b`} x1={mx} y1={my} x2={bx} y2={by} {...s} />);
      }
      if (e.label) {
        // Above a horizontal part, to the right of a vertical one.
        const horizontal = Math.abs(bx - ax) >= Math.abs(by - ay);
        const x = horizontal ? mx : mx + 17;
        const y = horizontal ? my - 17 : my + 4 - ((e.label.split('\n').length - 1) * (LABEL + 3)) / 2;
        const anchor = horizontal ? 'middle' : 'start';
        out.push(<Label key={`t${i}`} x={x} y={y} text={e.label} anchor={anchor} color={muted} />);
        labelBox(x, y, e.label, anchor);
      }
    } else if (e.kind === 'ground') {
      const x = e.at.x * U;
      const y = e.at.y * U;
      end(e.at);
      out.push(<Path key={`g${i}`} d={`M ${x} ${y} V ${y + 7} M ${x - 10} ${y + 7} H ${x + 10} M ${x - 6} ${y + 11} H ${x + 6} M ${x - 2} ${y + 15} H ${x + 2}`} {...s} />);
      grow(box, x - 12, y);
      grow(box, x + 12, y + 17);
    } else if (e.kind === 'node') {
      const x = e.at.x * U;
      const y = e.at.y * U;
      // Named nodes always get their dot; other ends get one where three or more meet.
      out.push(<Circle key={`n${i}`} cx={x} cy={y} r={3.2} fill={ink} />);
      grow(box, x - 4, y - 4);
      grow(box, x + 4, y + 4);
      if (e.label) {
        out.push(<Label key={`t${i}`} x={x + 6} y={y - 7} text={e.label} anchor="start" color={ink} />);
        labelBox(x + 6, y - 7, e.label, 'start');
      }
    } else if (e.kind === 'gate') {
      const ins = e.inputs.map((p) => ({ x: p.x * U, y: p.y * U }));
      const ox = e.output.x * U;
      const oy = e.output.y * U;
      e.inputs.forEach(end);
      end(e.output);
      const single = e.type === 'not' || e.type === 'buffer';
      const negated = e.type === 'not' || e.type === 'nand' || e.type === 'nor' || e.type === 'xnor';
      const minY = Math.min(...ins.map((p) => p.y));
      const maxY = Math.max(...ins.map((p) => p.y));
      const cy = ins.length > 1 ? (minY + maxY) / 2 : oy;
      const h = Math.max(single ? 1.4 * U : 2 * U, maxY - minY + U);
      const W = single ? 1.4 * U : 2 * U;
      const r = negated ? 4 : 0;
      const xorShift = e.type === 'xor' || e.type === 'xnor' ? 6 : 0;
      // The body ends half a unit before the output; the input leads stretch to reach it.
      const xr = ox - U / 2;
      const x0 = xr - 2 * r - W;
      const y0 = cy - h / 2;
      const y1 = cy + h / 2;
      const back = (y: number, shift = 0) => {
        if (e.type === 'or' || e.type === 'nor' || e.type === 'xor' || e.type === 'xnor') {
          const t = Math.min(1, Math.max(0, (y - y0) / h));
          return x0 - shift + 0.5 * W * t * (1 - t);
        }
        return x0 - shift;
      };
      let d: string;
      if (e.type === 'and' || e.type === 'nand') d = `M ${x0} ${y0} H ${x0 + W / 2} A ${W / 2} ${h / 2} 0 0 1 ${x0 + W / 2} ${y1} H ${x0} Z`;
      else if (single) d = `M ${x0} ${y0} L ${x0 + W} ${cy} L ${x0} ${y1} Z`;
      else d = `M ${x0} ${y0} Q ${x0 + W * 0.55} ${y0} ${x0 + W} ${cy} Q ${x0 + W * 0.55} ${y1} ${x0} ${y1} Q ${x0 + W * 0.25} ${cy} ${x0} ${y0} Z`;
      out.push(<Path key={`gb${i}`} d={d} {...s} />);
      if (xorShift) out.push(<Path key={`gx${i}`} d={`M ${x0 - xorShift} ${y0} Q ${x0 - xorShift + W * 0.25} ${cy} ${x0 - xorShift} ${y1}`} {...s} />);
      if (negated) out.push(<Circle key={`gn${i}`} cx={x0 + W + r} cy={cy} r={r} {...s} />);
      ins.forEach((p, j) => out.push(<Line key={`gi${i}-${j}`} x1={p.x} y1={p.y} x2={back(p.y, xorShift)} y2={p.y} {...s} />));
      out.push(
        <Path key={`go${i}`} d={oy === cy ? `M ${xr} ${cy} H ${ox}` : `M ${xr} ${cy} H ${(xr + ox) / 2} V ${oy} H ${ox}`} {...s} />
      );
      ins.forEach((p) => grow(box, p.x, p.y));
      grow(box, x0 - xorShift, y0);
      grow(box, ox, y1);
      grow(box, ox, oy);
      if (e.label) {
        out.push(<Label key={`t${i}`} x={x0 + W / 2} y={y0 - 6} text={e.label} anchor="middle" color={muted} />);
        labelBox(x0 + W / 2, y0 - 6, e.label, 'middle');
      }
    } else {
      const x = e.at.x * U;
      const y = e.at.y * U;
      out.push(<Label key={`t${i}`} x={x} y={y + 4} text={e.text} anchor="middle" color={ink} size={12} />);
      labelBox(x, y + 4, e.text, 'middle');
    }
  });

  // Junction dots where three or more ends meet.
  for (const [k, p] of ends) if (p.n >= 3) out.push(<Circle key={`j${k}`} cx={p.x} cy={p.y} r={3.2} fill={ink} />);

  const pad = 10;
  return {
    nodes: out,
    x: box.minX - pad,
    y: box.minY - pad,
    width: box.maxX - box.minX + 2 * pad,
    height: box.maxY - box.minY + 2 * pad,
  };
}

function CircuitInner({ source }: { source: string }) {
  const { colors } = useTheme();
  const { width } = useWindowDimensions();
  const spec = useMemo(() => parseCircuit(source), [source]);
  const drawing = useMemo(() => (spec ? draw(spec, colors.text, colors.textSecondary) : null), [spec, colors.text, colors.textSecondary]);
  if (!spec || !drawing || !Number.isFinite(drawing.width)) return null;
  // Fit the card's width; small circuits grow a little, but not past where lines turn chunky.
  const avail = width - REPLY_GUTTER - 34;
  const scale = Math.min(1.6, avail / drawing.width);
  return (
    <StudyCard>
      {spec.title && <CardTitle>{spec.title}</CardTitle>}
      <View style={styles.center}>
        <Svg
          width={drawing.width * scale}
          height={drawing.height * scale}
          viewBox={`${drawing.x} ${drawing.y} ${drawing.width} ${drawing.height}`}
          accessibilityLabel={spec.title ? `Circuit: ${spec.title}` : 'Circuit diagram'}
        >
          {drawing.nodes}
        </Svg>
      </View>
      {spec.caption && <Text style={[styles.caption, { color: colors.textTertiary }]}>{spec.caption}</Text>}
    </StudyCard>
  );
}

/** An electrical schematic or logic-gate diagram. */
export const Circuit = memo(CircuitInner);

const styles = StyleSheet.create({
  center: { alignItems: 'center', paddingVertical: 6 },
  caption: { fontSize: 13, marginTop: 8 },
});
